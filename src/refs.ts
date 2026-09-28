import { realpath } from "node:fs/promises";
import type { AppPaths } from "./config.js";
import { isAncestor, isReachableFromRemote, listCommitsBetween, listRefs } from "./git.js";
import { loadHostIdentity } from "./host.js";
import { loadHostInventory } from "./inventory.js";
import { addAttribution, loadProvenance, localRefsAttributionId, saveProvenance } from "./provenance.js";
import { loadRegistry } from "./registry.js";
import { pathExists, readJson, writeJsonAtomic } from "./storage.js";
import type {
  CommitAttribution,
  ProvenanceStore,
  RefsSnapshotStore,
  RepositoryRefsSnapshot,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface RefsScanResult {
  readonly repositories: number;
  readonly baselined: number;
  readonly advancedRefs: number;
  readonly observedCommits: number;
  readonly createdCandidates: number;
}

export async function loadRefsSnapshot(paths: AppPaths): Promise<RefsSnapshotStore> {
  if (!(await pathExists(paths.refsSnapshotFile))) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), repositories: [] };
  }
  return readJson(paths.refsSnapshotFile, isRefsSnapshotStore);
}

export async function scanLocalRefs(
  paths: AppPaths,
  now: Date = new Date(),
): Promise<RefsScanResult> {
  const identity = await loadHostIdentity(paths);
  const [inventory, registry, previousStore] = await Promise.all([
    loadHostInventory(paths, identity.id),
    loadRegistry(paths),
    loadRefsSnapshot(paths),
  ]);
  if (inventory === null) {
    throw new Error(`No inventory exists for local host ${identity.id}; run discover first`);
  }
  if (inventory.repositories.length > 4_096) throw new Error("Inventory repository limit exceeded");
  const enabledRepositories = inventory.repositories.filter(
    (repository) =>
      repository.canonicalRemote !== null &&
      registry.repositories[repository.canonicalRemote]?.mode === "enabled",
  );

  let provenance = await loadProvenance(paths);
  const nextRepositories: RepositoryRefsSnapshot[] = [];
  let baselined = 0;
  let advancedRefs = 0;
  let observedCommits = 0;
  let createdCandidates = 0;

  for (const repository of enabledRepositories) {
    const canonicalPath = await realpath(repository.path);
    if (canonicalPath !== repository.path) {
      throw new Error(`Inventory repository path changed identity: ${repository.path}`);
    }
    const allRefs = await listRefs(repository.path, ["refs/heads", "refs/remotes"]);
    const localRefs = Object.fromEntries(
      allRefs.filter((ref) => ref.name.startsWith("refs/heads/")).map((ref) => [ref.name, ref.oid]),
    );
    const previous = previousStore.repositories.find(
      (candidate) => candidate.repositoryPath === repository.path,
    );
    nextRepositories.push({ repositoryPath: repository.path, refs: localRefs });
    if (previous === undefined) {
      baselined += 1;
      continue;
    }

    const oldTips = Object.values(previous.refs);
    for (const [refName, nextOid] of Object.entries(localRefs).sort(([left], [right]) => left.localeCompare(right))) {
      const previousOid = previous.refs[refName];
      if (previousOid === nextOid) continue;
      const fastForward =
        previousOid === undefined || (await isAncestor(repository.path, previousOid, nextOid));
      advancedRefs += 1;
      // For a rewrite/amend/rebase, compare the new tip against every old local
      // tip. This observes genuinely new commits without re-attributing history
      // that was already present before the rewrite.
      const commits = await listCommitsBetween(
        repository.path,
        fastForward ? (previousOid ?? null) : null,
        nextOid,
        previousOid === undefined || !fastForward ? oldTips : [],
      );
      for (const oid of commits) {
        const remoteReachable = await isReachableFromRemote(repository.path, oid);
        provenance = addRefsEvidence(
          provenance,
          repository.path,
          oid,
          refName,
          "observed",
          remoteReachable ? "remote" : "unknown-local",
          identity.id,
          now,
        );
        observedCommits += 1;
        if (!remoteReachable) {
          provenance = addRefsEvidence(
            provenance,
            repository.path,
            oid,
            refName,
            "created-candidate",
            "unknown-local",
            identity.id,
            now,
          );
          createdCandidates += 1;
        }
      }
    }
  }

  // Provenance is committed first. Its deterministic evidence IDs make a crash before
  // the snapshot write safely replayable without multiplying attributions.
  await saveProvenance(paths, provenance);
  const nextStore: RefsSnapshotStore = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    repositories: nextRepositories.sort((left, right) =>
      left.repositoryPath.localeCompare(right.repositoryPath),
    ),
  };
  await writeJsonAtomic(paths.refsSnapshotFile, nextStore);
  return {
    repositories: enabledRepositories.length,
    baselined,
    advancedRefs,
    observedCommits,
    createdCandidates,
  };
}

function addRefsEvidence(
  store: ProvenanceStore,
  repositoryPath: string,
  oid: string,
  refName: string,
  classification: "observed" | "created-candidate",
  source: "remote" | "unknown-local",
  hostId: string,
  now: Date,
): ProvenanceStore {
  const attribution: CommitAttribution = {
    attributionId: localRefsAttributionId(repositoryPath, oid, refName, classification),
    source,
    classification,
    recordedAt: now.toISOString(),
    hostId,
    evidence: "local-refs",
    nonExclusive: true,
    refName,
  };
  return addAttribution(store, repositoryPath, oid, attribution, now);
}

function isRefsSnapshotStore(value: unknown): value is RefsSnapshotStore {
  if (!isExactObject(value, ["schemaVersion", "updatedAt", "repositories"])) return false;
  return (
    value.schemaVersion === 1 &&
    isDate(value.updatedAt) &&
    Array.isArray(value.repositories) &&
    value.repositories.length <= 4_096 &&
    value.repositories.every(isRepositorySnapshot)
  );
}

function isRepositorySnapshot(value: unknown): value is RepositoryRefsSnapshot {
  if (!isExactObject(value, ["repositoryPath", "refs"])) return false;
  if (typeof value.repositoryPath !== "string" || !isPlainObject(value.refs)) return false;
  const refs = Object.entries(value.refs);
  return (
    refs.length <= 20_000 &&
    refs.every(
      ([name, oid]) =>
        name.startsWith("refs/heads/") &&
        !name.includes("\n") &&
        typeof oid === "string" &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid),
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
