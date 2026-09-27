import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { directGit } from "./direct-sync.js";

export interface DirectSyncApplyInput {
  readonly repository: string;
  readonly store: string;
  readonly branch: string;
  readonly oid: string;
  readonly intentPath: string;
  readonly signal?: AbortSignal;
}
export type DirectSyncApplyResult =
  | { status: "up-to-date" | "fast-forwarded" | "local-ahead"; head: string; oid: string }
  | { status: "blocked-dirty" | "blocked-diverged" | "blocked-branch" | "needs-recovery"; reason: string };

type Identity = { repository: string; repositoryId: string; gitDir: string; gitDirId: string; commonDir: string };
type Intent = Identity & { version: 1; store: string; branch: string; head: string; target: string };
const OID = /^[0-9a-f]{40}$/;
const markerText = "git-sync direct committed history store v1\n";
const gitFor = (signal?: AbortSignal) => (cwd: string, args: readonly string[]) =>
  directGit(cwd, args, { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
const recovery = (reason: string): DirectSyncApplyResult => ({ status: "needs-recovery", reason });
const message = (error: unknown) => error instanceof Error ? error.message : "Git apply failed";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const exitOne = (error: unknown) => message(error) === "Direct sync Git failed (1)";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return !rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
async function privateDirectory(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw new Error("Unsafe app directory");
}
async function privateText(path: string): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o600 || st.size > 16_384) throw new Error("Unsafe app file");
    return await fd.readFile("utf8");
  } finally { await fd.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function identity(repository: string, signal?: AbortSignal): Promise<Identity> {
  const git = gitFor(signal);
  if (await realpath(repository) !== repository ||
    (await git(repository, ["rev-parse", "--is-bare-repository"])).trim() !== "false" ||
    (await git(repository, ["rev-parse", "--show-toplevel"])).trim() !== repository ||
    (await git(repository, ["rev-parse", "--show-object-format"])).trim() !== "sha1")
    throw new Error("Repository must be the exact canonical SHA-1 worktree root");
  const gitDir = await realpath((await git(repository, ["rev-parse", "--absolute-git-dir"])).trim());
  const commonDir = await realpath(resolve(repository, (await git(repository, ["rev-parse", "--git-common-dir"])).trim()));
  const id = async (path: string) => { const st = await lstat(path); return `${st.dev}:${st.ino}`; };
  return { repository, repositoryId: await id(repository), gitDir, gitDirId: await id(gitDir), commonDir };
}
async function verifyStore(input: DirectSyncApplyInput): Promise<void> {
  const git = gitFor(input.signal);
  await privateDirectory(dirname(input.store));
  await privateDirectory(input.store);
  if (await privateText(join(input.store, "direct-sync-store-v1")) !== markerText ||
    (await git(input.store, ["rev-parse", "--is-bare-repository"])).trim() !== "true" ||
    await realpath((await git(input.store, ["rev-parse", "--absolute-git-dir"])).trim()) !== input.store ||
    (await git(input.store, ["rev-parse", "--show-object-format"])).trim() !== "sha1")
    throw new Error("Store is not the received app bare repository");
  const ref = `refs/received/${createHash("sha256").update(input.branch).digest("hex")}/${input.oid}`;
  if ((await git(input.store, ["rev-parse", "--verify", ref])).trim() !== input.oid ||
    (await git(input.store, ["cat-file", "-t", input.oid])).trim() !== "commit")
    throw new Error("Store target/branch differs from received identity");
  if ((await git(input.store, ["rev-parse", "--is-shallow-repository"])).trim() !== "false" ||
    await exists(join(input.store, "info/grafts"))) throw new Error("Unsupported store history overlay");
}
async function branchHead(input: DirectSyncApplyInput): Promise<{ branch: string; head: string }> {
  const git = gitFor(input.signal);
  let branch: string;
  try { branch = (await git(input.repository, ["symbolic-ref", "--quiet", "HEAD"])).trim(); }
  catch (error) { if (!exitOne(error)) throw error; branch = ""; }
  const head = (await git(input.repository, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!OID.test(head)) throw new Error("Missing SHA-1 HEAD");
  return { branch, head };
}

/** Read-only gates. Run before importing objects and again immediately before
 * merge. Config is checked BEFORE status: even status can run a clean filter. */
async function gate(input: DirectSyncApplyInput, id: Identity, targetPresent: boolean): Promise<DirectSyncApplyResult | null> {
  const git = gitFor(input.signal);
  if ((await branchHead(input)).branch !== `refs/heads/${input.branch}`)
    return { status: "blocked-branch", reason: "HEAD is detached or on another branch" };
  for (const file of ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD",
    "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG"]) {
    if (await exists(join(id.gitDir, file))) return recovery(`Existing Git operation: ${file}`);
  }
  for (const file of [`refs/heads/${input.branch}.lock`, "packed-refs.lock", "info/grafts"]) {
    if (await exists(join(id.commonDir, file))) return recovery(`Existing Git state: ${file}`);
  }
  const config = (await git(input.repository, ["config", "--null", "--list"])).split("\0");
  for (const entry of config) {
    const split = entry.indexOf("\n");
    const key = (split < 0 ? entry : entry.slice(0, split)).toLowerCase();
    const value = split < 0 ? "" : entry.slice(split + 1).toLowerCase();
    if (key.startsWith("filter.") || key.startsWith("submodule.") || /^branch\..*\.mergeoptions$/.test(key) ||
      (["core.sparsecheckout", "core.sparsecheckoutcone", "index.sparse", "core.ignorestat"].includes(key) &&
        !["false", "0", "no", "off"].includes(value))) return recovery(`Unsupported checkout configuration: ${key}`);
  }
  if ((await git(input.repository, ["rev-parse", "--is-shallow-repository"])).trim() !== "false")
    return recovery("Shallow history is unsupported");
  const flags = (await git(input.repository, ["ls-files", "-v", "-z"])).split("\0");
  if (flags.some(row => /^[a-zS] /.test(row))) return recovery("skip-worktree/assume-unchanged index entries are unsupported");
  if ((await git(input.repository, ["ls-files", "--stage", "-z"])).split("\0").some(row => row.startsWith("160000 ")))
    return recovery("Submodules are unsupported");
  for (const tree of targetPresent ? ["HEAD", input.oid] : ["HEAD"]) {
    if ((await git(input.repository, ["ls-tree", "-r", "-z", tree])).split("\0").some(row => row.startsWith("160000 ")))
      return recovery("Submodules are unsupported");
  }
  if (await git(input.repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]))
    return { status: "blocked-dirty", reason: "Tracked, staged, or untracked changes" };
  if (targetPresent) {
    // Non-colliding ignored build output is allowed. Git's no-overwrite-ignore
    // remains the final guard, including filesystem-specific case collisions.
    // Inspect only target additions and their parents. Enumerating every ignored
    // file (e.g. node_modules) can exceed the output bound for an otherwise clean
    // checkout. Existing untracked paths that a target would replace block here;
    // unrelated ignored build output does not need enumeration.
    const tracked = new Set((await git(input.repository, ["ls-files", "-z"])).split("\0").filter(Boolean));
    const target = new Set((await git(input.repository, ["ls-tree", "-r", "--name-only", "-z", input.oid])).split("\0").filter(Boolean));
    const parents = (path: string) => {
      const result: string[] = [];
      for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) result.push(path.slice(0, slash));
      return result;
    };
    for (const path of new Set([...target, ...[...target].flatMap(parents)])) {
      if (tracked.has(path)) continue;
      try {
        const entry = await lstat(join(input.repository, path));
        if (target.has(path) || !entry.isDirectory())
          return { status: "blocked-dirty", reason: "Ignored file collides with target checkout" };
      } catch (error) {
        if (!missing(error) && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      }
    }
  }
  return null;
}
async function ancestor(repository: string, older: string, newer: string, signal?: AbortSignal): Promise<boolean> {
  const git = gitFor(signal);
  try { await git(repository, ["merge-base", "--is-ancestor", older, newer]); return true; }
  catch (error) { if (exitOne(error)) return false; throw error; }
}

/** Caller supplies/serializes the trusted repository-to-store mapping and a
 * private app intent filename OUTSIDE Git/worktree storage. The receive format
 * does not record source identity: we verify its immutable branch+OID receipt,
 * not remote provenance. Invalid inputs throw; uncertain runtime state blocks.
 *
 * Only an ordinary Git fast-forward may update the active index/worktree. No
 * stash/reset/clean/rollback or lock deletion. Object import never updates refs
 * or FETCH_HEAD. Existing intents are ALWAYS inspected read-only, even if HEAD
 * still equals their starting point; explicit operator reconciliation is needed
 * to retire them. Same-process success alone removes its own durable intent.
 *
 * This is not atomic exclusion of concurrent editors/Git/config writers. Repeated
 * gates and Git's collision checks reduce, but cannot eliminate, those races.
 * Git merge itself may partially update files before an I/O failure or signal
 * cancellation; keep intent. Cancellation never triggers cleanup or rollback.
 */
export async function applyReceivedFastForward(input: DirectSyncApplyInput): Promise<DirectSyncApplyResult> {
  if (input.signal?.aborted) return recovery("Direct sync cancelled");
  const git = gitFor(input.signal);
  for (const path of [input.repository, input.store, input.intentPath]) {
    if (!isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path)) throw new Error("Invalid apply path");
  }
  if (!OID.test(input.oid) || !input.branch || input.branch.startsWith("-") || /[\r\n\0]/.test(input.branch))
    throw new Error("Invalid apply target");
  await git("/", ["check-ref-format", `refs/heads/${input.branch}`]);
  await privateDirectory(dirname(input.intentPath));
  const pending = await exists(input.intentPath);
  let id: Identity;
  try { id = await identity(input.repository, input.signal); }
  catch (error) { if (pending) return recovery(`Intent retained: ${message(error)}`); throw error; }
  for (const path of [id.repository, id.gitDir, id.commonDir]) {
    if (inside(input.store, path) || inside(path, input.store) || inside(input.intentPath, path))
      throw new Error("Store/worktree/app path mismatch");
  }
  if (inside(input.intentPath, input.store)) throw new Error("Intent must be outside store");

  // Do this before store validation/import: a retry never executes a second
  // merge or even fetch, and a missing store cannot erase interruption evidence.
  if (pending) {
    try {
      const saved = JSON.parse(await privateText(input.intentPath)) as Intent;
      if (saved.version !== 1 || saved.store !== input.store || saved.branch !== input.branch || saved.target !== input.oid ||
        !OID.test(saved.head) || Object.entries(id).some(([key, value]) => saved[key as keyof Identity] !== value))
        return recovery("Existing intent identity differs; retained for explicit recovery");
      const current = await branchHead(input);
      if (current.branch !== `refs/heads/${saved.branch}` || current.head !== saved.target)
        return recovery("Intent has no exact completed branch/target observation; retained");
      const blocked = await gate(input, id, true);
      if (blocked) return recovery(`Intent retained: ${"reason" in blocked ? blocked.reason : blocked.status}`);
      return { status: "up-to-date", head: current.head, oid: saved.target };
    } catch (error) { return recovery(`Intent retained: ${message(error)}`); }
  }
  await verifyStore(input);
  try {
    const initial = await branchHead(input);
    const blocked = await gate(input, id, false);
    if (blocked) return blocked;
    // An exact OID refspec without a destination writes only fetched objects.
    await git(input.repository, ["-c", "fetch.fsckObjects=true", "-c", "fetch.writeCommitGraph=false", "fetch", "--quiet", "--no-tags",
      "--no-prune", "--no-prune-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance",
      "--refmap=", input.store, input.oid]);
    if ((await git(input.repository, ["cat-file", "-t", input.oid])).trim() !== "commit")
      return recovery("Imported target is not a commit");
    if (initial.head === input.oid) return { status: "up-to-date", head: initial.head, oid: input.oid };
    if (await ancestor(input.repository, input.oid, initial.head, input.signal))
      return { status: "local-ahead", head: initial.head, oid: input.oid };
    if (!await ancestor(input.repository, initial.head, input.oid, input.signal))
      return { status: "blocked-diverged", reason: "Target is not a descendant of local HEAD" };
    const preflight = await gate(input, id, true);
    if (preflight) return preflight;
    const intent: Intent = { version: 1, ...id, store: input.store, branch: input.branch, head: initial.head, target: input.oid };
    // Exclusive creation is also a guard against another apply using this intent.
    // A partial write/fsync failure leaves evidence, never an automatic retry.
    input.signal?.throwIfAborted();
    const fd = await open(input.intentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let intentInode: number;
    try { await fd.writeFile(`${JSON.stringify(intent)}\n`); await fd.sync(); intentInode = (await fd.stat()).ino; }
    finally { await fd.close(); }
    await syncDirectory(dirname(input.intentPath));
    const again = await gate(input, id, true);
    if (again) return recovery(`Intent retained after last gate: ${"reason" in again ? again.reason : again.status}`);
    const current = await branchHead(input);
    if (current.branch !== `refs/heads/${input.branch}` || current.head !== initial.head ||
      JSON.stringify(await identity(input.repository, input.signal)) !== JSON.stringify(id))
      return recovery("Repository/HEAD changed before merge; intent retained");
    await git(input.repository, ["-c", "merge.autostash=false", "-c", "submodule.recurse=false",
      "merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", "--no-verify-signatures", input.oid]);
    const after = await branchHead(input);
    if (after.branch !== `refs/heads/${input.branch}` || after.head !== input.oid || await gate(input, id, true))
      return recovery("Merge completion not clean at exact target/branch; intent retained");
    if ((await lstat(input.intentPath)).ino !== intentInode || await privateText(input.intentPath) !== `${JSON.stringify(intent)}\n`)
      return recovery("Intent changed during merge; retained");
    input.signal?.throwIfAborted();
    await unlink(input.intentPath);
    // Completion was verified. Failure to persist cleanup can only resurrect
    // this completed intent after a crash, which the read-only retry handles.
    try { await syncDirectory(dirname(input.intentPath)); } catch { /* safe retained evidence after crash */ }
    return { status: "fast-forwarded", head: after.head, oid: input.oid };
  } catch (error) { return recovery(message(error)); }
}
