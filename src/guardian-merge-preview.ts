import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface GuardianMergePreviewInput {
  repository: string; receivedStore: string; localOid: string; peerOid: string; outputParent: string;
}
export interface GuardianMergeProposal {
  localOid: string; peerOid: string; treeOid: string | null;
  status: "same" | "local-ahead" | "peer-ahead" | "clean" | "conflicted";
  conflictPaths: string[]; storePath: string; approved: false; applied: false;
}
const OID = /^[0-9a-f]{40}$/;
const marker = "git-sync direct committed history store v1\n";
const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function directory(path: string, privateMode = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path) || await realpath(path) !== path)
    throw new Error("Noncanonical or symlink directory");
  const st = await lstat(path);
  if (!st.isDirectory() || (privateMode && (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)))
    throw new Error("Unsafe private directory");
  return `${st.dev}:${st.ino}`;
}
// Unlike directGit, this needs exit 1 stdout, no real HOME, and file transport
// enabled ONLY during imports. Config overrides propagate into upload-pack.
async function git(cwd: string, args: string[], exitOne = false, importing = false) {
  const config = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.attributesFile=/dev/null",
    "maintenance.auto=false", "gc.auto=0", "protocol.allow=never", `protocol.file.allow=${importing ? "always" : "never"}`];
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/dev/null", XDG_CONFIG_HOME: "/dev/null",
    LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: importing ? "file" : "" };
  config.forEach((entry, i) => { const at = entry.indexOf("="); env[`GIT_CONFIG_KEY_${i}`] = entry.slice(0, at); env[`GIT_CONFIG_VALUE_${i}`] = entry.slice(at + 1); });
  return new Promise<{ code: number; out: string }>((accept, reject) => {
    const child = spawn("/usr/bin/git", ["-C", cwd, ...args], { cwd: "/", env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let failure: Error | undefined, size = 0;
    const chunks: Buffer[] = [];
    const kill = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("Preview Git timeout"), 15_000);
    for (const [stream, collect] of [[child.stdout, true], [child.stderr, false]] as const) stream.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 1024 * 1024) kill("Preview Git output limit");
      else if (collect && !failure) chunks.push(b);
    });
    child.on("error", () => { failure ??= new Error("Preview Git could not start"); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 && !(exitOne && code === 1)) reject(new Error(`Preview Git ${args[0]} failed (${code})`));
      else {
        const output = Buffer.concat(chunks);
        if (!isUtf8(output)) reject(new Error("Preview output is not lossless UTF-8"));
        else accept({ code: code!, out: output.toString("utf8") });
      }
    });
  });
}
const text = async (cwd: string, args: string[]) => (await git(cwd, args)).out.trim();
async function outsideGit(path: string): Promise<void> {
  for (let p = path; ; p = dirname(p)) {
    if (await exists(join(p, ".git")) || (await exists(join(p, "HEAD")) && await exists(join(p, "objects"))))
      throw new Error("App output must be outside Git roots");
    if (p === dirname(p)) break;
  }
}

/** Explicit isolated preparation, never approval/apply. Trusted local sources;
 * localOid must still be HEAD; the caller supplies the trusted received-store
 * mapping and serializes use (checks cannot freeze concurrent Git writers).
 * Failed preparations may leave private scratch objects, never a proposal.json.
 * No hard disk/RAM quota; all subprocesses have time/output/process-group bounds.
 */
export async function prepareGuardianMergePreview(input: GuardianMergePreviewInput): Promise<GuardianMergeProposal> {
  const { repository, receivedStore, localOid, peerOid, outputParent } = input;
  if (!OID.test(localOid) || !OID.test(peerOid)) throw new Error("Expected exact SHA-1 tips");
  const sourceId = await directory(repository), peerId = await directory(receivedStore, true);
  await directory(outputParent, true);
  if ((await lstat(join(repository, ".git"))).isSymbolicLink()) throw new Error("Symlink Git directory");
  const gitDir = await realpath(await text(repository, ["rev-parse", "--absolute-git-dir"]));
  const commonDir = await realpath(resolve(repository, await text(repository, ["rev-parse", "--git-common-dir"])));
  if (await text(repository, ["rev-parse", "--show-toplevel"]) !== repository ||
      await text(receivedStore, ["rev-parse", "--is-bare-repository"]) !== "true" ||
      await text(receivedStore, ["rev-parse", "--absolute-git-dir"]) !== receivedStore)
    throw new Error("Expected exact worktree and received bare store roots");
  for (const root of [repository, gitDir, commonDir, receivedStore]) {
    if (inside(outputParent, root) || inside(root, outputParent)) throw new Error("Unsafe source/output overlap");
    if (root !== receivedStore && (inside(receivedStore, root) || inside(root, receivedStore))) throw new Error("Unsafe source overlap");
  }
  await outsideGit(outputParent);
  await outsideGit(dirname(receivedStore));
  const fd = await open(join(receivedStore, "direct-sync-store-v1"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 ||
        st.size !== Buffer.byteLength(marker) || await fd.readFile("utf8") !== marker) throw new Error("Not a private app received store");
  } finally { await fd.close(); }
  for (const root of [commonDir, receivedStore]) {
    await directory(join(root, "objects"));
    await directory(join(root, "objects/pack"));
    if (await text(root, ["rev-parse", "--show-object-format"]) !== "sha1") throw new Error("Expected SHA-1 source");
    for (const name of ["shallow", "info/grafts", "objects/info/alternates", "objects/info/http-alternates"])
      if (await exists(join(root, name))) throw new Error("Incomplete or overlaid source graph");
    if ((await readdir(join(root, "objects/pack"))).some(name => name.endsWith(".promisor"))) throw new Error("Partial source graph");
  }
  const unchanged = async () => {
    if (await directory(repository) !== sourceId || await directory(receivedStore, true) !== peerId ||
        await text(repository, ["rev-parse", "--verify", "HEAD"]) !== localOid)
      throw new Error("Source changed from requested local tip");
  };
  await unchanged();
  const storePath = await mkdtemp(join(outputParent, "guardian-merge-"));
  await directory(storePath, true);
  await git(storePath, ["init", "--bare", "--template=", "--object-format=sha1", "--initial-branch=preview", "."]);
  for (const [source, oid] of [[repository, localOid], [receivedStore, peerOid]] as const) {
    await git(storePath, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
      "--no-recurse-submodules", "--no-auto-gc", source, oid], false, true);
    if (await text(storePath, ["cat-file", "-t", oid]) !== "commit") throw new Error("Tip is not an actual commit");
  }
  if (await exists(join(storePath, "shallow"))) throw new Error("Incomplete imported graph");
  await git(storePath, ["fsck", "--full", "--strict", "--no-reflogs", localOid, peerOid]);
  let status: GuardianMergeProposal["status"], treeOid: string | null = null, conflictPaths: string[] = [];
  if (localOid === peerOid) status = "same";
  else if ((await git(storePath, ["merge-base", "--is-ancestor", localOid, peerOid], true)).code === 0) status = "peer-ahead";
  else if ((await git(storePath, ["merge-base", "--is-ancestor", peerOid, localOid], true)).code === 0) status = "local-ahead";
  else {
    const result = await git(storePath, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", localOid, peerOid], true);
    const fields = result.out.split("\0");
    treeOid = fields.shift() ?? "";
    if (!OID.test(treeOid) || fields.pop() !== "" || fields.some(p => !p)) throw new Error("Malformed merge-tree result");
    conflictPaths = [...new Set(fields)].sort();
    status = result.code === 0 ? "clean" : "conflicted";
    if (status === "clean" && conflictPaths.length) throw new Error("Unexpected conflict paths");
    if (await text(storePath, ["cat-file", "-t", treeOid]) !== "tree") throw new Error("Missing merge tree");
  }
  await unchanged();
  const proposal: GuardianMergeProposal = { localOid, peerOid, treeOid, status, conflictPaths, storePath, approved: false, applied: false };
  const file = await open(join(storePath, "proposal.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(proposal, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
  return proposal;
}
