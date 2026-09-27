import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Standard-Git committed-history transfer. Never writes the source, checks out
 * files, invokes project checks, pushes, or uses the legacy publication journals.
 * Sources are the user's explicitly configured trusted repositories, not hostile
 * uploads. A wall/output bound is NOT a hard disk/RAM quota. */
export interface DirectSyncInput {
  readonly store: string;
  readonly source: string;
  readonly branch: string;
  readonly sshCommand?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface DirectSyncResult {
  readonly branch: string;
  readonly oid: string;
  readonly receivedRef: string;
  readonly changed: boolean;
  readonly completedAt: string;
  readonly worktreeUpdated: false;
}
const GIT = "/usr/bin/git";
const OID = /^[0-9a-f]{40}$/;

export async function directGit(cwd: string, args: readonly string[], options: {
  sshCommand?: string; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error("Direct sync cancelled");
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new Error("Invalid Git deadline");
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
    ...(options.sshCommand ? { GIT_SSH_COMMAND: options.sshCommand, GIT_SSH_VARIANT: "ssh" } : {}),
  };
  return new Promise((accept, reject) => {
    const child = spawn(GIT, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "protocol.allow=never",
      "-c", `protocol.${options.sshCommand ? "ssh" : "file"}.allow=always`, ...args],
    { env, cwd: "/", detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let finished = false, size = 0;
    let failure: Error | undefined;
    const stdout: Buffer[] = [];
    const abort = (error: Error) => {
      if (finished || failure) return;
      failure = error;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
      child.kill("SIGKILL");
      // Keep serialized ownership until close: a killed writer may still hold
      // a Git lock. Never let the next attempt race process teardown.
    };
    const cancel = () => abort(new Error("Direct sync cancelled"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => abort(new Error("Direct sync Git deadline exceeded")), timeout);
    for (const [stream, collect] of [[child.stdout, true], [child.stderr, false]] as const) {
      stream.on("data", (bytes: Buffer) => {
        if (finished) return;
        size += bytes.length;
        if (size > 1024 * 1024) abort(new Error("Direct sync Git output limit exceeded"));
        else if (collect) stdout.push(bytes);
      });
    }
    child.on("error", () => { failure ??= new Error("Direct sync Git could not start"); });
    child.on("close", code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Direct sync Git failed (${code})`));
      else accept(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function privateDirectory(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw new Error("Unsafe direct sync directory");
}

/** The caller selects a dedicated app-owned store and serializes its use. Every
 * received tip gets an immutable ref, so a source reset never loses an old tip.
 * Fetch may be repeated after interruption: it has no remote mutation or UUID. */
export async function receiveCommittedBranch(input: DirectSyncInput): Promise<DirectSyncResult> {
  if (resolve(input.store) !== input.store || !input.branch || input.branch.startsWith("-") ||
    !input.source || input.source.startsWith("-") || /[\r\n\0]/.test(input.source)) throw new Error("Invalid direct sync input");
  await privateDirectory(resolve(input.store, ".."));
  await directGit("/", ["check-ref-format", `refs/heads/${input.branch}`], input);
  try { await mkdir(input.store, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await privateDirectory(input.store);
  // Do not reinterpret an existing worktree as an app store. Failed initial init
  // can be resumed, but an arbitrary existing directory cannot be adopted.
  const marker = join(input.store, "direct-sync-store-v1");
  const { open, readdir } = await import("node:fs/promises");
  const expected = "git-sync direct committed history store v1\n";
  let markerExists = false;
  try {
    const st = await lstat(marker);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      st.size !== Buffer.byteLength(expected) || (st.mode & 0o777) !== 0o600 || await readFile(marker, "utf8") !== expected)
      throw new Error("Invalid direct sync store marker");
    markerExists = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!markerExists) {
    if ((await readdir(input.store)).length !== 0) throw new Error("Refuse to adopt existing repository");
    const fd = await open(marker, "wx", 0o600);
    try { await fd.writeFile(expected); await fd.sync(); } finally { await fd.close(); }
  }
  let configExists = true;
  try { await lstat(join(input.store, "config")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; configExists = false; }
  if (!configExists) await directGit(input.store, ["init", "--bare", "--template=", "--object-format=sha1", "."], input);
  if ((await directGit(input.store, ["rev-parse", "--is-bare-repository"], input)).trim() !== "true" ||
    (await directGit(input.store, ["rev-parse", "--show-object-format"], input)).trim() !== "sha1")
    throw new Error("Direct sync store must be bare SHA-1");
  const ref = `refs/heads/${input.branch}`;
  const listing = (await directGit(input.store, ["ls-remote", "--refs", input.source, ref], input)).trim();
  const rows = listing ? listing.split("\n") : [];
  if (rows.length !== 1) throw new Error("Source branch missing or ambiguous");
  const [oid, remoteRef] = rows[0]!.split("\t");
  if (!oid || !OID.test(oid) || remoteRef !== ref) throw new Error("Source branch identity mismatch");
  const branchKey = createHash("sha256").update(input.branch).digest("hex");
  const receivedRef = `refs/received/${branchKey}/${oid}`;
  const existing = (await directGit(input.store, ["for-each-ref", "--format=%(refname) %(objectname)", receivedRef], input)).trim();
  if (existing && existing !== `${receivedRef} ${oid}`) throw new Error("Received ref differs from its immutable identity");
  if (!existing) {
    // Fetch the observed OID, not a branch that may move during transfer. No
    // FETCH_HEAD or remote-tracking ref update; publish the local ref only once
    // object verification succeeds. Source history is left entirely unchanged.
    await directGit(input.store, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags",
      "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", input.source, oid], input);
  }
  if ((await directGit(input.store, ["cat-file", "-t", oid], input)).trim() !== "commit") throw new Error("Source tip is not a commit");
  if (!existing) {
    let locked = false;
    try { await lstat(join(input.store, `${receivedRef}.lock`)); locked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (locked) throw new Error("Interrupted received-ref publication: preserve exact lock for explicit recovery");
    await directGit(input.store, ["update-ref", receivedRef, oid, "0".repeat(40)], input);
  }
  if ((await directGit(input.store, ["rev-parse", "--verify", receivedRef], input)).trim() !== oid) throw new Error("Received tip readback failed");
  return { branch: input.branch, oid, receivedRef, changed: !existing,
    completedAt: new Date().toISOString(), worktreeUpdated: false };
}
