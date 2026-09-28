import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import type { RegistryEntry, RepositoryRecord } from "./types.js";
import { loadHostIdentity } from "./host.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import { inventoryPath } from "./inventory.js";
import { isHostInventory } from "./validation.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { inspectRepositoryPath } from "./discovery.js";
import { OID_PATTERN } from "./git.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { withStateMutationLock } from "./state-mutation.js";
import { hasRetainedApplyIntent } from "./sync-apply-intents.js";
import { readJson, writeJsonAtomic } from "./storage.js";
import { directGit, receiveCommittedBranch, type DirectSyncResult } from "./direct-sync.js";
import { applyReceivedFastForward, type DirectSyncApplyResult } from "./direct-sync-apply.js";
import type { DirectSyncRepositoryStatus } from "./direct-sync-service.js";

export interface UpstreamSyncConfig {
  schemaVersion: 1;
  hostId: string;
  intervalSeconds: number;
  repositories: {
    canonicalRemote: string;
    branch: string;
    enabled: boolean;
    applyCleanFastForward: boolean;
  }[];
}
export interface UpstreamSyncRepositoryStatus extends DirectSyncRepositoryStatus {
  /** Read-only observation from this host's validated checkout, never a peer
   * filesystem lookup or apply authority. Null means unknown in this pass;
   * absent is accepted only for backwards-compatible status readers. */
  localHead?: string | null;
}
export interface UpstreamSyncStatus {
  mode: "upstream";
  hostId: string;
  startedAt: string;
  completedAt: string | null;
  repositories: UpstreamSyncRepositoryStatus[];
}
export interface UpstreamSyncRunOptions { readonly signal?: AbortSignal }
type Selection = UpstreamSyncConfig["repositories"][number];
type BlockedState = "blocked-disabled" | "blocked-identity" | "blocked-settings-changed" | "blocked-cancelled";
class Blocked extends Error {
  constructor(readonly state: BlockedState, reason: string) { super(reason); }
}
const CONFIG_LIMIT = 128 * 1024, STATUS_LIMIT = 512 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const configFile = (paths: AppPaths) => join(paths.stateDirectory, "upstream-sync.json");
const statusFile = (paths: AppPaths) => join(paths.stateDirectory, "upstream-sync-status.json");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hostId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const keysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function canonicalRemote(value: unknown): string {
  // Canonical identity only: URLs, credentials, ports, aliases and local paths
  // are never accepted as transport configuration. GitHub names are case-insensitive.
  if (typeof value !== "string" || !/^github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value.split("/")[1]!.includes("--") || [".", ".."].includes(value.split("/")[2]!) || /\.git$/i.test(value))
    throw new Error("Invalid canonical GitHub repository identity");
  return value.toLowerCase();
}
function branchName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) &&
    !value.includes("..") && !value.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"));
}
function fingerprint(st: Stats): string {
  return [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(":");
}
/** Bounded descriptor read; never follow links or allocate from an untrusted size. */
async function ownerText(file: string, max: number): Promise<{ text: string; identity: string }> {
  const check = (st: Stats) => {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o600 || st.size > max) throw new Error("Unsafe upstream sync settings or evidence file");
  };
  const before = await lstat(file); check(before);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await fd.stat(); check(initial);
    if (fingerprint(initial) !== fingerprint(before)) throw new Error("Upstream sync file changed during open");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > max) throw new Error("Upstream sync file exceeds size bound");
    const after = await fd.stat(), named = await lstat(file); check(after); check(named);
    if (fingerprint(initial) !== fingerprint(after) || fingerprint(after) !== fingerprint(named))
      throw new Error("Upstream sync file changed during read");
    return { text: buffer.subarray(0, size).toString("utf8"), identity: fingerprint(after) };
  } finally { await fd.close(); }
}
function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("Invalid upstream sync JSON"); }
}
function parseConfig(text: string): UpstreamSyncConfig {
  const c = json(text);
  if (!object(c) || !keysOnly(c, ["schemaVersion", "hostId", "intervalSeconds", "repositories"]) || c.schemaVersion !== 1 ||
    !hostId(c.hostId) || !Number.isInteger(c.intervalSeconds) || (c.intervalSeconds as number) < 30 ||
    (c.intervalSeconds as number) > 900 || !Array.isArray(c.repositories) || c.repositories.length > 100)
    throw new Error("Invalid upstream sync config");
  const seen = new Set<string>();
  for (const r of c.repositories) {
    if (!object(r) || !keysOnly(r, ["canonicalRemote", "branch", "enabled", "applyCleanFastForward"]) ||
      canonicalRemote(r.canonicalRemote) !== r.canonicalRemote || seen.has(r.canonicalRemote as string) || !branchName(r.branch) ||
      typeof r.enabled !== "boolean" || typeof r.applyCleanFastForward !== "boolean")
      throw new Error("Invalid upstream sync repository selection");
    seen.add(r.canonicalRemote as string);
  }
  return c as unknown as UpstreamSyncConfig;
}
async function configSnapshot(paths: AppPaths) {
  try {
    const snapshot = await ownerText(configFile(paths), CONFIG_LIMIT);
    return { ...snapshot, config: parseConfig(snapshot.text) };
  } catch (error) { if (missing(error)) return null; throw error; }
}
export async function loadUpstreamSyncConfig(paths: AppPaths): Promise<UpstreamSyncConfig | null> {
  return (await configSnapshot(paths))?.config ?? null;
}
const same = (a: unknown, b: unknown): boolean => {
  const stable = (v: unknown): unknown => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]))
    : Array.isArray(v) ? v.map(stable) : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
};
async function excludeDirect(paths: AppPaths, remote: string): Promise<void> {
  // Read just the exclusion authority, not peer endpoints/host allowlists. This
  // service must remain generic even while direct-peer configuration is not.
  let text: string;
  try { text = (await ownerText(join(paths.stateDirectory, "direct-sync.json"), CONFIG_LIMIT)).text; }
  catch (error) { if (missing(error)) return; throw new Blocked("blocked-settings-changed", "Direct peer settings are unsafe"); }
  const value = json(text);
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.repositories) || value.repositories.length > 100 ||
    value.repositories.some(r => !object(r) || typeof r.canonicalRemote !== "string" || typeof r.enabled !== "boolean"))
    throw new Blocked("blocked-settings-changed", "Direct peer settings cannot be checked safely");
  if (value.repositories.some(r => r.enabled && r.canonicalRemote.toLowerCase() === remote))
    throw new Blocked("blocked-settings-changed", "Repository is enabled for direct peer sync; disable it before selecting upstream");
}
async function inspectLocal(paths: AppPaths, id: string, remote: string): Promise<{
  record: RepositoryRecord; identity: string; localHead: string | null;
}> {
  try {
    // Read ONLY this host's inventory. A missing, duplicate, malformed or offline
    // peer has no bearing on single-host upstream authority.
    const inventory = await readJson(inventoryPath(paths, id), isHostInventory);
    if (inventory.hostId !== id) throw new Error("Inventory host mismatch");
    const records = inventory.repositories.filter(r => r.canonicalRemote === remote);
    if (records.length !== 1) throw new Error("Nonunique local checkout");
    const record = records[0]!;
    if (!isAbsolute(record.path) || /[\r\n\0]/.test(record.path)) throw new Error("Invalid path");
    const path = resolve(record.path);
    if (await realpath(path) !== path) throw new Error("Symlink checkout path");
    const root = await lstat(path), marker = await lstat(join(path, ".git"));
    if (!root.isDirectory() || root.isSymbolicLink() || marker.isSymbolicLink()) throw new Error("Unsafe checkout marker");
    const inspected = await inspectRepositoryPath(path);
    // Discovery normalizes the real configured remote (including HTTPS/SCP
    // spelling and GitHub case), never using it as the network endpoint.
    if (inspected.canonicalRemote !== remote || !same(inspected, { ...record, path })) throw new Error("Changed checkout identity");
    const gitDir = (await directGit(path, ["rev-parse", "--absolute-git-dir"])).trim();
    const commonDir = resolve(path, (await directGit(path, ["rev-parse", "--git-common-dir"])).trim());
    const ids: string[] = [];
    for (const directory of [gitDir, commonDir]) {
      if (await realpath(directory) !== directory) throw new Error("Symlink Git directory");
      const st = await lstat(directory);
      if (!st.isDirectory()) throw new Error("Invalid Git directory");
      ids.push(directory, `${st.dev}:${st.ino}`);
    }
    // rev-parse does not inspect dirty files/index or execute filters. Unborn or
    // unavailable HEAD is unknown evidence, not a reason to borrow an old HEAD.
    let localHead: string | null = null;
    try {
      const head = (await directGit(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
      if (OID_PATTERN.test(head)) localHead = head;
    } catch { /* Preserve null for unavailable HEAD. */ }
    return { record: inspected, identity: [record.path, root.dev, root.ino, marker.dev, marker.ino, ...ids].join(":"), localHead };
  } catch { throw new Blocked("blocked-identity", "Local inventory must uniquely identify an existing unchanged GitHub checkout"); }
}
async function enabledLocal(paths: AppPaths, config: UpstreamSyncConfig, selected: Selection) {
  let localHostId: string;
  try { localHostId = (await loadHostIdentity(paths)).id; }
  catch { throw new Blocked("blocked-identity", "Upstream sync host identity is unavailable"); }
  if (localHostId !== config.hostId) throw new Blocked("blocked-identity", "Upstream sync host identity differs");
  if (!selected.enabled) throw new Blocked("blocked-disabled", "Upstream sync is disabled for this repository");
  await excludeDirect(paths, selected.canonicalRemote);
  const registry = await loadRegistry(paths), entry = registry.repositories[selected.canonicalRemote];
  if (entry?.mode !== "enabled") throw new Blocked("blocked-disabled", "Repository is not enabled in the local registry");
  return { ...await inspectLocal(paths, config.hostId, selected.canonicalRemote), entry };
}

/** Explicit registration is apply opt-in. Registry fields are preserved, and
 * both atomic file replacements run in the normal state mutation critical
 * section. Disabling preserves an existing branch selection, needs no checkout,
 * and does not revoke other registry workflows. */
export async function configureUpstreamSync(paths: AppPaths, remote: string, branch: string, enabled: boolean): Promise<UpstreamSyncConfig> {
  remote = canonicalRemote(remote);
  if (!branchName(branch) || typeof enabled !== "boolean") throw new Error("Invalid upstream sync selection");
  return withStateMutationLock(paths, async () => {
    const host = await loadHostIdentity(paths);
    const previous = await loadUpstreamSyncConfig(paths);
    if (previous && previous.hostId !== host.id) throw new Error("Upstream sync host identity differs");
    const config: UpstreamSyncConfig = previous ?? { schemaVersion: 1, hostId: host.id, intervalSeconds: 60, repositories: [] };
    const index = config.repositories.findIndex(r => r.canonicalRemote === remote);
    const selected: Selection = { canonicalRemote: remote,
      branch: !enabled && index >= 0 ? config.repositories[index]!.branch : branch, enabled, applyCleanFastForward: enabled };
    if (index < 0) config.repositories.push(selected); else config.repositories[index] = selected;
    parseConfig(JSON.stringify(config));
    if (enabled) {
      await excludeDirect(paths, remote);
      await inspectLocal(paths, host.id, remote);
      const registry = await loadRegistry(paths), timestamp = new Date().toISOString();
      const entry: RegistryEntry = { ...registry.repositories[remote], canonicalRemote: remote, mode: "enabled", updatedAt: timestamp };
      await saveRegistry(paths, { ...registry, updatedAt: timestamp, repositories: { ...registry.repositories, [remote]: entry } });
    }
    await writeJsonAtomic(configFile(paths), config);
    return config;
  });
}

const rowStates = ["pending", "received-not-applied", "applied", "blocked", "error"];
const transferStates = ["pending", "receiving", "received", "blocked", "error"];
const applyStates = ["not-requested", "pending", "applying", "blocked-transfer", "blocked-disabled", "blocked-identity",
  "blocked-settings-changed", "blocked-cancelled", "up-to-date", "fast-forwarded", "local-ahead", "blocked-dirty",
  "blocked-diverged", "blocked-branch", "needs-recovery", "error"];
const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value));
function receipt(value: unknown, branch: string): value is DirectSyncResult {
  return object(value) && keysOnly(value, ["branch", "oid", "receivedRef", "changed", "completedAt", "worktreeUpdated"]) &&
    value.branch === branch && oid(value.oid) && value.receivedRef === `refs/received/${hash(branch)}/${value.oid}` &&
    typeof value.changed === "boolean" && timestamp(value.completedAt) && value.worktreeUpdated === false;
}
function safeDetail(value: Record<string, unknown>): boolean {
  return [value.reason, value.error].every(v => v === undefined || (typeof v === "string" && v.length <= 300 && !/[\x00-\x1f\x7f]/.test(v)));
}
export async function upstreamSyncStatus(paths: AppPaths): Promise<UpstreamSyncStatus | null> {
  if (!await loadUpstreamSyncConfig(paths)) return null;
  try {
    const value = json((await ownerText(statusFile(paths), STATUS_LIMIT)).text);
    if (!object(value) || !keysOnly(value, ["mode", "hostId", "startedAt", "completedAt", "repositories"]) ||
      value.mode !== "upstream" || !hostId(value.hostId) || !timestamp(value.startedAt) ||
      (value.completedAt !== null && !timestamp(value.completedAt)) || !Array.isArray(value.repositories) || value.repositories.length > 100)
      throw new Error("Invalid upstream sync status");
    const seen = new Set<string>();
    for (const r of value.repositories) {
      if (!object(r) || !keysOnly(r, ["canonicalRemote", "branch", "state", "transfer", "apply", "received", "localHead"]) ||
        (r.localHead !== undefined && r.localHead !== null && (typeof r.localHead !== "string" || !OID_PATTERN.test(r.localHead))) ||
        canonicalRemote(r.canonicalRemote) !== r.canonicalRemote || seen.has(r.canonicalRemote as string) || !branchName(r.branch) ||
        !rowStates.includes(r.state as string) || !object(r.transfer) || !object(r.apply) ||
        !keysOnly(r.transfer, ["state", "reason", "error"]) || !keysOnly(r.apply, ["state", "reason", "error", "result"]) ||
        !transferStates.includes(r.transfer.state as string) || !applyStates.includes(r.apply.state as string) ||
        !safeDetail(r.transfer) || !safeDetail(r.apply) || (r.received !== undefined && !receipt(r.received, r.branch)))
        throw new Error("Invalid upstream sync status row");
      const result = r.apply.result;
      if (result !== undefined && (!object(result) || result.status !== r.apply.state ||
        (!["up-to-date", "fast-forwarded", "local-ahead"].includes(result.status as string)
          ? !["blocked-dirty", "blocked-diverged", "blocked-branch", "needs-recovery"].includes(result.status as string) ||
            !keysOnly(result, ["status", "reason"]) || typeof result.reason !== "string" || !safeDetail(result)
          : !keysOnly(result, ["status", "head", "oid"]) || !oid(result.head) || !oid(result.oid))))
        throw new Error("Invalid upstream sync apply result");
      seen.add(r.canonicalRemote as string);
    }
    return value as unknown as UpstreamSyncStatus;
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** ONLY GitHub transport is replaceable in offline tests. Inspection, locks,
 * receipt creation and local apply still use the real production implementations. */
export interface UpstreamSyncTestTransport {
  readonly TEST_ONLY: true;
  receive: typeof receiveCommittedBranch;
}
export function runUpstreamSyncOnce(paths: AppPaths, options: UpstreamSyncRunOptions = {}): Promise<UpstreamSyncStatus | null> {
  return runOnce(paths, receiveCommittedBranch, options);
}
export function __runUpstreamSyncOnceForTests(paths: AppPaths, adapter: UpstreamSyncTestTransport,
  options: UpstreamSyncRunOptions = {}): Promise<UpstreamSyncStatus | null> {
  if (adapter.TEST_ONLY !== true) throw new Error("Explicit TEST transport adapter required");
  return runOnce(paths, adapter.receive, options);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function appDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o700 ||
    await realpath(path) !== path) throw new Error("Unsafe upstream app directory");
}
function sanitizedResult(result: DirectSyncApplyResult): DirectSyncApplyResult {
  // The helper's reason can contain checkout-config keys or paths. Do not put
  // arbitrary local data, Git stderr, URLs or credentials in persisted status.
  // Preserve only this exact static vocabulary: dirty tracked work is distinct
  // from a target-path collision; neither is a merge-conflict diagnosis.
  if (result.status === "blocked-dirty" && ["Tracked or staged changes",
    "Untracked or ignored path collides with target checkout"].includes(result.reason)) return result;
  return "reason" in result ? { status: result.status, reason: result.status === "needs-recovery"
    ? "Existing or uncertain Git state; explicit recovery required" : "Checkout safety gate prevented fast-forward" } : result;
}
async function runOnce(paths: AppPaths, receive: typeof receiveCommittedBranch,
  options: UpstreamSyncRunOptions): Promise<UpstreamSyncStatus | null> {
  if (!await configSnapshot(paths)) return null;
  const cancel = () => {
    if (options.signal?.aborted) throw new Blocked("blocked-cancelled", "Upstream sync cancelled; no new apply started");
  };
  return withOwnedLocalLock(join(paths.stateDirectory, "upstream-sync.lock"), "Upstream sync", async () => {
    const snapshot = await withStateMutationLock(paths, () => configSnapshot(paths));
    if (!snapshot) return null;
    const config = snapshot.config;
    const previous = await upstreamSyncStatus(paths);
    const status: UpstreamSyncStatus = { mode: "upstream", hostId: config.hostId, startedAt: new Date().toISOString(), completedAt: null,
      repositories: config.repositories.map(selected => {
        const old = previous?.hostId === config.hostId ? previous.repositories.find(r =>
          r.canonicalRemote === selected.canonicalRemote && r.branch === selected.branch) : undefined;
        return { canonicalRemote: selected.canonicalRemote, branch: selected.branch, localHead: null, state: "pending", transfer: { state: "pending" },
          apply: { state: selected.applyCleanFastForward ? "pending" : "not-requested" }, ...(old?.received ? { received: old.received } : {}) };
      }) };
    const save = async () => {
      if (Buffer.byteLength(JSON.stringify(status, null, 2)) + 1 > STATUS_LIMIT) throw new Error("Upstream status exceeds size bound");
      await writeJsonAtomic(statusFile(paths), status);
    };
    const checkConfig = async () => {
      cancel();
      let current: Awaited<ReturnType<typeof configSnapshot>>;
      try { current = await configSnapshot(paths); } catch { current = null; }
      if (!current || current.text !== snapshot.text || current.identity !== snapshot.identity)
        throw new Blocked("blocked-settings-changed", "Upstream sync settings changed or became unsafe during this pass");
    };
    await save();
    for (const [index, selected] of config.repositories.entries()) {
      const row = status.repositories[index]!;
      let phase: "transfer" | "apply" = "transfer";
      try {
        // Capture config, registry and re-inspected checkout identity together,
        // under the same lock used by peer apply and normal state mutations.
        const local = await withStateMutationLock(paths, async () => {
          await checkConfig();
          return enabledLocal(paths, config, selected);
        });
        row.localHead = local.localHead;
        const workflow = await loadWorkflowConfig(paths);
        const checkWorkflow = async () => {
          try {
            if (!same(await loadWorkflowConfig(paths), workflow)) throw new Error("changed");
          } catch { throw new Blocked("blocked-settings-changed", "Workflow settings changed or became unsafe during this pass"); }
        };
        const root = join(paths.stateDirectory, "upstream-sync");
        const key = hash(`github-upstream:${selected.canonicalRemote}`);
        const store = join(root, `${key}.git`), intentPath = join(root, `apply-${key}.json`);
        await appDirectory(root);
        if (await exists(intentPath) || await withStateMutationLock(paths, () => hasRetainedApplyIntent(paths, local.record.path))) {
          row.state = "blocked"; row.transfer = { state: "blocked", reason: "Unresolved apply intent; explicit recovery required" };
          row.apply = { state: "needs-recovery", reason: "Existing apply intent is never automatically replayed" };
          await save(); continue;
        }
        cancel();
        row.transfer = { state: "receiving" }; await save();
        // Network NEVER owns the global state lock; revocation can proceed now.
        // Core transport fixes HTTPS to GitHub, verifies TLS, rejects redirects
        // and quotes the workflow-selected gh executable with fixed helper arguments.
        // No endpoint, credentials, shell command or SSH fallback comes from sync config.
        await checkConfig();
        await checkWorkflow();
        const { executables } = workflow;
        const received = await receive({ store, branch: selected.branch,
          source: `https://${selected.canonicalRemote}.git`, githubHttps: true, githubCli: executables.githubCli,
          ...(options.signal ? { signal: options.signal } : {}) });
        if (!receipt(received, selected.branch)) throw new Error("Invalid upstream receipt");
        row.received = received; row.transfer = { state: "received" }; row.state = "received-not-applied";
        await save(); // Exact durable receipt precedes any checkout mutation.
        phase = "apply";
        await withStateMutationLock(paths, async () => {
          row.localHead = null;
          await checkConfig();
          await checkWorkflow();
          const now = await enabledLocal(paths, config, selected);
          if (now.identity !== local.identity || !same(now.record, local.record) || !same(now.entry, local.entry))
            throw new Blocked("blocked-identity", "Local registry, inventory or checkout identity changed during this pass");
          // HEAD is evidence, not part of the identity fence: ordinary user
          // commits during receive still go through the existing apply gates.
          row.localHead = now.localHead;
          cancel();
          if (await hasRetainedApplyIntent(paths, local.record.path)) {
            row.state = "blocked";
            row.apply = { state: "needs-recovery", reason: "Retained application intent; explicit recovery required" };
            return;
          }
          if (!selected.applyCleanFastForward) return;
          row.apply = { state: "applying" }; await save();
          const result = sanitizedResult(await applyReceivedFastForward({ repository: local.record.path, store,
            branch: selected.branch, oid: received.oid, intentPath, ...(options.signal ? { signal: options.signal } : {}) }));
          row.apply = { state: result.status, result };
          // Refresh after even blocked/dirty outcomes. This distinguishes dirty
          // same-HEAD work from an actual pending upstream fast-forward without
          // requiring another host to open this checkout. Keep failed identity
          // reinspection unknown rather than publishing stale evidence.
          row.localHead = null;
          try {
            const observed = await inspectLocal(paths, config.hostId, selected.canonicalRemote);
            if (observed.identity === local.identity && same(observed.record, local.record)) row.localHead = observed.localHead;
          } catch { /* Result/recovery evidence survives an unavailable checkout. */ }
          row.state = result.status.startsWith("blocked-") || result.status === "needs-recovery" ? "blocked"
            : result.status === "fast-forwarded" ? "applied" : "received-not-applied";
        });
      } catch (failure) {
        const error = phase === "transfer" && options.signal?.aborted
          ? new Blocked("blocked-cancelled", "Upstream sync cancelled; no new apply started") : failure;
        if (error instanceof Blocked) {
          row.state = "blocked";
          if (phase === "transfer") row.transfer = { state: "blocked", reason: error.message };
          row.apply = { state: error.state, reason: error.message };
        } else {
          row.state = "error";
          if (phase === "transfer") {
            row.transfer = { state: "error", error: "Upstream receive failed; check local settings and GitHub HTTPS authentication" };
            row.apply = { state: selected.applyCleanFastForward ? "blocked-transfer" : "not-requested" };
          } else row.apply = { state: "error", error: "Upstream apply failed; inspect local state before retrying" };
        }
      }
      await save();
      if (options.signal?.aborted) {
        for (const remaining of status.repositories.slice(index + 1)) {
          remaining.state = "blocked"; remaining.transfer = { state: "blocked", reason: "Upstream sync cancelled before transfer" };
          remaining.apply = { state: "blocked-cancelled", reason: "Upstream sync cancelled; no new apply started" };
        }
        break;
      }
    }
    status.completedAt = new Date().toISOString(); await save();
    return status;
  });
}
