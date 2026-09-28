import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AppPaths } from "./config.js";
import { requireCommit } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { loadHostInventory } from "./inventory.js";
import { loadRegistry } from "./registry.js";
import { pathExists, readJson, writeJsonAtomic } from "./storage.js";
import type {
  CommitAttribution,
  CommitProvenanceEntry,
  ExplicitProvenanceSource,
  ProvenanceStore,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const EXPLICIT_SOURCES = new Set<ExplicitProvenanceSource>([
  "manual",
  "vscode",
  "chatgpt-work",
  "automation",
  "external-agent",
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

export function createEmptyProvenance(now: Date = new Date()): ProvenanceStore {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: now.toISOString(), commits: [] };
}

export async function loadProvenance(paths: AppPaths): Promise<ProvenanceStore> {
  if (!(await pathExists(paths.provenanceFile))) return createEmptyProvenance(new Date(0));
  return readJson(paths.provenanceFile, isProvenanceStore);
}

export async function saveProvenance(paths: AppPaths, store: ProvenanceStore): Promise<void> {
  await writeJsonAtomic(paths.provenanceFile, store);
}

export async function requireInventoryRepository(
  paths: AppPaths,
  requestedPath: string,
): Promise<{ hostId: string; repositoryPath: string }> {
  const identity = await loadHostIdentity(paths);
  const [inventory, registry, canonicalPath] = await Promise.all([
    loadHostInventory(paths, identity.id),
    loadRegistry(paths),
    realpath(requestedPath),
  ]);
  if (inventory === null) {
    throw new Error(`No inventory exists for local host ${identity.id}; run discover first`);
  }
  const repository = inventory.repositories.find((candidate) => candidate.path === canonicalPath);
  if (repository === undefined) {
    throw new Error(`Repository path is not in the local host inventory: ${canonicalPath}`);
  }
  if (
    repository.canonicalRemote === null ||
    registry.repositories[repository.canonicalRemote]?.mode !== "enabled"
  ) {
    throw new Error(`Repository is discovered but not explicitly enabled: ${canonicalPath}`);
  }
  return { hostId: identity.id, repositoryPath: canonicalPath };
}

export async function recordExplicitProvenance(
  paths: AppPaths,
  requestedPath: string,
  oid: string,
  source: ExplicitProvenanceSource,
  runId?: string,
  now: Date = new Date(),
): Promise<CommitProvenanceEntry> {
  if (!EXPLICIT_SOURCES.has(source)) throw new Error(`Unsupported explicit provenance source: ${source}`);
  if (runId !== undefined && !ID_PATTERN.test(runId)) {
    throw new Error("Run id must be 1-200 safe identifier characters");
  }
  const repository = await requireInventoryRepository(paths, requestedPath);
  await requireCommit(repository.repositoryPath, oid);
  const attribution: CommitAttribution = {
    attributionId: `explicit:${randomUUID()}`,
    source,
    classification: "attributed",
    recordedAt: now.toISOString(),
    hostId: repository.hostId,
    evidence: "explicit",
    nonExclusive: true,
    ...(runId === undefined ? {} : { runId }),
  };
  const store = addAttribution(await loadProvenance(paths), repository.repositoryPath, oid, attribution, now);
  await saveProvenance(paths, store);
  return requireEntry(store, repository.repositoryPath, oid);
}

export function addAttribution(
  store: ProvenanceStore,
  repositoryPath: string,
  oid: string,
  attribution: CommitAttribution,
  now: Date = new Date(),
): ProvenanceStore {
  const commits: CommitProvenanceEntry[] = store.commits.map((entry) => ({
    ...entry,
    attributions: [...entry.attributions],
  }));
  let entry = commits.find(
    (candidate) => candidate.repositoryPath === repositoryPath && candidate.oid === oid,
  );
  if (entry === undefined) {
    entry = { repositoryPath, oid, attributions: [] };
    commits.push(entry);
  }
  if (!entry.attributions.some((candidate) => candidate.attributionId === attribution.attributionId)) {
    const replacement: CommitProvenanceEntry = {
      ...entry,
      attributions: [...entry.attributions, attribution].sort(compareAttributions),
    };
    commits[commits.indexOf(entry)] = replacement;
  }
  commits.sort((left, right) =>
    left.repositoryPath.localeCompare(right.repositoryPath) || left.oid.localeCompare(right.oid),
  );
  return { schemaVersion: SCHEMA_VERSION, updatedAt: now.toISOString(), commits };
}

export function localRefsAttributionId(
  repositoryPath: string,
  oid: string,
  refName: string,
  classification: "observed" | "created-candidate",
): string {
  const digest = createHash("sha256")
    .update(`${repositoryPath}\0${oid}\0${refName}\0${classification}`)
    .digest("hex");
  return `refs:${digest}`;
}

export function filterProvenance(
  store: ProvenanceStore,
  repositoryPath?: string,
  oid?: string,
): ProvenanceStore {
  const commits = store.commits.filter(
    (entry) =>
      (repositoryPath === undefined || entry.repositoryPath === repositoryPath) &&
      (oid === undefined || entry.oid === oid),
  );
  if (commits.length > 5_000) throw new Error("Provenance output exceeds the 5000-commit limit");
  return { ...store, commits };
}

export function isExplicitProvenanceSource(value: string): value is ExplicitProvenanceSource {
  return EXPLICIT_SOURCES.has(value as ExplicitProvenanceSource);
}

function requireEntry(store: ProvenanceStore, repositoryPath: string, oid: string): CommitProvenanceEntry {
  const entry = store.commits.find(
    (candidate) => candidate.repositoryPath === repositoryPath && candidate.oid === oid,
  );
  if (entry === undefined) throw new Error("Internal provenance persistence error");
  return entry;
}

function compareAttributions(left: CommitAttribution, right: CommitAttribution): number {
  return left.recordedAt.localeCompare(right.recordedAt) ||
    left.attributionId.localeCompare(right.attributionId);
}

function isProvenanceStore(value: unknown): value is ProvenanceStore {
  if (!isExactObject(value, ["schemaVersion", "updatedAt", "commits"])) return false;
  return (
    value.schemaVersion === 1 &&
    isDate(value.updatedAt) &&
    Array.isArray(value.commits) &&
    value.commits.length <= 100_000 &&
    value.commits.every(isCommitEntry)
  );
}

function isCommitEntry(value: unknown): value is CommitProvenanceEntry {
  if (!isExactObject(value, ["repositoryPath", "oid", "attributions"])) return false;
  return (
    typeof value.repositoryPath === "string" &&
    value.repositoryPath.length > 0 &&
    typeof value.oid === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.oid) &&
    Array.isArray(value.attributions) &&
    value.attributions.length <= 10_000 &&
    value.attributions.every(isAttribution)
  );
}

function isAttribution(value: unknown): value is CommitAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = [
    "attributionId", "source", "classification", "recordedAt", "hostId", "evidence",
    "nonExclusive", "eventId", "sessionId", "runId", "refName",
  ];
  if (!Object.keys(record).every((key) => allowed.includes(key))) return false;
  return (
    typeof record.attributionId === "string" &&
    typeof record.source === "string" &&
    ["manual", "vscode", "chatgpt-work", "automation", "external-agent", "pi", "unknown-local", "remote"].includes(record.source) &&
    typeof record.classification === "string" &&
    ["observed", "created-candidate", "attributed"].includes(record.classification) &&
    isDate(record.recordedAt) &&
    typeof record.hostId === "string" &&
    typeof record.evidence === "string" &&
    ["bridge-claim", "local-refs", "explicit"].includes(record.evidence) &&
    record.nonExclusive === true &&
    optionalString(record.eventId) && optionalString(record.sessionId) &&
    optionalString(record.runId) && optionalString(record.refName)
  );
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
