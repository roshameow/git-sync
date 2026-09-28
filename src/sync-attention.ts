import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./config.js";
import { loadDirectSyncConfig, type DirectSyncStatus } from "./direct-sync-service.js";
import { runGitRead as fixedGit, OID_PATTERN } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { recordIncident } from "./incidents.js";
import { inventoryPath } from "./inventory.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { normalizeRemote } from "./remote.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import { pathExists, writeJsonAtomic, type Validator } from "./storage.js";
import type { RepositoryRecord } from "./types.js";
import { isDesiredRegistry, isHostInventory } from "./validation.js";

type Counted = { pass: string; fingerprint: string; count: number; incidentId: string | null };
type AttentionState = Record<string, Counted>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const isState: Validator<AttentionState> = (v): v is AttentionState => object(v) && Object.keys(v).length <= 100 &&
  Object.entries(v).every(([key, row]) => /^[a-f0-9]{64}$/.test(key) && object(row) &&
    Object.keys(row).sort().join(",") === "count,fingerprint,incidentId,pass" && date(row.pass) &&
    typeof row.fingerprint === "string" && /^[a-f0-9]{64}$/.test(row.fingerprint) &&
    Number.isInteger(row.count) && (row.count as number) >= 0 && (row.count as number) <= 3 &&
    (row.incidentId === null || typeof row.incidentId === "string" && /^inc-[a-f0-9-]{36}$/.test(row.incidentId)));

// Bound app-owned sources before parsing; never follow symlinks or block on FIFOs.
async function source<T>(path: string, max: number, valid: Validator<T>): Promise<T | null> {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > max)
      throw new Error("Unsafe sync attention source");
    const b = Buffer.alloc(max + 1); let size = 0;
    while (size < b.length) {
      const { bytesRead } = await fd.read(b, size, b.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > max) throw new Error("Oversized sync attention source");
    const v: unknown = JSON.parse(b.subarray(0, size).toString("utf8"));
    if (!valid(v)) throw new Error("Invalid sync attention source");
    return v;
  } finally { await fd.close(); }
}

/** Only identity/config and HEAD reads: never status, hashing worktree files,
 * filters, hooks, SSH, or Git writes. Unknown HEAD is not equality evidence. */
async function head(record: RepositoryRecord, localPath: string): Promise<string | null> {
  try {
    if (record.path !== localPath) return null;
    const path = record.path, root = await lstat(path), marker = await lstat(join(path, ".git"));
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(path) !== path || marker.isSymbolicLink() ||
        (marker.isDirectory() ? "directory" : marker.isFile() ? "file" : "invalid") !== record.gitMarker || !record.remoteName) return null;
    if ((await fixedGit(path, ["rev-parse", "--show-toplevel"])).trim() !== path ||
        normalizeRemote((await fixedGit(path, ["config", "--get", `remote.${record.remoteName}.url`])).trim(), path) !== record.canonicalRemote)
      return null;
    const oid = (await fixedGit(path, ["rev-parse", "--verify", "HEAD"])).trim();
    return OID_PATTERN.test(oid) ? oid : null;
  } catch { return null; }
}

/** Journal only. Main owns scheduling and the existing Guardian sender. */
export async function recordSyncAttention(paths: AppPaths, status: DirectSyncStatus): Promise<{ created: number }> {
  if (status.completedAt === null) return { created: 0 };
  const identity = await loadHostIdentity(paths);
  const transport = await loadWorkflowConfig(paths);
  if (identity.id !== transport.primaryHostId) return { created: 0 };
  if (status.mode !== "direct-peer" || !date(status.startedAt) || !date(status.completedAt) ||
      Date.parse(status.completedAt) < Date.parse(status.startedAt) || status.repositories.length > 100)
    throw new Error("Invalid completed sync attention pass");
  const completedAt = status.completedAt;
  const config = await loadDirectSyncConfig(paths);
  if (!config || config.hostId !== identity.id) return { created: 0 };
  return withOwnedLocalLock(join(paths.stateDirectory, "sync-attention.lock"), "Sync attention", async () => {
    const file = join(paths.stateDirectory, "sync-attention.json");
    const state = await source(file, 64 * 1024, isState) ?? {};
    const enabled = new Set(config.repositories.filter(r => r.enabled).map(r => hash(r.canonicalRemote)));
    for (const key of Object.keys(state)) if (!enabled.has(key)) delete state[key];
    const inventory = await source(inventoryPath(paths, identity.id), 2 * 1024 * 1024, isHostInventory);
    const registry = await source(paths.registryFile, 2 * 1024 * 1024, isDesiredRegistry);
    if (inventory && inventory.hostId !== identity.id) throw new Error("Sync attention inventory host differs");
    let created = 0;
    const seen = new Set<string>();
    for (const row of status.repositories) {
      if (seen.has(row.canonicalRemote)) throw new Error("Duplicate sync attention repository");
      seen.add(row.canonicalRemote);
      const selected = config.repositories.find(r => r.canonicalRemote === row.canonicalRemote && r.branch === row.branch);
      if (!selected?.enabled || row.peerHostId !== config.peerHostId || registry?.repositories[row.canonicalRemote]?.mode !== "enabled") continue;
      const key = hash(row.canonicalRemote), previous = state[key];
      // A re-read (including after restart) is not another completed pass.
      if (previous && Date.parse(status.startedAt) < Date.parse(previous.pass)) continue;
      const result = row.apply.result;
      const received = row.received?.oid ?? null;
      if (received !== null && !OID_PATTERN.test(received)) throw new Error("Invalid attention input OID");
      const immediate = row.apply.state === "blocked-diverged" || row.apply.state === "needs-recovery";
      const error = row.state === "error" || row.transfer.state === "error" || row.apply.state === "error";
      const prolonged = row.apply.state === "local-ahead" || row.apply.state === "blocked-dirty";
      const records = inventory?.repositories.filter(r => r.canonicalRemote === row.canonicalRemote) ?? [];
      const localHead = result && "head" in result && OID_PATTERN.test(result.head) ? result.head
        : (immediate || error || prolonged) && records.length === 1 ? await head(records[0]!, selected.localPath) : null;
      const normalDirty = !error && row.transfer.state === "received" && row.apply.state === "blocked-dirty" && localHead !== null && localHead === received;
      const active = !normalDirty && (immediate || error || prolonged);
      // Error bodies and pass/receive times churn (and may contain secrets).
      // Only stable input identities and classified reasons define an episode.
      const reason = immediate ? row.apply.state : error ? "repeated-error" : prolonged ? row.apply.state : "quiet";
      const fingerprint = hash(JSON.stringify([row.branch, row.peerHostId, active ? reason : "quiet", localHead, received]));
      const same = previous?.fingerprint === fingerprint;
      if (previous?.pass === status.startedAt && !same) continue;
      const count = active ? Math.min(3, same ? previous.count + (previous.pass === status.startedAt ? 0 : 1) : 1) : 0;
      const entry: Counted = { pass: status.startedAt, fingerprint, count, incidentId: same ? previous.incidentId : null };
      state[key] = entry;
      if (!active || (!immediate && count < 3)) continue;
      // Include the full selector once, in the command, so public repository
      // names and SHA-256 OIDs fit the journal's 500-character summary limit.
      const summary = `Sync attention: reason=${reason}; HEAD=${localHead ?? "unknown"}; receivedOID=${received ?? "unknown"}. ` +
        `${immediate ? "Check recorded block" : "Check prolonged state; not a conflict claim"}. Run git-sync guardian inspect ${row.canonicalRemote} and git-sync provenance show.`;
      if (summary.length > 500) throw new Error("Sync attention summary exceeds bound");
      // Reserve first so a restart retries the same journal ID, including when
      // acknowledged. Never overwrite the original incident or its timestamp.
      entry.incidentId ??= `inc-${randomUUID()}`;
      await writeJsonAtomic(file, state);
      const existed = await pathExists(join(paths.incidentDirectory, `${entry.incidentId}.json`));
      await recordIncident(paths, { incidentId: entry.incidentId, incidentType: "sync.attention", severity: "yellow",
        reasonCode: reason, summary }, new Date(completedAt));
      if (!existed) created++;
    }
    await writeJsonAtomic(file, state);
    return { created };
  });
}
