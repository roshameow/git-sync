import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { resolveAppPaths, type AppPaths } from "./config.js";
import { loadWorkflowConfig, workflowPeer, isWorkflowHostId, isWorkflowPath, type WorkflowPeer } from "./workflow-config.js";
import { normalizeRemote } from "./remote.js";
import type { RegistryEntry, RepositoryRecord } from "./types.js";
import { loadHostIdentity } from "./host.js";
import { loadHostInventory } from "./inventory.js";
import { loadRegistry } from "./registry.js";
import { inspectRepositoryPath } from "./discovery.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { withStateMutationLock } from "./state-mutation.js";
import { writeJsonAtomic } from "./storage.js";
import { receiveCommittedBranch, type DirectSyncResult } from "./direct-sync.js";
import { applyReceivedFastForward } from "./direct-sync-apply.js";
import { loadUpstreamSyncConfig } from "./upstream-sync-service.js";
import { hasRetainedApplyIntent } from "./sync-apply-intents.js";

/** Explicit direct-peer authority, independent of expired publication policies.
 * No implicit apply opt-in or upstream transport authority. */
export interface DirectSyncConfig {
  schemaVersion: 1;
  hostId: string;
  peerHostId: string;
  applyCleanFastForward: boolean;
  intervalSeconds: number;
  repositories: DirectSyncRepositoryConfig[];
}
export type DirectSyncRepositoryConfig = {
  canonicalRemote: string; localPath: string; peerPath: string; branch: string;
} & ({ enabled: true; reason?: string } | { enabled: false; reason: string });
type ApplyResult = Awaited<ReturnType<typeof applyReceivedFastForward>>;
type BlockedState = "blocked-disabled" | "blocked-identity" | "blocked-settings-changed" | "blocked-cancelled";
export interface DirectSyncRunOptions { readonly signal?: AbortSignal }
export interface DirectSyncRepositoryStatus {
  canonicalRemote: string;
  branch: string;
  /** Absent only when displaying legacy transfer-only status. */
  peerHostId?: DirectSyncConfig["peerHostId"];
  state: "pending" | "received-not-applied" | "applied" | "blocked" | "error";
  transfer: { state: "pending" | "receiving" | "received" | "blocked" | "error"; reason?: string; error?: string };
  apply: { state: "not-requested" | "pending" | "applying" | "blocked-transfer" | BlockedState |
    "up-to-date" | "fast-forwarded" | "local-ahead" | "blocked-dirty" | "blocked-diverged" |
    "blocked-branch" | "needs-recovery" | "error"; reason?: string; error?: string; result?: ApplyResult };
  /** Last successful receive, retained while retrying, blocked, or offline.
   * Inspect transfer.state to distinguish this evidence from a fresh receive. */
  received?: DirectSyncResult;
}
export interface DirectSyncStatus {
  mode: "direct-peer";
  startedAt: string;
  completedAt: string | null;
  repositories: DirectSyncRepositoryStatus[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function canonicalNetworkRemote(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  // Require a network host and at least namespace/repository; no URL credentials,
  // queries, escaped separators, dot segments, or normalization ambiguity.
  const [host, ...parts] = value.split("/");
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?$/.test(host) || parts.length < 2 ||
    parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) return false;
  try { return normalizeRemote(`https://${value}`) === value; } catch { return false; }
}
function fingerprint(st: Stats): string {
  return [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(":");
}
/** Bounded descriptor read: reject links/FIFOs, check owner/mode and both path
 * and descriptor before/after. Never allocate based on an untrusted st.size. */
async function ownerText(file: string, max: number, privateMode = true): Promise<{ text: string; identity: string }> {
  const check = (st: Stats) => {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (privateMode ? (st.mode & 0o7777) !== 0o600 : (st.mode & 0o022) !== 0) || st.size > max)
      throw new Error("Unsafe direct sync settings or evidence file");
  };
  const before = await lstat(file); check(before);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await fd.stat(); check(initial);
    if (fingerprint(initial) !== fingerprint(before)) throw new Error("Direct sync file changed during open");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > max) throw new Error("Direct sync file exceeds size bound");
    const after = await fd.stat(), named = await lstat(file); check(after); check(named);
    if (fingerprint(initial) !== fingerprint(after) || fingerprint(after) !== fingerprint(named))
      throw new Error("Direct sync file changed during read");
    return { text: buffer.subarray(0, size).toString("utf8"), identity: fingerprint(after) };
  } finally { await fd.close(); }
}
function parseConfig(text: string): DirectSyncConfig {
  const c: unknown = JSON.parse(text);
  if (!isObject(c) || c.schemaVersion !== 1 || !isWorkflowHostId(c.hostId) ||
    !isWorkflowHostId(c.peerHostId) || c.hostId === c.peerHostId ||
    typeof c.applyCleanFastForward !== "boolean" ||
    !Number.isInteger(c.intervalSeconds) ||
    (c.intervalSeconds as number) < 30 || (c.intervalSeconds as number) > 900 ||
    !Array.isArray(c.repositories) || c.repositories.length < 1 || c.repositories.length > 100)
    throw new Error("Invalid direct sync config (explicit applyCleanFastForward and intervalSeconds 30..900 required)");
  const seen = new Set<string>();
  for (const r of c.repositories) {
    if (!isObject(r) || !canonicalNetworkRemote(r.canonicalRemote) || seen.has(r.canonicalRemote) ||
      !isWorkflowPath(r.peerPath) || !isWorkflowPath(r.localPath) ||
      typeof r.enabled !== "boolean" || (r.enabled === false && (typeof r.reason !== "string" || !r.reason.trim())) ||
      (r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > 300 || /[\r\n\0]/.test(r.reason))) ||
      typeof r.branch !== "string" || r.branch.trim() !== r.branch || r.branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(r.branch) ||
      r.branch.includes("..") || r.branch.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock")))
      throw new Error("Invalid direct sync repository selection or peer path binding");
    seen.add(r.canonicalRemote);
  }
  return c as unknown as DirectSyncConfig;
}
async function configSnapshot(paths: AppPaths) {
  try {
    const snapshot = await ownerText(join(paths.stateDirectory, "direct-sync.json"), 2 * 1024 * 1024);
    return { ...snapshot, config: parseConfig(snapshot.text) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function loadDirectSyncConfig(paths: AppPaths): Promise<DirectSyncConfig | null> {
  return (await configSnapshot(paths))?.config ?? null;
}
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
async function pinnedSsh(peer: WorkflowPeer): Promise<{ executable: string; args: string[] }> {
  const { text } = await ownerText(peer.knownHosts, 256 * 1024, false);
  // Only exact normal entries establish the pin: hashed/wildcard/CA entries
  // cannot prove the configured host-to-key binding.
  const rows = text.split("\n").map(line => line.trim().split(/\s+/)).filter(parts =>
    parts[0]?.toLowerCase().split(",").includes(peer.host.toLowerCase()));
  const keys = rows.filter(parts => parts[1] === "ssh-ed25519");
  if (keys.length !== 1) throw new Error("Missing or ambiguous pinned SSH peer");
  const key = keys[0]![2] ?? "", bytes = Buffer.from(key, "base64");
  // Validate the SSH wire-format ed25519 blob as well as its digest.
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32 || bytes.toString("base64") !== key ||
    `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}` !== peer.fingerprint)
    throw new Error("SSH peer fingerprint changed or key is invalid");
  const hostsOption = `UserKnownHostsFile="${peer.knownHosts.replace(/[\\"]/g, "\\$&")}"`;
  const options = ["BatchMode=yes", "ConnectTimeout=5", "ConnectionAttempts=1", "StrictHostKeyChecking=yes",
    "HostKeyAlgorithms=ssh-ed25519", `HostKeyAlias=${peer.host.toLowerCase()}`, hostsOption,
    "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "ControlMaster=no", "ControlPath=none",
    "ProxyCommand=none", "ProxyJump=none", "ClearAllForwardings=yes"];
  return { executable: "/usr/bin/ssh", args: ["-F", "/dev/null", "-T", "-p", "22", ...options.flatMap(option => ["-o", option])] };
}
async function sshFor(c: DirectSyncConfig, paths: AppPaths = resolveAppPaths()): Promise<string> {
  const { executable, args } = await pinnedSsh(await workflowPeer(paths, c.peerHostId));
  return [executable, ...args].map(shellQuote).join(" ");
}
export const __peerSshCommandForTests = sshFor;
/** Fixed SSH policy and pinned destination, independent of repository enrollment.
 * Diagnostics need only workflow transport configuration, never direct-sync.json. */
export async function verifiedWorkflowPeerSshArgv(paths: AppPaths, peerHostId: string): Promise<{ executable: string; args: string[] }> {
  const peer = await workflowPeer(paths, peerHostId);
  const ssh = await pinnedSsh(peer);
  return { executable: ssh.executable, args: [...ssh.args, `${peer.user}@${peer.host}`] };
}
/** Direct-sync callers retain config validation before resolving transport. */
export async function verifiedPeerSshArgv(config: DirectSyncConfig, paths: AppPaths = resolveAppPaths()): Promise<{ executable: string; args: string[] }> {
  const checked = parseConfig(JSON.stringify(config));
  return verifiedWorkflowPeerSshArgv(paths, checked.peerHostId);
}
export async function directSyncStatus(paths: AppPaths): Promise<DirectSyncStatus | null> {
  try {
    const value: unknown = JSON.parse((await ownerText(join(paths.stateDirectory, "direct-sync-status.json"), 2 * 1024 * 1024)).text);
    // Read-only status is evidence, never authority for a new apply. Normalize
    // the old transfer-only schema without inventing its unrecorded peer ID.
    if (!isObject(value) || !["direct-peer", "direct-peer-commits"].includes(value.mode as string) ||
      typeof value.startedAt !== "string" || (value.completedAt !== null && typeof value.completedAt !== "string") ||
      !Array.isArray(value.repositories) || value.repositories.length > 100 ||
      value.repositories.some(r => !isObject(r) || !canonicalNetworkRemote(r.canonicalRemote) ||
        typeof r.branch !== "string" || (r.received !== undefined && (!isObject(r.received) ||
          r.received.branch !== r.branch || typeof r.received.oid !== "string" || !/^[a-f0-9]{40}$/.test(r.received.oid) ||
          typeof r.received.receivedRef !== "string" || typeof r.received.changed !== "boolean" ||
          typeof r.received.completedAt !== "string" || r.received.worktreeUpdated !== false))))
      throw new Error("Invalid direct sync status");
    if (value.mode === "direct-peer-commits") {
      return { mode: "direct-peer", startedAt: value.startedAt, completedAt: value.completedAt,
        repositories: value.repositories.map((r: Record<string, unknown>) => {
          if (r.state !== "received-not-applied" && r.state !== "error") throw new Error("Invalid legacy direct sync status");
          return { canonicalRemote: r.canonicalRemote as string, branch: r.branch as string, state: r.state,
            transfer: r.state === "error" ? { state: "error", error: typeof r.error === "string" ? r.error : "Previous transfer failed" }
              : { state: "received" }, apply: { state: "not-requested" },
            ...(r.received ? { received: r.received as unknown as DirectSyncResult } : {}) };
        }) };
    }
    if (value.repositories.some(r => !isObject(r.transfer) || !isObject(r.apply) ||
      !["pending", "receiving", "received", "blocked", "error"].includes(r.transfer.state as string) ||
      typeof r.apply.state !== "string" || !["pending", "received-not-applied", "applied", "blocked", "error"].includes(r.state as string) ||
      (r.peerHostId !== undefined && !isWorkflowHostId(r.peerHostId)))) throw new Error("Invalid direct sync status rows");
    return value as unknown as DirectSyncStatus;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
class Blocked extends Error {
  constructor(readonly state: BlockedState, reason: string) { super(reason); }
}
/** Test-only adapters replace all peer/local-checkout operations. Production's
 * entry point below has no injectable endpoint or mutation adapter. */
export interface DirectSyncTestDependencies {
  ssh: typeof sshFor;
  receive: typeof receiveCommittedBranch;
  apply: typeof applyReceivedFastForward;
  inspect: (path: string) => Promise<{ record: RepositoryRecord; identity: string }>;
}
const production: DirectSyncTestDependencies = {
  ssh: sshFor, receive: receiveCommittedBranch, apply: applyReceivedFastForward,
  inspect: async path => {
    const root = await lstat(path), marker = await lstat(join(path, ".git"));
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(path) !== path || marker.isSymbolicLink())
      throw new Blocked("blocked-identity", "Local checkout path no longer has its bound identity");
    const record = await inspectRepositoryPath(path);
    // Do not fence directory mtimes: normal user work may change them. Fence
    // replacement of the checkout and Git marker, and re-inspect remote identity.
    return { record, identity: [root.dev, root.ino, marker.dev, marker.ino].join(":") };
  },
};
function same(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => isObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : Array.isArray(value) ? value.map(stable) : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
async function enabledLocal(paths: AppPaths, config: DirectSyncConfig, selected: DirectSyncRepositoryConfig,
  deps: DirectSyncTestDependencies): Promise<{ record: RepositoryRecord; entry: RegistryEntry; identity: string }> {
  if ((await loadHostIdentity(paths)).id !== config.hostId)
    throw new Blocked("blocked-identity", "Direct sync host identity differs");
  if ((await loadUpstreamSyncConfig(paths))?.repositories.some(r => r.enabled && r.canonicalRemote === selected.canonicalRemote))
    throw new Blocked("blocked-settings-changed", "Repository cannot use peer and upstream apply policies simultaneously");
  const inventory = await loadHostInventory(paths, config.hostId), registry = await loadRegistry(paths);
  const records = inventory?.repositories.filter(r => r.canonicalRemote === selected.canonicalRemote) ?? [];
  const entry = registry.repositories[selected.canonicalRemote];
  if (entry?.mode !== "enabled") throw new Blocked("blocked-disabled", "Repository is not enabled in the local registry");
  if (records.length !== 1 || records[0]!.path !== selected.localPath)
    throw new Blocked("blocked-identity", "Local inventory must uniquely bind the configured checkout path");
  const record = records[0]!;
  let inspected: Awaited<ReturnType<DirectSyncTestDependencies["inspect"]>>;
  try { inspected = await deps.inspect(record.path); }
  catch (error) { throw new Blocked("blocked-identity", `Local checkout unavailable or unsafe: ${message(error)}`.slice(0, 300)); }
  if (!same(inspected.record, record)) throw new Blocked("blocked-identity", "Local checkout identity changed");
  return { record, entry, identity: inspected.identity };
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const message = (error: unknown) => (error instanceof Error ? error.message : "Direct sync failed").slice(0, 300);

export async function runDirectSyncOnce(paths: AppPaths, options: DirectSyncRunOptions = {}): Promise<DirectSyncStatus | null> {
  return runOnce(paths, production, options);
}
export const __runDirectSyncOnceForTests = runOnce;
async function runOnce(paths: AppPaths, deps: DirectSyncTestDependencies, options: DirectSyncRunOptions = {}): Promise<DirectSyncStatus | null> {
  const checkCancellation = () => {
    if (options.signal?.aborted) throw new Blocked("blocked-cancelled", "Direct sync cancelled; no new apply started");
  };
  const snapshot = await configSnapshot(paths);
  if (!snapshot) return null;
  const config = snapshot.config;
  if ((await loadHostIdentity(paths)).id !== config.hostId) throw new Error("Direct sync host identity differs");
  return withOwnedLocalLock(join(paths.stateDirectory, "direct-sync.lock"), "Direct peer committed history", async () => {
    const previous = await directSyncStatus(paths);
    const status: DirectSyncStatus = { mode: "direct-peer", startedAt: new Date().toISOString(), completedAt: null,
      repositories: config.repositories.map(selected => {
        const old = previous?.repositories.find(r => r.canonicalRemote === selected.canonicalRemote && r.branch === selected.branch &&
          (r.peerHostId === undefined || r.peerHostId === config.peerHostId));
        return { canonicalRemote: selected.canonicalRemote, branch: selected.branch, peerHostId: config.peerHostId,
          state: "pending", transfer: { state: "pending" }, apply: { state: config.applyCleanFastForward ? "pending" : "not-requested" },
          ...(old?.received ? { received: old.received } : {}) };
      }) };
    const save = () => writeJsonAtomic(join(paths.stateDirectory, "direct-sync-status.json"), status);
    // A restart advertises pending work but never erases last received evidence.
    await save();
    for (const [index, selected] of config.repositories.entries()) {
      if (options.signal?.aborted) {
        // Stop the pass without inspecting more checkouts or repeatedly writing
        // status. Preserve every row's last successful receive across shutdown.
        for (const remaining of status.repositories.slice(index)) {
          remaining.state = "blocked";
          remaining.transfer = { state: "blocked", reason: "Direct sync cancelled before transfer" };
          remaining.apply = { state: "blocked-cancelled", reason: "Direct sync cancelled; no new apply started" };
        }
        break;
      }
      const row = status.repositories[index]!;
      let phase: "transfer" | "apply" = "transfer";
      try {
        checkCancellation();
        if (!selected.enabled) throw new Blocked("blocked-disabled", selected.reason);
        const local = await enabledLocal(paths, config, selected, deps);
        const workflow = await loadWorkflowConfig(paths);
        if (!Object.hasOwn(workflow.peers, config.peerHostId)) throw new Error("Workflow peer is not configured");
        const peer = workflow.peers[config.peerHostId]!;
        const recheck = async () => {
          checkCancellation();
          let current: Awaited<ReturnType<typeof configSnapshot>>;
          try { current = await configSnapshot(paths); }
          catch { throw new Blocked("blocked-settings-changed", "Direct sync settings changed or became unsafe during this pass"); }
          if (!current || current.text !== snapshot.text || current.identity !== snapshot.identity)
            throw new Blocked("blocked-settings-changed", "Direct sync settings changed during this pass");
          try {
            if (!same(await loadWorkflowConfig(paths), workflow)) throw new Error("changed");
          } catch { throw new Blocked("blocked-settings-changed", "Workflow settings changed or became unsafe during this pass"); }
          const now = await enabledLocal(paths, config, selected, deps);
          if (!same(now, local)) throw new Blocked("blocked-identity", "Local mode, inventory or checkout identity changed during this pass");
        };
        const key = hash(`${config.peerHostId}:${selected.canonicalRemote}`);
        const intentPath = join(paths.stateDirectory, `direct-sync-apply-${key}.json`);
        if (await exists(intentPath) || await withStateMutationLock(paths, () => hasRetainedApplyIntent(paths, local.record.path))) {
          row.state = "blocked"; row.transfer = { state: "blocked", reason: "Unresolved apply intent; explicit recovery required" };
          row.apply = { state: "needs-recovery", reason: "Existing apply intent is never automatically replayed" };
          await save(); continue;
        }
        const sshCommand = await deps.ssh(config, paths);
        await recheck();
        const root = join(paths.stateDirectory, "direct-sync-stores");
        await mkdir(root, { mode: 0o700, recursive: true });
        const store = join(root, `${key}.git`);
        row.transfer = { state: "receiving" }; await save();
        const received = await deps.receive({ store, branch: selected.branch,
          source: `${peer.user}@${peer.host}:${selected.peerPath}`, sshCommand,
          ...(options.signal ? { signal: options.signal } : {}) });
        row.received = received; row.transfer = { state: "received" }; row.state = "received-not-applied";
        // Persist the exact transfer before any worktree mutation, including when
        // a later safety check or apply fails. Never apply a cached/offline tip.
        await save();
        if (config.applyCleanFastForward) {
          phase = "apply";
          await recheck();
          row.apply = { state: "applying" }; await save();
          const result = await withStateMutationLock(paths, async () => {
            await recheck();
            if (await hasRetainedApplyIntent(paths, local.record.path))
              return { status: "needs-recovery" as const, reason: "Retained application intent in another mode; explicit recovery required" };
            return deps.apply({ repository: local.record.path, store, branch: selected.branch, oid: received.oid, intentPath,
              ...(options.signal ? { signal: options.signal } : {}) });
          });
          row.apply = { state: result.status, result };
          row.state = result.status.startsWith("blocked-") || result.status === "needs-recovery" ? "blocked"
            : result.status === "fast-forwarded" ? "applied" : "received-not-applied";
        }
      } catch (failure) {
        const error = phase === "transfer" && options.signal?.aborted
          ? new Blocked("blocked-cancelled", "Direct sync cancelled; no new apply started") : failure;
        if (error instanceof Blocked) {
          row.state = "blocked";
          if (phase === "transfer") row.transfer = { state: "blocked", reason: error.message };
          row.apply = { state: error.state, reason: error.message };
        } else {
          row.state = "error";
          if (phase === "transfer") {
            row.transfer = { state: "error", error: message(error) };
            row.apply = { state: config.applyCleanFastForward ? "blocked-transfer" : "not-requested" };
          } else row.apply = { state: "error", error: message(error) };
        }
      }
      await save();
    }
    status.completedAt = new Date().toISOString(); await save();
    return status;
  });
}
