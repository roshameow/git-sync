import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { readGuardianRecord } from "./guardian-register.js";
import { guardianDesktopStatus } from "./guardian-desktop-status.js";
import { loadHostIdentity } from "./host.js";
import { listIncidents } from "./incidents.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import { pathExists, readJson, writeJsonAtomic, writeTextExclusive } from "./storage.js";
import type {
  GuardianDispatchReceipt,
  GuardianRoutingConfig,
  IncidentRecord,
  SessionRegistry,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SENDER_BYTES = 1024 * 1024;
const MAX_DISPATCH_PER_RUN = 100;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_OUTPUT = 256 * 1024;

export async function configureGuardianRouting(
  paths: AppPaths,
  targetSessionId: string,
  senderScript: string,
  now: Date = new Date(),
): Promise<GuardianRoutingConfig> {
  return withOwnedLocalLock(paths.guardianDispatchLockFile, "Guardian dispatch", () =>
    configureGuardianRoutingUnlocked(paths, targetSessionId, senderScript, now));
}

async function configureGuardianRoutingUnlocked(
  paths: AppPaths,
  targetSessionId: string,
  senderScript: string,
  now: Date,
): Promise<GuardianRoutingConfig> {
  if (!SESSION_ID_PATTERN.test(targetSessionId)) throw new Error("Invalid Guardian target session id");
  if (!isAbsolute(senderScript)) throw new Error("Guardian sender script path must be absolute");
  const [identity, workflow] = await Promise.all([
    loadHostIdentity(paths),
    loadWorkflowConfig(paths),
  ]);
  if (identity.id !== workflow.primaryHostId) {
    throw new Error("Guardian routing can only be configured on the fixed primary host");
  }
  const candidates = await guardianCandidates(paths);
  if (!candidates.some((candidate) => candidate.sessionId === targetSessionId)) {
    throw new Error("Guardian target must be an exact active session from guardian candidates");
  }
  const pinnedSender = await pinTrustedSender(paths, senderScript);
  let generation = 1;
  if (await pathExists(paths.guardianConfigFile)) {
    const previous = await loadGuardianConfig(paths);
    if (previous.hostId !== identity.id) throw new Error("Existing Guardian config belongs to another host");
    generation = previous.generation + 1;
  }
  const config: GuardianRoutingConfig = {
    schemaVersion: SCHEMA_VERSION,
    hostId: identity.id,
    generation,
    targetSessionId,
    itemKey: `git-sync:guardian:${identity.id}`,
    senderScript: pinnedSender.path,
    senderSha256: pinnedSender.sha256,
    configuredAt: now.toISOString(),
  };
  await writeJsonAtomic(paths.guardianConfigFile, config);
  return config;
}

export async function guardianCandidates(paths: AppPaths): Promise<Array<{
  readonly sessionId: string;
  readonly repositoryPath: string;
  readonly lastEventAt: string;
}>> {
  const [identity, workflow] = await Promise.all([loadHostIdentity(paths), loadWorkflowConfig(paths)]);
  if (identity.id !== workflow.primaryHostId) throw new Error("Guardian candidates are available only on the fixed primary host");
  const sessions = await pathExists(paths.sessionsFile)
    ? await readJson(paths.sessionsFile, isSessionRegistry) : { sessions: {} };
  const candidates = Object.values(sessions.sessions)
    .filter((entry) => entry.status === "active" && entry.hostId === identity.id)
    .map((entry) => ({
      sessionId: entry.sessionId,
      repositoryPath: entry.repositoryPath,
      lastEventAt: entry.lastEventAt,
    }));
  const desktop = await guardianDesktopStatus(paths);
  if (desktop.configured && desktop.running) {
    // The ordinary long-lived Pi need not have a bridge (or even a Git cwd).
    const previous = candidates.findIndex(entry => entry.sessionId === desktop.sessionId);
    if (previous >= 0) candidates.splice(previous, 1);
    candidates.push({ sessionId: desktop.sessionId, repositoryPath: desktop.cwd,
      lastEventAt: (await lstat(resolve(paths.stateDirectory, "guardian-desktop.json"))).mtime.toISOString() });
  }
  return candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export async function guardianStatus(paths: AppPaths): Promise<{
  readonly configured: boolean;
  readonly config: GuardianRoutingConfig | null;
  readonly ready: boolean;
  readonly primaryIdentityValid: boolean;
  readonly senderIntegrityValid: boolean;
  readonly targetSessionActive: boolean;
  readonly openIncidents: number;
  readonly dispatchedIncidents: number;
}> {
  const open = await listIncidents(paths, false);
  if (!(await pathExists(paths.guardianConfigFile))) {
    return {
      configured: false,
      config: null,
      ready: false,
      primaryIdentityValid: false,
      senderIntegrityValid: false,
      targetSessionActive: false,
      openIncidents: open.length,
      dispatchedIncidents: 0,
    };
  }
  const config = await loadGuardianConfig(paths);
  let primaryIdentityValid = true;
  let senderIntegrityValid = true;
  try { await requireCurrentPrimary(paths, config); } catch { primaryIdentityValid = false; }
  try {
    senderIntegrityValid = (await hashTrustedSender(config.senderScript)) === config.senderSha256;
  } catch {
    senderIntegrityValid = false;
  }
  const targetSessionActive = primaryIdentityValid && (await guardianCandidates(paths))
    .some((candidate) => candidate.sessionId === config.targetSessionId);
  let dispatched = 0;
  for (const { incident } of open) {
    const path = dispatchReceiptPath(paths, incident.incidentId, config.generation);
    if (await pathExists(path)) {
      const receipt = await readJson(path, isGuardianDispatchReceipt);
      assertDispatchReceipt(receipt, incident, config);
      dispatched += 1;
    }
  }
  return {
    configured: true,
    config,
    ready: primaryIdentityValid && senderIntegrityValid && targetSessionActive,
    primaryIdentityValid,
    senderIntegrityValid,
    targetSessionActive,
    openIncidents: open.length,
    dispatchedIncidents: dispatched,
  };
}

export interface GuardianIncidentFilter {
  readonly incidentTypes?: readonly IncidentRecord["incidentType"][];
}

export async function dispatchGuardianIncidents(
  paths: AppPaths,
  now: Date = new Date(),
  filter: GuardianIncidentFilter = {},
): Promise<{
  readonly configured: boolean;
  readonly attempted: number;
  readonly dispatched: number;
  readonly alreadyDispatched: number;
  readonly failed: number;
}> {
  if (!(await pathExists(paths.guardianConfigFile))) {
    return { configured: false, attempted: 0, dispatched: 0, alreadyDispatched: 0, failed: 0 };
  }
  return withOwnedLocalLock(paths.guardianDispatchLockFile, "Guardian dispatch", () =>
    dispatchGuardianIncidentsUnlocked(paths, now, filter));
}

async function dispatchGuardianIncidentsUnlocked(
  paths: AppPaths,
  now: Date,
  filter: GuardianIncidentFilter,
): Promise<{
  readonly configured: boolean;
  readonly attempted: number;
  readonly dispatched: number;
  readonly alreadyDispatched: number;
  readonly failed: number;
}> {
  if (!(await pathExists(paths.guardianConfigFile))) {
    return { configured: false, attempted: 0, dispatched: 0, alreadyDispatched: 0, failed: 0 };
  }
  const config = await loadGuardianConfig(paths);
  await requireCurrentPrimary(paths, config);
  if (!(await guardianCandidates(paths)).some((candidate) => candidate.sessionId === config.targetSessionId)) {
    throw new Error("Configured Guardian target session is not active");
  }
  if ((await hashTrustedSender(config.senderScript)) !== config.senderSha256) {
    throw new Error("Guardian sender script hash changed after configuration");
  }
  const open = (await listIncidents(paths, false))
    .filter(({ incident }) => filter.incidentTypes === undefined || filter.incidentTypes.includes(incident.incidentType))
    .slice(0, MAX_DISPATCH_PER_RUN);
  await mkdir(paths.guardianEventDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.guardianDispatchDirectory, { recursive: true, mode: 0o700 });
  let attempted = 0;
  let dispatched = 0;
  let alreadyDispatched = 0;
  let failed = 0;
  for (const { incident } of open) {
    const receiptPath = dispatchReceiptPath(paths, incident.incidentId, config.generation);
    if (await pathExists(receiptPath)) {
      const receipt = await readJson(receiptPath, isGuardianDispatchReceipt);
      assertDispatchReceipt(receipt, incident, config);
      alreadyDispatched += 1;
      continue;
    }
    attempted += 1;
    const event = guardianEvent(incident, config);
    const eventPath = resolve(paths.guardianEventDirectory, `${incident.incidentId}-g${config.generation}.json`);
    if (await pathExists(eventPath)) {
      const existing = await readJson(eventPath, isGuardianEvent);
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`Guardian event identity conflict for incident ${incident.incidentId}`);
      }
    } else {
      await writeJsonAtomic(eventPath, event);
    }
    const result = await runSender(config.senderScript, config.senderSha256, eventPath,
      (await loadWorkflowConfig(paths)).executables.python);
    let acknowledged = false;
    try { acknowledged = JSON.parse(result.stdout).ok === true; } catch { /* empty output is not delivery */ }
    if (result.code !== 0 || !acknowledged) {
      failed += 1;
      continue;
    }
    const receipt: GuardianDispatchReceipt = {
      schemaVersion: SCHEMA_VERSION,
      incidentId: incident.incidentId,
      eventId: event.eventId,
      routingGeneration: config.generation,
      targetSessionId: config.targetSessionId,
      senderSha256: config.senderSha256,
      dispatchedAt: now.toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt);
    dispatched += 1;
  }
  return { configured: true, attempted, dispatched, alreadyDispatched, failed };
}

async function requireCurrentPrimary(paths: AppPaths, config: GuardianRoutingConfig): Promise<void> {
  const [identity, workflow] = await Promise.all([loadHostIdentity(paths), loadWorkflowConfig(paths)]);
  if (identity.id !== config.hostId || identity.id !== workflow.primaryHostId) {
    throw new Error("Guardian dispatch is only allowed on the configured fixed primary host");
  }
}

async function loadGuardianConfig(paths: AppPaths): Promise<GuardianRoutingConfig> {
  const value = await readGuardianRecord(paths.guardianConfigFile);
  if (!isGuardianRoutingConfig(value)) throw new Error("Invalid Guardian routing config");
  return value;
}

async function pinTrustedSender(
  paths: AppPaths,
  sourcePath: string,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const bytes = await trustedSenderBytes(sourcePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const content = bytes.toString("utf8");
  if (!Buffer.from(content).equals(bytes)) throw new Error("Guardian sender must be UTF-8 Python source");
  await mkdir(paths.guardianSenderDirectory, { recursive: true, mode: 0o700 });
  const pinnedPath = resolve(paths.guardianSenderDirectory, `${sha256}.py`);
  if (await pathExists(pinnedPath)) {
    if ((await hashTrustedSender(pinnedPath)) !== sha256) throw new Error("Pinned Guardian sender content is corrupted");
  } else {
    await writeTextExclusive(pinnedPath, content);
    await chmod(pinnedPath, 0o700);
  }
  return { path: pinnedPath, sha256 };
}

async function hashTrustedSender(path: string): Promise<string> {
  return createHash("sha256").update(await trustedSenderBytes(path)).digest("hex");
}

async function trustedSenderBytes(path: string): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    const safe = (s: typeof st) => s.isFile() && s.nlink === 1 && s.uid === process.getuid?.() &&
      s.size > 0 && s.size <= MAX_SENDER_BYTES && (s.mode & 0o111) !== 0 && (s.mode & 0o7022) === 0;
    const identity = (s: typeof st) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
    if (!safe(st)) throw new Error("Guardian sender must be an owner-controlled bounded executable regular file");
    const b = Buffer.alloc(MAX_SENDER_BYTES + 1); let size = 0;
    while (size < b.length) {
      const { bytesRead } = await fd.read(b, size, b.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await fd.stat(), named = await lstat(path);
    if (!safe(after) || !safe(named) || named.isSymbolicLink() || size !== st.size ||
        identity(st) !== identity(after) || identity(after) !== identity(named)) throw new Error("Guardian sender changed during read");
    return b.subarray(0, size);
  } finally { await fd.close(); }
}

function guardianEvent(incident: IncidentRecord, config: GuardianRoutingConfig) {
  return {
    schemaVersion: 1 as const,
    eventId: `git-sync:${incident.incidentId}:g${config.generation}`,
    producer: "git-sync-daemon" as const,
    occurredAt: incident.occurredAt,
    expiresAt: new Date(Date.parse(incident.occurredAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
    itemKey: config.itemKey,
    target: { sessionId: config.targetSessionId },
    eventType: incident.incidentType,
    level: incident.severity,
    message: `${incident.summary}. Re-read authoritative state with: git-sync incidents show ${incident.incidentId}`,
    payload: {
      incidentId: incident.incidentId,
      severity: incident.severity,
      reasonCode: incident.reasonCode,
      summary: incident.summary,
      authoritativeCommand: `git-sync incidents show ${incident.incidentId}`,
    },
  };
}

async function runSender(
  senderScript: string,
  expectedSha256: string,
  eventPath: string,
  interpreter: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const content = await trustedSenderBytes(senderScript);
  if (createHash("sha256").update(content).digest("hex") !== expectedSha256) {
    throw new Error("Pinned Guardian sender content changed before execution");
  }
  // Execute the verified in-memory bytes, never re-open a mutable path.
  // On macOS, Python can exit 0 without running an unlinked /dev/fd script;
  // stdin executes the same pinned bytes without that silent-EOF failure.
  if (!isAbsolute(interpreter) || /[\r\n\0]/.test(interpreter)) throw new Error("Invalid workflow Python executable");
  return new Promise((resolveResult, reject) => {
    const environment: NodeJS.ProcessEnv = {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    };
    for (const key of ["PI_AGENT_NOTIFY_DIR", "PI_AGENT_NOTIFY_STATE_DIR"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const args = ["-", "send", "--event-file", eventPath];
    const child = spawn(interpreter, args, {
      cwd: dirname(senderScript),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, code = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) reject(error);
      else resolveResult({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > COMMAND_MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("Guardian sender output exceeded the bounded limit"));
      } else target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(new Error("Could not execute Guardian sender", { cause: error })));
    child.on("close", (code) => finish(null, code ?? -1));
    child.stdin.on("error", () => finish(new Error("Guardian sender input failed")));
    child.stdin.end(content);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Guardian sender exceeded the bounded timeout"));
    }, COMMAND_TIMEOUT_MS);
  });
}

function dispatchReceiptPath(paths: AppPaths, incidentId: string, generation: number): string {
  return resolve(paths.guardianDispatchDirectory, `${incidentId}-g${generation}.json`);
}

function assertDispatchReceipt(
  receipt: GuardianDispatchReceipt,
  incident: IncidentRecord,
  config: GuardianRoutingConfig,
): void {
  if (receipt.incidentId !== incident.incidentId ||
      receipt.eventId !== `git-sync:${incident.incidentId}:g${config.generation}` ||
      receipt.routingGeneration !== config.generation || receipt.targetSessionId !== config.targetSessionId || receipt.senderSha256 !== config.senderSha256) {
    throw new Error(`Guardian dispatch receipt conflicts with incident ${incident.incidentId}`);
  }
}

function isSessionRegistry(value: unknown): value is SessionRegistry {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "projectedAt", "sessions"]) ||
      value.schemaVersion !== 1 || !isDateString(value.projectedAt) || !isRecord(value.sessions)) return false;
  return Object.values(value.sessions).every((entry) => isRecord(entry) && hasExactKeys(entry, [
    "hostId", "sessionId", "repositoryPath", "sessionFile", "status", "startedAt", "lastEventAt", "lastEventId",
  ]) && typeof entry.hostId === "string" && typeof entry.sessionId === "string" &&
    typeof entry.repositoryPath === "string" && (entry.sessionFile === null || typeof entry.sessionFile === "string") &&
    (entry.status === "active" || entry.status === "offline") && isDateString(entry.startedAt) &&
    isDateString(entry.lastEventAt) && typeof entry.lastEventId === "string");
}

function isGuardianRoutingConfig(value: unknown): value is GuardianRoutingConfig {
  return isRecord(value) && hasExactKeys(value, [
    "schemaVersion", "hostId", "generation", "targetSessionId", "itemKey", "senderScript", "senderSha256", "configuredAt",
  ]) && value.schemaVersion === 1 && typeof value.hostId === "string" && value.hostId.length > 0 &&
    Number.isSafeInteger(value.generation) && (value.generation as number) >= 1 &&
    typeof value.targetSessionId === "string" && SESSION_ID_PATTERN.test(value.targetSessionId) &&
    value.itemKey === `git-sync:guardian:${value.hostId}` && typeof value.senderScript === "string" &&
    isAbsolute(value.senderScript) && typeof value.senderSha256 === "string" && HASH_PATTERN.test(value.senderSha256) &&
    isDateString(value.configuredAt);
}

function isGuardianDispatchReceipt(value: unknown): value is GuardianDispatchReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "schemaVersion", "incidentId", "eventId", "routingGeneration", "targetSessionId", "senderSha256", "dispatchedAt",
  ]) && value.schemaVersion === 1 && typeof value.incidentId === "string" && /^inc-[0-9a-f-]{36}$/.test(value.incidentId) &&
    Number.isSafeInteger(value.routingGeneration) && (value.routingGeneration as number) >= 1 &&
    value.eventId === `git-sync:${value.incidentId}:g${String(value.routingGeneration)}` && typeof value.targetSessionId === "string" &&
    SESSION_ID_PATTERN.test(value.targetSessionId) && typeof value.senderSha256 === "string" &&
    HASH_PATTERN.test(value.senderSha256) && isDateString(value.dispatchedAt);
}

function isGuardianEvent(value: unknown): value is ReturnType<typeof guardianEvent> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "eventId", "producer", "occurredAt", "expiresAt", "itemKey", "target", "eventType", "level", "message", "payload",
  ])) return false;
  return value.schemaVersion === 1 && typeof value.eventId === "string" && value.producer === "git-sync-daemon" &&
    isDateString(value.occurredAt) && isDateString(value.expiresAt) && typeof value.itemKey === "string" &&
    isRecord(value.target) && hasExactKeys(value.target, ["sessionId"]) &&
    typeof value.target.sessionId === "string" && SESSION_ID_PATTERN.test(value.target.sessionId) &&
    (value.eventType === "daemon.pass.failed" || value.eventType === "registry.admission.rejected" || value.eventType === "sync.attention") &&
    (value.level === "yellow" || value.level === "red") && typeof value.message === "string" && value.message.length <= 12000 &&
    isRecord(value.payload) && hasExactKeys(value.payload, [
      "incidentId", "severity", "reasonCode", "summary", "authoritativeCommand",
    ]);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
