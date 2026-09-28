import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { isAncestor, requireCommit } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { addAttribution, loadProvenance, requireInventoryRepository, saveProvenance } from "./provenance.js";
import { isNodeError, writeJsonAtomic } from "./storage.js";
import type {
  BridgeEvent,
  BridgeEvidence,
  CommitAttribution,
  SessionProjectionEntry,
  SessionRegistry,
} from "./types.js";
import { BRIDGE_PRODUCER, SCHEMA_VERSION } from "./types.js";

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_FILES_PER_RUN = 10_000;
const MAX_COMMITS_PER_EVENT = 10_000;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface BridgeConsumeResult {
  readonly claimed: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly quarantined: number;
}

interface QuarantineRecord {
  readonly schemaVersion: 1;
  readonly originalName: string;
  readonly quarantinedAt: string;
  readonly reason: string;
}

export async function consumeBridgeOutbox(
  paths: AppPaths,
  now: Date = new Date(),
): Promise<BridgeConsumeResult> {
  await ensureBridgeDirectories(paths);
  const identity = await loadHostIdentity(paths);
  let claimed = 0;
  let accepted = 0;
  let duplicates = 0;
  let quarantined = 0;

  const existingClaims = await eventFileNames(paths.bridgeClaimsDirectory, false);
  // The producer exposes only atomically completed *.json files. Its visible
  // *.tmp files may still be open and must never be claimed.
  const outboxNames = await eventFileNames(paths.bridgeOutboxDirectory, true);
  if (existingClaims.length + outboxNames.length > MAX_FILES_PER_RUN) {
    throw new Error(`Bridge input exceeds the ${MAX_FILES_PER_RUN}-file limit`);
  }
  const claimPaths = existingClaims.map((name) => resolve(paths.bridgeClaimsDirectory, name));
  for (const name of outboxNames) {
    const source = resolve(paths.bridgeOutboxDirectory, name);
    const claim = resolve(paths.bridgeClaimsDirectory, `${safeName(name)}-${randomUUID()}`);
    try {
      // Same-filesystem rename is the ownership boundary between concurrent consumers.
      await rename(source, claim);
      claimPaths.push(claim);
      claimed += 1;
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
  }

  let sessionStates = projectSessions(await loadAcceptedEvents(paths), now);
  for (const claimPath of claimPaths) {
    const originalName = claimPath.slice(claimPath.lastIndexOf("/") + 1);
    try {
      const event = await readAndValidateEvent(claimPath, identity.id);
      assertEventTime(event, now);
      const acceptedPath = resolve(paths.bridgeAcceptedDirectory, `${event.eventId}.json`);
      let existing: BridgeEvent | null = null;
      try {
        existing = await readAndValidateEvent(acceptedPath, identity.id);
      } catch (error: unknown) {
        const cause = causeOf(error);
        if (!(isNodeError(cause) && cause.code === "ENOENT")) throw error;
      }
      if (existing !== null) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error(`eventId conflicts with an already accepted event: ${event.eventId}`);
        }
        duplicates += 1;
      } else {
        await validateEventContext(paths, event, sessionStates);
        await writeJsonAtomic(acceptedPath, event);
        accepted += 1;
        sessionStates = projectSessions(await loadAcceptedEvents(paths), now);
      }
      await rm(claimPath, { force: true });
    } catch (error: unknown) {
      const quarantine: QuarantineRecord = {
        schemaVersion: 1,
        originalName: safeName(originalName),
        quarantinedAt: now.toISOString(),
        reason: boundedReason(error),
      };
      await writeJsonAtomic(
        resolve(paths.bridgeQuarantineDirectory, `${randomUUID()}.json`),
        quarantine,
      );
      await rm(claimPath, { force: true });
      quarantined += 1;
    }
  }

  await persistProjections(paths, await loadAcceptedEvents(paths), now);
  return { claimed, accepted, duplicates, quarantined };
}

export async function loadAcceptedEvents(paths: AppPaths): Promise<BridgeEvent[]> {
  await ensureBridgeDirectories(paths);
  const identity = await loadHostIdentity(paths);
  const names = (await readdir(paths.bridgeAcceptedDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length > 100_000) throw new Error("Accepted bridge event limit exceeded");
  const events: BridgeEvent[] = [];
  for (const name of names) {
    const event = await readAndValidateEvent(resolve(paths.bridgeAcceptedDirectory, name), identity.id);
    if (name !== `${event.eventId}.json`) {
      throw new Error(`Accepted event filename does not match eventId: ${name}`);
    }
    events.push(event);
  }
  return events.sort(compareEvents);
}

async function readAndValidateEvent(path: string, expectedHostId: string): Promise<BridgeEvent> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Bridge event must be a regular file");
  if (details.size > MAX_EVENT_BYTES) throw new Error(`Bridge event exceeds ${MAX_EVENT_BYTES} bytes`);
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error("Bridge event contains invalid JSON", { cause: error });
  }
  if (!isBridgeEvent(value)) throw new Error("Bridge event does not match pi-git-sync-bridge schema v1");
  if (value.hostId !== expectedHostId) throw new Error("Bridge event hostId does not match local identity");
  return value;
}

function assertEventTime(event: BridgeEvent, now: Date): void {
  const age = now.getTime() - Date.parse(event.occurredAt);
  if (age > MAX_EVENT_AGE_MS) throw new Error("Bridge event is too old");
  if (age < -MAX_EVENT_FUTURE_SKEW_MS) throw new Error("Bridge event is too far in the future");
}

async function validateEventContext(
  paths: AppPaths,
  event: BridgeEvent,
  sessions: SessionRegistry,
): Promise<void> {
  const repository = await requireInventoryRepository(paths, event.repoRoot);
  if (repository.repositoryPath !== event.repoRoot) {
    throw new Error("Bridge repoRoot must be the canonical absolute inventory path");
  }
  for (const oid of uniqueOids(event)) await requireCommit(event.repoRoot, oid);
  if (event.eventType === "commit.observed" && event.after !== null) {
    for (const oid of event.newCommitOids) {
      if (oid !== event.after && !(await isAncestor(event.repoRoot, oid, event.after))) {
        throw new Error(`Observed commit is not reachable from event.after: ${oid}`);
      }
    }
  }

  const session = sessions.sessions[sessionKey(event.hostId, event.sessionId)];
  if (event.eventType === "session.registered") return;
  if (session === undefined || session.status !== "active") {
    throw new Error(`Bridge event references a session that is not active: ${event.sessionId}`);
  }
  if (session.repositoryPath !== event.repoRoot) {
    throw new Error("Bridge event repoRoot differs from the registered session");
  }
  if (session.sessionFile !== event.sessionFile) {
    throw new Error("Bridge event sessionFile differs from the registered session");
  }
}

async function persistProjections(
  paths: AppPaths,
  events: readonly BridgeEvent[],
  now: Date,
): Promise<void> {
  const sessions = projectSessions(events, now);
  let provenance = await loadProvenance(paths);
  for (const event of events) {
    if (event.eventType !== "commit.observed") continue;
    for (const oid of event.newCommitOids) {
      const attribution: CommitAttribution = {
        attributionId: `bridge:${event.eventId}:${oid}`,
        source: "pi",
        classification: "attributed",
        recordedAt: event.occurredAt,
        hostId: event.hostId,
        evidence: "bridge-claim",
        nonExclusive: true,
        eventId: event.eventId,
        sessionId: event.sessionId,
      };
      provenance = addAttribution(provenance, event.repoRoot, oid, attribution, now);
    }
  }
  // Both projections are derived from the immutable accepted journal and can be
  // regenerated after a crash. A bridge claim is evidence, never exclusive proof
  // of authorship; nonExclusive stays true even when confidence is "high".
  await saveProvenance(paths, provenance);
  await writeJsonAtomic(paths.sessionsFile, sessions);
}

function projectSessions(events: readonly BridgeEvent[], now: Date): SessionRegistry {
  const sessions: Record<string, SessionProjectionEntry> = {};
  for (const event of [...events].sort(compareEvents)) {
    const key = sessionKey(event.hostId, event.sessionId);
    const previous = sessions[key];
    if (event.eventType === "session.registered") {
      sessions[key] = {
        hostId: event.hostId,
        sessionId: event.sessionId,
        repositoryPath: event.repoRoot,
        sessionFile: event.sessionFile,
        status: "active",
        startedAt: event.occurredAt,
        lastEventAt: event.occurredAt,
        lastEventId: event.eventId,
      };
    } else if (previous !== undefined) {
      sessions[key] = {
        ...previous,
        status: event.eventType === "session.unregistered" ? "offline" : previous.status,
        lastEventAt: event.occurredAt,
        lastEventId: event.eventId,
      };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    projectedAt: now.toISOString(),
    sessions: Object.fromEntries(Object.entries(sessions).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "schemaVersion", "eventId", "eventType", "occurredAt", "producer", "hostId",
    "sessionId", "sessionFile", "repoRoot", "before", "after", "newCommitOids",
    "evidence", "confidence",
  ])) return false;
  if (
    value.schemaVersion !== 1 || value.producer !== BRIDGE_PRODUCER ||
    !isSafeId(value.eventId, EVENT_ID_PATTERN) || !isSafeId(value.hostId, EVENT_ID_PATTERN) ||
    !isSafeId(value.sessionId, SESSION_ID_PATTERN) || !isCanonicalDate(value.occurredAt) ||
    (value.eventType !== "session.registered" && value.eventType !== "commit.observed" &&
      value.eventType !== "session.unregistered") ||
    !isBoundedAbsolutePath(value.repoRoot) ||
    !(value.sessionFile === null || isBoundedAbsolutePath(value.sessionFile)) ||
    !isNullableOid(value.before) || !isNullableOid(value.after) ||
    !Array.isArray(value.newCommitOids) || value.newCommitOids.length > MAX_COMMITS_PER_EVENT ||
    !value.newCommitOids.every((oid) => typeof oid === "string" && OID_PATTERN.test(oid)) ||
    new Set(value.newCommitOids).size !== value.newCommitOids.length ||
    !isBridgeEvidence(value.evidence)
  ) return false;

  if (value.eventType === "commit.observed") {
    return value.confidence === "medium" &&
      value.evidence.observation === "git-head-transition" &&
      value.evidence.trigger !== "session_start" &&
      (value.after !== null || value.newCommitOids.length === 0) &&
      value.before !== value.after;
  }
  return value.confidence === "high" &&
    value.evidence.observation === "session-lifecycle" &&
    value.newCommitOids.length === 0 && value.before === value.after &&
    (value.eventType === "session.registered"
      ? value.evidence.trigger === "session_start"
      : value.evidence.trigger === "session_shutdown");
}

function isBridgeEvidence(value: unknown): value is BridgeEvidence {
  if (!isPlainObject(value)) return false;
  const allowed = [
    "source", "trigger", "observation", "reason", "toolCallId", "toolName", "toolError",
    "baselineCapturedAt",
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  return value.source === "pi-extension" &&
    (value.trigger === "session_start" || value.trigger === "tool_execution_end" ||
      value.trigger === "agent_settled" || value.trigger === "session_shutdown") &&
    (value.observation === "session-lifecycle" || value.observation === "git-head-transition") &&
    isOptionalBoundedString(value.reason, 1_000) &&
    isOptionalBoundedString(value.toolCallId, 500) &&
    isOptionalBoundedString(value.toolName, 500) &&
    (value.toolError === undefined || typeof value.toolError === "boolean") &&
    (value.baselineCapturedAt === undefined || value.baselineCapturedAt === null ||
      isCanonicalDate(value.baselineCapturedAt));
}

function uniqueOids(event: BridgeEvent): string[] {
  return [...new Set([
    ...(event.before === null ? [] : [event.before]),
    ...(event.after === null ? [] : [event.after]),
    ...event.newCommitOids,
  ])];
}

async function ensureBridgeDirectories(paths: AppPaths): Promise<void> {
  for (const directory of [
    paths.stateDirectory, paths.bridgeDirectory, paths.bridgeOutboxDirectory,
    paths.bridgeClaimsDirectory, paths.bridgeAcceptedDirectory, paths.bridgeQuarantineDirectory,
  ]) {
    await ensurePrivateDirectory(directory);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Unsafe bridge directory: ${directory}`);
    }
  } catch (error: unknown) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function eventFileNames(directory: string, jsonOnly: boolean): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => (!jsonOnly || entry.name.endsWith(".json")) &&
      (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
}

function safeName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return safe === "" ? "event" : safe;
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/g, " ").slice(0, 300);
}

function causeOf(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

function compareEvents(left: BridgeEvent, right: BridgeEvent): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    eventRank(left) - eventRank(right) ||
    left.eventId.localeCompare(right.eventId);
}

function eventRank(event: BridgeEvent): number {
  return event.eventType === "session.registered" ? 0 :
    event.eventType === "commit.observed" ? 1 : 2;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isSafeId(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function isNullableOid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && OID_PATTERN.test(value));
}

function isBoundedAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    !value.includes("\0") && isAbsolute(value);
}

function isOptionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximum && !value.includes("\0"));
}
