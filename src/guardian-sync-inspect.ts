import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowConfig } from "./workflow-config.js";
import { promisify } from "node:util";
import { resolveAppPaths, type AppPaths } from "./config.js";
import { directSyncStatus, loadDirectSyncConfig, verifiedWorkflowPeerSshArgv, type DirectSyncConfig } from "./direct-sync-service.js";
import { directGit } from "./direct-sync.js";
import { gitReadEnvironment } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { loadInventories } from "./inventory.js";
import { loadRegistry } from "./registry.js";
import { normalizeRemote } from "./remote.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
const DIRTY_JSON_BYTES = 16 * 1024;
// Capabilities of THESE CLI endpoints, not permissions of the ordinary Pi session.
const controls = { inspect: true, requestSync: true, apply: false, commit: false, stash: false, push: false } as const;
const oid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const date = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) && Number.isFinite(Date.parse(s));
// Read-only diagnostic freshness tolerates a small cross-host clock offset.
// This is not an admission/write authorization or permission to use stale OIDs.
const recent = (s: string | null) => !!s && Date.now() - Date.parse(s) >= -5_000 && Date.now() - Date.parse(s) < 120_000;
const APPLY = new Set("not-requested pending applying blocked-transfer up-to-date fast-forwarded local-ahead blocked-dirty blocked-diverged blocked-branch needs-recovery error blocked-disabled blocked-legacy-attempt blocked-identity blocked-settings-changed blocked-cancelled".split(" "));
const TRANSFER = new Set("pending receiving received blocked error".split(" "));
export interface GuardianRepositoryInspection {
  canonicalRemote: string; configuredBranch: string; enabled: boolean; currentFresh: boolean;
  head: string | null; branch: string | null;
  dirty: { paths: { status: string; path: string }[]; total: number; truncated: boolean } | null;
  cached: { transfer: string; apply: string; receivedOid: string | null; receivedAt: string | null } | null;
  error: string | null;
}
export interface GuardianLocalInspection {
  schemaVersion: 1; observedAt: string; hostId: string; peerHostId: string | null;
  configured: boolean; applyCleanFastForward: boolean; diagnosticEndpointCapabilities: typeof controls;
  freshness: { liveRead: true; atomic: false; cachedStatus: true; cachedCompletedAt: string | null; cachedRecent: boolean; cacheError: boolean };
  repositories: GuardianRepositoryInspection[];
}
type Dependencies = { workflow: typeof loadWorkflowConfig; config: typeof loadDirectSyncConfig; peer: typeof verifiedWorkflowPeerSshArgv;
  run: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string> };
const production: Dependencies = { workflow: loadWorkflowConfig, config: loadDirectSyncConfig, peer: verifiedWorkflowPeerSshArgv,
  run: async (file, args, env) => (await promisify(execFile)(file, args, {
    env, cwd: "/", timeout: 25_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8",
  })).stdout }; // <=512 KiB combined stdout/stderr; no shell and no inherited NODE_OPTIONS.
const canonical = (v: unknown): v is string => typeof v === "string" && v.length <= 300 && v.trim() === v &&
  /^[a-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v);
function selection(c: DirectSyncConfig | null, remote?: string, allowPeerOnly = false) {
  if (remote !== undefined && (!canonical(remote) ||
    (!allowPeerOnly && !c?.repositories.some(r => r.canonicalRemote === remote)))) throw new Error("Select a configured canonical remote, not a path");
  return c?.repositories.filter(r => remote === undefined || r.canonicalRemote === remote) ?? [];
}
async function config(paths: AppPaths, deps: Dependencies) {
  const c = await deps.config(paths), host = await loadHostIdentity(paths);
  if (c && c.hostId !== host.id) throw new Error("Local host does not match direct-sync configuration");
  return { c, host };
}
/** Porcelain v1 -z: rename destination precedes source; count both dirty paths. */
function dirtyPaths(text: string): NonNullable<GuardianRepositoryInspection["dirty"]> {
  const paths: { status: string; path: string }[] = []; let total = 0, bytes = 2;
  const tokens = text.split("\0");
  if (tokens.pop() !== "") throw new Error("Incomplete status");
  const add = (status: string, path: string | undefined) => {
    if (!path) throw new Error("Invalid status path");
    total++;
    const size = Buffer.byteLength(JSON.stringify({ status, path })) + (paths.length ? 1 : 0);
    if (paths.length < 40 && Buffer.byteLength(path) <= 4096 && bytes + size <= DIRTY_JSON_BYTES) {
      paths.push({ status, path }); bytes += size;
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const row = tokens[i]!, status = row.slice(0, 2);
    if (!/^[ MADRCU?!]{2}$/.test(status) || row[2] !== " ") throw new Error("Invalid status record");
    add(status, row.slice(3));
    if (/[RC]/.test(status)) add(status, tokens[++i]);
  }
  return { paths, total, truncated: total > paths.length };
}
async function local(paths: AppPaths, remote: string | undefined, deps: Dependencies, allowPeerOnly = false): Promise<GuardianLocalInspection> {
  const { c, host } = await config(paths, deps), selected = selection(c, remote, allowPeerOnly);
  const workflow = await deps.workflow(paths), peers = Object.keys(workflow.peers);
  if (peers.length > 1 || peers.includes(host.id)) throw new Error("Invalid workflow peer selection");
  const registry = selected.length ? await loadRegistry(paths) : null, inventories = selected.length ? await loadInventories(paths) : [];
  let cache = null, cacheError = false;
  try { cache = await directSyncStatus(paths); } catch { cacheError = true; }
  const completed = date(cache?.completedAt) ? cache.completedAt : null;
  const result: GuardianLocalInspection = { schemaVersion: 1, observedAt: new Date().toISOString(), hostId: host.id,
    peerHostId: peers[0] ?? null, configured: !!c, applyCleanFastForward: c?.applyCleanFastForward ?? false,
    diagnosticEndpointCapabilities: controls, freshness: { liveRead: true, atomic: false, cachedStatus: true,
      cachedCompletedAt: completed, cachedRecent: recent(completed), cacheError }, repositories: [] };
  for (const r of selected) {
    const old = cache?.repositories.find(s => s.canonicalRemote === r.canonicalRemote && s.branch === r.branch && s.peerHostId === c!.peerHostId);
    const row: GuardianRepositoryInspection = { canonicalRemote: r.canonicalRemote, configuredBranch: r.branch,
      enabled: r.enabled && registry?.repositories[r.canonicalRemote]?.mode === "enabled", currentFresh: false,
      head: null, branch: null, dirty: null, error: null,
      cached: old && TRANSFER.has(old.transfer.state) && APPLY.has(old.apply.state) ? {
        transfer: old.transfer.state, apply: old.apply.state, receivedOid: oid(old.received?.oid) ? old.received.oid : null,
        receivedAt: date(old.received?.completedAt) ? old.received.completedAt : null } : null };
    result.repositories.push(row);
    if (!row.enabled) { row.error = "Repository is disabled; checkout not inspected"; continue; }
    try {
      const records = inventories.find(i => i.hostId === host.id)?.repositories.filter(i => i.canonicalRemote === r.canonicalRemote) ?? [];
      if (records.length !== 1) throw new Error();
      const record = records[0]!, path = record.path, marker = await lstat(join(path, ".git"));
      if (path !== r.localPath) throw new Error();
      if (await realpath(path) !== path || !(await lstat(path)).isDirectory() || marker.isSymbolicLink() ||
        (marker.isDirectory() ? "directory" : marker.isFile() ? "file" : "invalid") !== record.gitMarker || !record.remoteName) throw new Error();
      const git = (args: string[]) => directGit(path, args, { timeoutMs: 5000 });
      if ((await git(["rev-parse", "--show-toplevel"])).trim() !== path ||
        normalizeRemote((await git(["config", "--get", `remote.${record.remoteName}.url`])).trim(), path) !== r.canonicalRemote) throw new Error();
      const gitDirectory = (await git(["rev-parse", "--absolute-git-dir"])).trim();
      const commonDirectory = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      if ((gitDirectory !== commonDirectory) !== record.worktree) throw new Error();
      const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
      if (!oid(head)) throw new Error();
      // Status may invoke clean filters while hashing tracked files. Inspect only
      // key names; exit 1 means no matches, all other query failures fail closed.
      let filterKeys: string;
      try { filterKeys = await git(["config", "--name-only", "--get-regexp", "^filter\\."]); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "Direct sync Git failed (1)") throw error;
        filterKeys = "";
      }
      if (filterKeys.trim()) { row.error = "Dirty inspection unavailable: configured Git filters"; continue; }
      // Nested status can run a submodule's own filters. Never recurse into it.
      if ((await git(["ls-files", "--stage", "-z"])).split("\0").some(entry => entry.startsWith("160000 "))) {
        row.error = "Dirty inspection unavailable: submodule requires separate inspection"; continue;
      }
      // --no-renames yields every changed filename, including both rename paths.
      const dirty = dirtyPaths(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]));
      const branch = (await git(["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
      if (branch !== "HEAD" && !branch.startsWith("refs/heads/")) throw new Error();
      Object.assign(row, { head, branch: branch === "HEAD" ? null : branch.slice(11), dirty, currentFresh: true });
    } catch { row.error = "Checkout identity or read-only Git inspection unavailable"; }
  }
  return result;
}
export function inspectGuardianLocal(paths: AppPaths, canonicalRemote?: string) { return local(paths, canonicalRemote, production); }

// Strict projection: peer JSON never forwards unknown config keys, errors, pins or credentials.
function peerSnapshot(text: string, ownHostId: string, peerHostId: string, remote?: string): GuardianLocalInspection {
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error();
  const v = JSON.parse(text) as GuardianLocalInspection;
  if (v.schemaVersion !== 1 || v.hostId !== peerHostId || (v.peerHostId !== null && v.peerHostId !== ownHostId) || !date(v.observedAt) ||
    typeof v.configured !== "boolean" || typeof v.applyCleanFastForward !== "boolean" || !Array.isArray(v.repositories) || v.repositories.length > 100) throw new Error();
  const f = v.freshness, seen = new Set<string>();
  if (!f || (f.cachedCompletedAt !== null && !date(f.cachedCompletedAt)) || typeof f.cacheError !== "boolean") throw new Error();
  const repositories = v.repositories.map(r => {
    if (!r || seen.has(r.canonicalRemote) || !canonical(r.canonicalRemote) ||
      (remote !== undefined && r.canonicalRemote !== remote) || typeof r.configuredBranch !== "string" ||
      !/^[A-Za-z0-9_./-]{1,200}$/.test(r.configuredBranch) || typeof r.enabled !== "boolean" || typeof r.currentFresh !== "boolean" ||
      (r.head !== null && !oid(r.head)) || (r.branch !== null && (typeof r.branch !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(r.branch)))) throw new Error();
    seen.add(r.canonicalRemote);
    let dirty: GuardianRepositoryInspection["dirty"] = null, cached: GuardianRepositoryInspection["cached"] = null;
    if (r.dirty !== null) {
      const d = r.dirty;
      if (!Array.isArray(d.paths) || d.paths.length > 40 || Buffer.byteLength(JSON.stringify(d.paths)) > DIRTY_JSON_BYTES ||
        !Number.isSafeInteger(d.total) || d.total < d.paths.length ||
        d.truncated !== (d.total > d.paths.length)) throw new Error();
      dirty = { paths: d.paths.map(p => {
        if (!/^[ MADRCU?!]{2}$/.test(p.status) || typeof p.path !== "string" || !p.path || Buffer.byteLength(p.path) > 4096 || p.path.includes("\0")) throw new Error();
        return { status: p.status, path: p.path };
      }), total: d.total, truncated: d.truncated };
    }
    if (r.cached !== null) {
      const x = r.cached;
      if (!TRANSFER.has(x.transfer) || !APPLY.has(x.apply) || (x.receivedOid !== null && !oid(x.receivedOid)) ||
        (x.receivedAt !== null && !date(x.receivedAt))) throw new Error();
      cached = { transfer: x.transfer, apply: x.apply, receivedOid: x.receivedOid, receivedAt: x.receivedAt };
    }
    if (r.currentFresh && (!r.enabled || !r.head || !dirty || r.error !== null)) throw new Error();
    return { canonicalRemote: r.canonicalRemote, configuredBranch: r.configuredBranch, enabled: r.enabled,
      currentFresh: r.currentFresh && recent(v.observedAt), head: r.head, branch: r.branch, dirty, cached,
      error: r.error === null ? null : "Peer checkout inspection unavailable" };
  });
  if (remote && !seen.has(remote)) throw new Error();
  return { schemaVersion: 1, observedAt: v.observedAt, hostId: v.hostId, peerHostId: v.peerHostId,
    configured: v.configured, applyCleanFastForward: v.applyCleanFastForward, diagnosticEndpointCapabilities: controls,
    freshness: { liveRead: true, atomic: false, cachedStatus: true, cachedCompletedAt: f.cachedCompletedAt,
      cachedRecent: recent(f.cachedCompletedAt), cacheError: f.cacheError }, repositories };
}
async function peer(paths: AppPaths, args: string[], deps: Dependencies) {
  const [workflow, own] = await Promise.all([deps.workflow(paths), loadHostIdentity(paths)]);
  const peers = Object.keys(workflow.peers), peerHostId = peers[0];
  if (peers.length !== 1 || !peerHostId || peerHostId === own.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(peerHostId))
    throw new Error("A single distinct workflow peer is required");
  const endpoint = workflow.peers[peerHostId]!;
  const ssh = await deps.peer(paths, peerHostId);
  const text = await deps.run(ssh.executable, [...ssh.args, [endpoint.nodeExecutable, endpoint.cliEntrypoint, ...args].map(shellQuote).join(" ")], gitReadEnvironment());
  return { text, peerHostId };
}
async function both(paths: AppPaths, remote: string | undefined, deps: Dependencies) {
  const snapshot = await local(paths, remote, deps, true);
  try {
    const response = await peer(paths, ["guardian", "local-inspect", ...(remote ? [remote] : [])], deps);
    const snapshotPeer = peerSnapshot(response.text, snapshot.hostId, response.peerHostId, remote);
    return { local: snapshot, peer: { available: true, snapshot: snapshotPeer, error: null }, synchronized: "unknown" as const,
      guidance: "These endpoints only inspect/request existing-policy work; they do not limit normal Pi tools. Explain both hosts and concrete blockers; local-ahead is not proof the peer applied anything." };
  } catch { return { local: snapshot, peer: { available: false, snapshot: null,
    error: "Peer unavailable: configuration, SSH pin, transport, deadline or response validation failed" }, synchronized: "unknown" as const,
      guidance: "These endpoints only inspect/request existing-policy work; they do not limit normal Pi tools. Explain both hosts and concrete blockers; local-ahead is not proof the peer applied anything." }; }
}
export function inspectGuardianBoth(paths: AppPaths, canonicalRemote?: string) { return both(paths, canonicalRemote, production); }
function localEnvironment(paths: AppPaths) {
  const env = { ...gitReadEnvironment(), GIT_SYNC_HOME: dirname(paths.configFile) };
  if (resolveAppPaths(env).stateDirectory !== paths.stateDirectory) {
    delete (env as NodeJS.ProcessEnv).GIT_SYNC_HOME;
    Object.assign(env, { XDG_CONFIG_HOME: dirname(dirname(paths.configFile)), XDG_STATE_HOME: dirname(paths.stateDirectory) });
  }
  const resolved = resolveAppPaths(env);
  if (resolved.configFile !== paths.configFile || resolved.daemonWakeFile !== paths.daemonWakeFile) throw new Error();
  return env;
}
async function wake(paths: AppPaths, deps: Dependencies) {
  const request = async (work: () => Promise<string>) => {
    try { const v = JSON.parse(await work()) as { requestedAt: string }; if (!date(v.requestedAt)) throw new Error();
      return { requested: true, requestedAt: v.requestedAt, error: null }; }
    catch { return { requested: false, requestedAt: null, error: "Wake unavailable; no application claimed" }; }
  };
  const [local, remote] = await Promise.all([
    request(() => deps.run(process.execPath, [CLI, "sync", "wake"], localEnvironment(paths))),
    request(async () => (await peer(paths, ["sync", "wake"], deps)).text),
  ]);
  return { local, peer: remote, applied: false,
    result: local.requested || remote.requested ? "requested-not-applied" as const : "not-requested" as const, diagnosticEndpointCapabilities: controls };
}
export function requestGuardianSync(paths: AppPaths) { return wake(paths, production); }
/** Offline adapters only; production APIs never accept transports, paths or commands from tool input. */
export const __guardianInspectForTests = { local, both, wake, dirtyPaths };
