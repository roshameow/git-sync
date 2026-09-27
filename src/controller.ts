import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Config, type Repo, pinnedWire, privateText, sshCommand, wireFingerprint } from "./config.js";
import { applyReceivedFastForward } from "./direct-sync-apply.js";
import { directGit, receiveCommittedBranch } from "./direct-sync.js";
import { ensureLocalLockParent, withOwnedLocalLock } from "./local-lock.js";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if (missing(e)) return false; throw e; }
}
export const repoDirectory = (c: Config, r: Repo): string =>
  join(c.stateDirectory, createHash("sha256").update(r.localPath).digest("hex"));
async function directory(path: string): Promise<void> {
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  if (await realpath(ancestor) !== ancestor) throw new Error("State ancestor must be canonical");
  await ensureLocalLockParent(join(path, "placeholder"), "git-sync");
  if (await realpath(path) !== path) throw new Error("State path must be canonical, without symlinks");
  for (let p = path; ; p = dirname(p)) {
    await syncDirectory(dirname(p)); // Persist newly created directory entries before any apply.
    if (p === ancestor) break;
  }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}
async function save(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try { await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`); await fd.sync(); } finally { await fd.close(); }
  try { await rename(tmp, path); } catch (e) { await unlink(tmp); throw e; }
  await syncDirectory(dirname(path));
}
async function mapping(c: Config, r: Repo, wire: string, signal?: AbortSignal) {
  const git = (args: string[]) => directGit(r.localPath, args, { ...(signal ? { signal } : {}) });
  const gitDir = await realpath((await git(["rev-parse", "--absolute-git-dir"])).trim());
  const commonDir = await realpath(resolve(r.localPath, (await git(["rev-parse", "--git-common-dir"])).trim()));
  const identity = async (p: string) => { const st = await lstat(p); return `${st.dev}:${st.ino}`; };
  return { version: 1, ...r, repositoryIdentity: await identity(r.localPath), gitDir, gitDirIdentity: await identity(gitDir),
    commonDir, commonDirIdentity: await identity(commonDir), host: c.peer.host, user: c.peer.user, fingerprint: wireFingerprint(wire) };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function status(c: Config): Promise<unknown[]> {
  return Promise.all(c.repos.map(async r => {
    const dir = repoDirectory(c, r);
    if (await exists(join(dir, "apply-intent.json"))) return { id: r.id, status: "needs-recovery", reason: "Existing apply intent retained; reconcile manually" };
    try {
      const last = JSON.parse(await privateText(join(dir, "status.json"))) as { id?: unknown } | null;
      if (last?.id !== r.id) return { id: r.id, status: "needs-recovery", reason: "Saved status identity changed" };
      if (!same(JSON.parse(await privateText(join(dir, "identity.json"))), await mapping(c, r, await pinnedWire(c))))
        return { id: r.id, status: "needs-recovery", reason: "Repository mapping changed" };
      return last;
    } catch (e) {
      if (missing(e) && !await exists(join(dir, "status.json"))) return { id: r.id, status: "never-run" };
      return { id: r.id, status: "needs-recovery", reason: "Cannot validate saved status/mapping" };
    }
  }));
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export async function once(c: Config, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  signal?.throwIfAborted();
  // All read-only checks precede creation of app state, including when apply is off.
  const wire = await pinnedWire(c);
  for (const r of c.repos) {
    if (await realpath(r.localPath) !== r.localPath) throw new Error("Local path must be canonical");
    if ((await directGit(r.localPath, ["rev-parse", "--show-toplevel"], { ...(signal ? { signal } : {}) })).trim() !== r.localPath)
      throw new Error("Local path must be the worktree root");
    const common = await realpath(resolve(r.localPath, (await directGit(r.localPath, ["rev-parse", "--git-common-dir"], { ...(signal ? { signal } : {}) })).trim()));
    if (overlaps(r.localPath, c.stateDirectory) || overlaps(common, c.stateDirectory)) throw new Error("State must be separate from Git/worktree storage");
  }
  await directory(c.stateDirectory);
  return withOwnedLocalLock(join(c.stateDirectory, "controller.lock"), "git-sync", async () => {
    const results: Record<string, unknown>[] = [];
    for (const r of c.repos) {
      signal?.throwIfAborted();
      const dir = repoDirectory(c, r), store = join(dir, "received.git"), intentPath = join(dir, "apply-intent.json");
      await directory(dir);
      let result: Record<string, unknown>;
      try {
        // Never receive, retry an apply, or retire evidence while an old intent exists.
        if (await exists(intentPath)) result = { status: "needs-recovery", reason: "Existing apply intent retained; reconcile manually" };
        else {
          const currentMapping = await mapping(c, r, wire, signal);
          const mapPath = join(dir, "identity.json");
          if (await exists(mapPath)) {
            if (!same(JSON.parse(await privateText(mapPath)), currentMapping)) throw new Error("Repository mapping changed; preserve state and reconcile manually");
          } else {
            // Only a fresh per-repository directory may acquire a mapping.
            const { readdir } = await import("node:fs/promises");
            if ((await readdir(dir)).length) throw new Error("Unmapped state exists; reconcile manually");
            await save(mapPath, currentMapping);
          }
          const hostsPath = join(dir, "known_hosts");
          await saveHostKey(hostsPath, `${c.peer.host} ${wire}\n`);
          const received = await receiveCommittedBranch({ store, source: `${c.peer.user}@${c.peer.host}:${r.peerPath}`,
            branch: r.branch, sshCommand: sshCommand(hostsPath), ...(signal ? { signal } : {}) });
          result = { status: "received-only", received };
          if (c.applyCleanFastForward) result = { received, ...await applyReceivedFastForward({ repository: r.localPath,
            store, branch: r.branch, oid: received.oid, intentPath, ...(signal ? { signal } : {}) }) };
        }
      } catch (e) { result = { status: "error", reason: e instanceof Error ? e.message : "Receive/apply failed" }; }
      result = { id: r.id, completedAt: new Date().toISOString(), ...result };
      await save(join(dir, "status.json"), result); results.push(result);
    }
    return results;
  });
}
async function saveHostKey(path: string, text: string): Promise<void> {
  if (await exists(path)) {
    if (await privateText(path) !== text) throw new Error("Pinned host file changed");
  } else {
    const fd = await open(path, "wx", 0o600);
    try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  }
}
