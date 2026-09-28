import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./config.js";
import { verifiedWorkflowPeerSshArgv } from "./direct-sync-service.js";
import { gitReadEnvironment, OID_PATTERN } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { recordIncident } from "./incidents.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import { pathExists, writeJsonAtomic } from "./storage.js";
import { loadUpstreamSyncConfig, upstreamSyncStatus, type UpstreamSyncConfig, type UpstreamSyncStatus } from "./upstream-sync-service.js";

// Selection comes from upstream config, never the direct-peer allowlist,
// signed registry, inventory, or a checkout on the primary.
const MAX_ROWS = 100, MAX_RESPONSE = 512 * 1024, MAX_STATE = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && v.trim() === v && Number.isFinite(Date.parse(v));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const host = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/.test(v);
const remote = (v: unknown): v is string => typeof v === "string" && v.trim() === v &&
  /^github\.com\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(v) &&
  !v.split("/")[1]!.includes("--") && ![".", ".."].includes(v.split("/")[2]!) && !v.endsWith(".git");
const branch = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(v) &&
  !v.includes("..") && !v.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"));
const APPLY = new Set("not-requested pending applying blocked-transfer up-to-date fast-forwarded local-ahead blocked-dirty blocked-diverged blocked-branch needs-recovery error blocked-disabled blocked-legacy-attempt blocked-identity blocked-settings-changed blocked-cancelled".split(" "));
const TRANSFER = new Set("pending receiving received blocked error".split(" "));
const ROW = new Set("pending received-not-applied applied blocked error".split(" "));
const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
const invalid = () => new Error("Invalid upstream attention evidence");

// All disk inputs are bounded owner-0600 regular files. Never follow a symlink
// or block opening a FIFO; check the named file and descriptor for replacement.
async function source(file: string, max: number): Promise<unknown> {
  let fd;
  try { fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw invalid(); }
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() ||
        (before.mode & 0o7777) !== 0o600 || before.size > max) throw invalid();
    const buffer = Buffer.alloc(max + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await fd.stat(), named = await lstat(file);
    const fingerprint = (s: typeof before) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
    if (size > max || size !== before.size || named.isSymbolicLink() ||
        fingerprint(before) !== fingerprint(after) || fingerprint(after) !== fingerprint(named)) throw invalid();
    return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
  } catch { throw invalid(); } finally { await fd.close(); }
}
function configProjection(v: unknown, expectedHost: string): UpstreamSyncConfig | null {
  if (v === null) return null;
  if (!object(v) || v.schemaVersion !== 1 || v.hostId !== expectedHost || !host(v.hostId) ||
      !Number.isInteger(v.intervalSeconds) || (v.intervalSeconds as number) < 30 || (v.intervalSeconds as number) > 900 ||
      !Array.isArray(v.repositories) || v.repositories.length > MAX_ROWS) throw invalid();
  const seen = new Set<string>();
  return { schemaVersion: 1, hostId: v.hostId, intervalSeconds: v.intervalSeconds as number,
    repositories: v.repositories.map(r => {
      if (!object(r) || !remote(r.canonicalRemote) || !branch(r.branch) || seen.has(r.canonicalRemote) ||
          typeof r.enabled !== "boolean" || typeof r.applyCleanFastForward !== "boolean") throw invalid();
      seen.add(r.canonicalRemote);
      return { canonicalRemote: r.canonicalRemote, branch: r.branch, enabled: r.enabled, applyCleanFastForward: r.applyCleanFastForward };
    }) };
}
export interface UpstreamAttentionRow { canonicalRemote: string; branch: string; state: string; transfer: string; apply: string; head: string | null; oid: string | null }
type Row = UpstreamAttentionRow;
interface Snapshot { config: UpstreamSyncConfig | null; status: { startedAt: string; completedAt: string | null; rows: Row[] } | null }
export interface UpstreamSyncSourceInspection extends Snapshot {
  hostId: string | null; available: boolean; error: string | null; cached: true; cachedOnly: true; live: false;
  /** Age of cached completed status only; never evidence of current checkout state. */
  fresh: boolean;
}
export interface UpstreamSyncSourcesInspection {
  observedAt: string; cached: true; cachedOnly: true; live: false;
  local: UpstreamSyncSourceInspection; peer: UpstreamSyncSourceInspection;
}
type Options = { signal?: AbortSignal };

function optionalOid(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || ![40, 64].includes(v.length) || !OID_PATTERN.test(v)) throw invalid();
  return v;
}
// Deliberately project only classification and validated identity/OIDs. Error
// messages, paths, peerHostId, config extras and result bodies never persist.
function snapshot(config: unknown, status: unknown, expectedHost: string): Snapshot {
  const c = configProjection(config, expectedHost);
  if (status === null) return { config: c, status: null };
  if (!object(status) || status.mode !== "upstream" || status.hostId !== expectedHost || !date(status.startedAt) ||
      (status.completedAt !== null && (!date(status.completedAt) || Date.parse(status.completedAt) < Date.parse(status.startedAt))) ||
      !Array.isArray(status.repositories) || status.repositories.length > MAX_ROWS) throw invalid();
  const seen = new Set<string>();
  const rows = status.repositories.map((r): Row => {
    if (!object(r) || !remote(r.canonicalRemote) || !branch(r.branch) || seen.has(r.canonicalRemote) ||
        typeof r.state !== "string" || !ROW.has(r.state) || !object(r.transfer) || typeof r.transfer.state !== "string" ||
        !TRANSFER.has(r.transfer.state) || !object(r.apply) || typeof r.apply.state !== "string" || !APPLY.has(r.apply.state)) throw invalid();
    seen.add(r.canonicalRemote);
    if (r.received !== undefined && (!object(r.received) || r.received.branch !== r.branch)) throw invalid();
    if (r.apply.result !== undefined && !object(r.apply.result)) throw invalid();
    const resultHead = object(r.apply.result) && r.apply.result.status === r.apply.state &&
      ["up-to-date", "fast-forwarded", "local-ahead"].includes(r.apply.state) ? optionalOid(r.apply.result.head) : null;
    // Explicit null is current unknown evidence, not permission to borrow a
    // cached result HEAD. Legacy blocked-dirty results never carried a HEAD.
    const head = Object.hasOwn(r, "localHead") ? optionalOid(r.localHead) : resultHead;
    return { canonicalRemote: r.canonicalRemote, branch: r.branch, state: r.state, transfer: r.transfer.state, apply: r.apply.state,
      head, oid: object(r.received) ? optionalOid(r.received.oid) : null };
  });
  return { config: c, status: { startedAt: status.startedAt, completedAt: status.completedAt, rows } };
}
interface Dependencies {
  identity: typeof loadHostIdentity;
  primary: (paths: AppPaths) => Promise<{ primaryHostId: string; configuredHostId: string; requiredHostIds: readonly string[] } | null>;
  workflow: typeof loadWorkflowConfig;
  config: (paths: AppPaths) => Promise<unknown>;
  status: (paths: AppPaths) => Promise<unknown>;
  peer: typeof verifiedWorkflowPeerSshArgv;
  run: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number;
    killSignal: "SIGKILL"; maxBuffer: number; encoding: "utf8"; signal?: AbortSignal }) => Promise<string>;
  now: () => number;
}
// execFile's abort callback may fire before child close. Record the callback
// outcome but settle only after close, so scheduler shutdown retains ownership
// until the fixed SSH child (killed with SIGKILL) has actually been reaped.
const closeRunner = (execute: typeof execFile): Dependencies["run"] => (file, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(invalid()); return; }
  let failure: Error | null = null, output = "";
  const child = execute(file, args, options, (error, stdout) => { failure = error; output = stdout; });
  child.once("close", () => { if (failure) reject(invalid()); else resolve(output); });
});
const production: Dependencies = {
  identity: loadHostIdentity,
  primary: async paths => {
    const [workflow, own] = await Promise.all([loadWorkflowConfig(paths), loadHostIdentity(paths)]);
    return { primaryHostId: workflow.primaryHostId, configuredHostId: own.id, requiredHostIds: [own.id, ...Object.keys(workflow.peers)] };
  },
  workflow: loadWorkflowConfig,
  config: loadUpstreamSyncConfig, status: upstreamSyncStatus,
  peer: verifiedWorkflowPeerSshArgv,
  run: closeRunner(execFile),
  now: Date.now,
};
function fresh(s: Snapshot | null | undefined, now: number): boolean {
  if (!s?.config || !s.status?.completedAt) return false;
  const age = now - Date.parse(s.status.completedAt);
  return age >= -5_000 && age <= Math.max(180_000, s.config.intervalSeconds * 2_000);
}
function unavailable(hostId: string | null, error: string): UpstreamSyncSourceInspection {
  return { hostId, available: false, error, cached: true, cachedOnly: true, live: false, fresh: false, config: null, status: null };
}
function available(hostId: string, s: Snapshot, deps: Dependencies): UpstreamSyncSourceInspection {
  return { ...s, hostId, available: true, error: null, cached: true, cachedOnly: true, live: false, fresh: fresh(s, deps.now()) };
}
async function localSnapshot(paths: AppPaths, id: string, status: UpstreamSyncStatus | null | undefined, deps: Dependencies) {
  if (!host(id)) throw invalid();
  return snapshot(await deps.config(paths), status === undefined ? await deps.status(paths) : status, id);
}
async function peerSnapshot(paths: AppPaths, localId: string, deps: Dependencies, options: Options,
  members?: readonly string[]): Promise<UpstreamSyncSourceInspection> {
  let peerId: string | null = null;
  try {
    if (options.signal?.aborted) throw invalid();
    // Diagnostic membership is independent of direct-sync enrollment. A
    // central Guardian can observe a peer that only has upstream repositories.
    const workflow = await deps.workflow(paths), peers = Object.keys(workflow.peers);
    if (peers.length !== 1) throw invalid();
    peerId = peers[0]!;
    if (peerId === localId || !host(peerId) || (members && !members.includes(peerId))) throw invalid();
    const peer = workflow.peers[peerId];
    if (!peer || options.signal?.aborted) throw invalid();
    const ssh = await deps.peer(paths, peerId);
    if (options.signal?.aborted) throw invalid();
    const text = await deps.run(ssh.executable, [...ssh.args, [peer.nodeExecutable, peer.cliEntrypoint, "sync", "upstream", "status"].map(shellQuote).join(" ")], {
      env: gitReadEnvironment(), cwd: "/", timeout: 25_000, killSignal: "SIGKILL", maxBuffer: MAX_RESPONSE / 2, encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.signal?.aborted || Buffer.byteLength(text) > MAX_RESPONSE) throw invalid();
    const v: unknown = JSON.parse(text);
    if (!object(v) || !Object.hasOwn(v, "config") || !Object.hasOwn(v, "status")) throw invalid();
    return available(peerId, snapshot(v.config, v.status, peerId), deps);
  } catch { return unavailable(peerId, "Peer upstream status unavailable"); }
}
async function inspect(paths: AppPaths, deps: Dependencies, options: Options = {}): Promise<UpstreamSyncSourcesInspection> {
  const result: UpstreamSyncSourcesInspection = { observedAt: new Date(deps.now()).toISOString(), cached: true, cachedOnly: true, live: false,
    local: unavailable(null, "Local upstream status unavailable"), peer: unavailable(null, "Peer upstream status unavailable") };
  if (options.signal?.aborted) return result;
  let id: string;
  try { id = (await deps.identity(paths)).id; if (!host(id)) return result; }
  catch { return result; }
  result.local.hostId = id;
  try { result.local = available(id, await localSnapshot(paths, id, undefined, deps), deps); } catch { /* fixed error only */ }
  result.peer = await peerSnapshot(paths, id, deps, options);
  return result;
}
/** Read-only cached evidence on either host; never inspects a checkout, takes
 * a mutation lock, records an incident, or loads signed registry authority. */
export function inspectUpstreamSyncSources(paths: AppPaths, options: Options = {}): Promise<UpstreamSyncSourcesInspection> {
  return inspect(paths, production, options);
}
type Result = { created: number; peerUnavailable?: true };
type Reservation = { id: string; summary: string; occurredAt: string };
type Counted = { pass: string; completed: string; reason: string; count: number; incident: Reservation | null };
type State = Record<string, Counted>;
const REASONS = new Set([...APPLY, "repeated-error", "blocked-transfer", "blocked", "quiet"]);
function stateProjection(v: unknown): State {
  if (v === null) return {};
  if (!object(v) || Object.keys(v).length > 2 * MAX_ROWS) throw invalid();
  for (const [key, row] of Object.entries(v)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}(?![\s\S])/.test(key) || !object(row) ||
        Object.keys(row).sort().join(",") !== "completed,count,incident,pass,reason" || !date(row.pass) || !date(row.completed) ||
        Date.parse(row.completed) < Date.parse(row.pass) || typeof row.reason !== "string" || !REASONS.has(row.reason) ||
        !Number.isInteger(row.count) || (row.count as number) < 0 || (row.count as number) > 3) throw invalid();
    const i = row.incident;
    if (i !== null && (!object(i) || Object.keys(i).sort().join(",") !== "id,occurredAt,summary" ||
        typeof i.id !== "string" || !/^inc-[a-f0-9-]{36}(?![\s\S])/.test(i.id) || !date(i.occurredAt) ||
        typeof i.summary !== "string" || !i.summary || i.summary.length > 500 || /[\r\n\0]/.test(i.summary))) throw invalid();
  }
  return v as State;
}
const keyFor = (id: string, r: { canonicalRemote: string; branch: string }) => `${id}:${hash(JSON.stringify([r.canonicalRemote, r.branch]))}`;
function reasonFor(r: Row): string {
  // Intentional registry disable/cancellation is not a transport failure, even
  // when the upstream config still selects the row or old error evidence exists.
  if (r.apply === "blocked-disabled" || r.apply === "blocked-cancelled") return "quiet";
  if (r.apply === "blocked-diverged" || r.apply === "needs-recovery") return r.apply;
  if (r.state === "error" || r.transfer === "error" || r.apply === "error") return "repeated-error";
  if (r.transfer === "blocked") return "blocked-transfer";
  // Pull-only local-ahead is expected, never a request to auto-push.
  if (["local-ahead", "up-to-date", "fast-forwarded"].includes(r.apply)) return "quiet";
  if (r.apply === "blocked-dirty" && r.head !== null && r.head === r.oid && r.transfer === "received") return "quiet";
  if (r.apply.startsWith("blocked-")) return r.apply;
  return r.state === "blocked" ? "blocked" : "quiet";
}
function summary(sourceName: string, id: string, r: Row, reason: string): string {
  // Journal summaries have a 500-character limit. Long identifiers are visibly
  // abbreviated; the owner status command retains the complete selection.
  const short = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 3)}...`;
  const owner = short(id, 32);
  return `Upstream ${sourceName} host=${owner} GitHub=${short(r.canonicalRemote, 80)} branch=${short(r.branch, 48)} ` +
    `reason=${reason} HEAD=${r.head ?? "unknown"} OID=${r.oid ?? "unknown"}. ` +
    `Run sync upstream status on ${owner}; dirty alone is not a merge-conflict claim.`;
}
async function record(paths: AppPaths, localStatus: UpstreamSyncStatus | null | undefined, deps: Dependencies,
  options: Options = {}): Promise<Result> {
  if (options.signal?.aborted) return { created: 0 };
  const identity = await deps.identity(paths), primary = await deps.primary(paths);
  if (!primary || identity.id !== primary.primaryHostId || identity.id !== primary.configuredHostId || !host(identity.id)) return { created: 0 };
  const local = await localSnapshot(paths, identity.id, localStatus, deps);
  const peer = await peerSnapshot(paths, identity.id, deps, options, primary.requiredHostIds);
  const peerUnavailable = !peer.available;
  if (options.signal?.aborted) return { created: 0, peerUnavailable: true };
  return withOwnedLocalLock(join(paths.stateDirectory, "upstream-sync-attention.lock"), "Upstream attention", async () => {
    const file = join(paths.stateDirectory, "upstream-sync-attention.json");
    const state = stateProjection(await source(file, MAX_STATE));
    let created = 0;
    for (const [name, observation] of [["localupstream", local], ["peerGithub", peer]] as const) {
      const c = observation?.config, s = observation?.status;
      if (!c || !s || !s.completedAt) continue;
      // Allow clock skew of five seconds and slower (up to 900s) configured
      // schedules. Cached/incomplete/future observations never advance counters.
      if (!fresh(observation, deps.now())) continue;
      const selected = new Set(c.repositories.filter(r => r.enabled).map(r => keyFor(c.hostId, r)));
      for (const key of Object.keys(state)) if (key.startsWith(`${c.hostId}:`) && !selected.has(key)) delete state[key];
      for (const row of s.rows) {
        const key = keyFor(c.hostId, row);
        if (!selected.has(key)) continue;
        const previous = state[key];
        // Both the pass identity and completion must advance. A rewritten
        // completion timestamp for the same run is not a new completed pass.
        const replay = previous && (Date.parse(s.startedAt) <= Date.parse(previous.pass) ||
          Date.parse(s.completedAt) <= Date.parse(previous.completed) || Date.parse(s.startedAt) < Date.parse(previous.completed));
        let entry = previous;
        if (!replay) {
          const reason = reasonFor(row), same = previous?.reason === reason;
          entry = { pass: s.startedAt, completed: s.completedAt, reason,
            count: reason === "quiet" ? 0 : Math.min(3, same ? previous.count + 1 : 1),
            incident: same ? previous.incident : null };
          state[key] = entry;
        }
        if (!entry || entry.reason === "quiet" ||
            (entry.count < 3 && !["blocked-diverged", "needs-recovery"].includes(entry.reason))) continue;
        // Persist the original sanitized payload with its reserved ID. OID/error
        // churn cannot reset a prolonged episode or create an alarm storm, and
        // a crash between reservation/journal writes retries identical evidence.
        if (!entry.incident) {
          if (replay) continue;
          entry.incident = { id: `inc-${randomUUID()}`, summary: summary(name, c.hostId, row, entry.reason), occurredAt: s.completedAt };
          await writeJsonAtomic(file, state);
        }
        const i = entry.incident;
        const existed = await pathExists(join(paths.incidentDirectory, `${i.id}.json`));
        await recordIncident(paths, { incidentId: i.id, incidentType: "sync.attention", severity: "yellow",
          reasonCode: entry.reason, summary: i.summary }, new Date(i.occurredAt));
        if (!existed) created++;
      }
    }
    await writeJsonAtomic(file, state);
    return { created, ...(peerUnavailable ? { peerUnavailable: true as const } : {}) };
  });
}
/** Journal only, primary Guardian only. The scheduler owns dispatch. No remote
 * checkout reads, arbitrary commands, notifications, or synchronization writes. */
export function recordUpstreamSyncAttention(paths: AppPaths, localStatus?: UpstreamSyncStatus | null,
  options: Options = {}): Promise<Result> {
  return record(paths, localStatus, production, options);
}
/** Offline-only seam; never wired to CLI arguments or environment overrides. */
export const __upstreamAttentionForTests = { record, inspect, closeRunner };
