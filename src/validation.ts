import type {
  AppConfig,
  BusinessIdentityStore,
  BusinessTransportStore,
  DesiredRegistry,
  HostIdentity,
  HostInventory,
  InboxRemoteConfig,
  InboxRemoteVerification,
  ReconcileReport,
  RegistryEntry,
  RegistryAdmissionReport,
  RegistryRemoteConfig,
  RegistryRemoteVerification,
  RegistryPolicyPublicationIntent,
  RepositoryRecord,
  SecondaryInboxKeyPin,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasOnlyStringsOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

const SAFE_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeHostId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_HOST_ID_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

export function isAppConfig(value: unknown): value is AppConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "roots", "excludedDirectories"]) &&
    value.schemaVersion === 1 &&
    isStringArray(value.roots) &&
    isStringArray(value.excludedDirectories)
  );
}

export function isHostIdentity(value: unknown): value is HostIdentity {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.hostname === "string" &&
    isDateString(value.createdAt)
  );
}

function isRepositoryRecord(value: unknown): value is RepositoryRecord {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.gitMarker === "directory" || value.gitMarker === "file") &&
    typeof value.worktree === "boolean" &&
    hasOnlyStringsOrNull(value.remoteName) &&
    hasOnlyStringsOrNull(value.canonicalRemote)
  );
}

export function isHostInventory(value: unknown): value is HostInventory {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    isDateString(value.generatedAt) &&
    isStringArray(value.roots) &&
    Array.isArray(value.repositories) &&
    value.repositories.every(isRepositoryRecord)
  );
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    isRecord(value) &&
    typeof value.canonicalRemote === "string" &&
    (value.mode === "enabled" || value.mode === "disabled" || value.mode === "ignored") &&
    isDateString(value.updatedAt)
  );
}

export function isBusinessIdentityStore(value: unknown): value is BusinessIdentityStore {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "updatedAt", "repositories"]) ||
      value.schemaVersion !== 1 || !isDateString(value.updatedAt) || !isRecord(value.repositories)) return false;
  return Object.entries(value.repositories).every(([canonicalRemote, entry]) =>
    /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(canonicalRemote) && isRecord(entry) &&
    hasExactKeys(entry, [
      "canonicalRemote", "nodeId", "fullName", "checkoutDevice", "checkoutInode",
      "gitCommonDevice", "gitCommonInode", "verifiedAt",
    ]) &&
    entry.canonicalRemote === canonicalRemote && typeof entry.nodeId === "string" &&
    entry.nodeId.length > 0 && entry.nodeId.length <= 256 && typeof entry.fullName === "string" &&
    entry.fullName.toLowerCase() === canonicalRemote.slice("github.com/".length) &&
    entry.fullName.length > 0 && entry.fullName.length <= 201 &&
    typeof entry.checkoutDevice === "string" && /^[0-9]+$/.test(entry.checkoutDevice) &&
    typeof entry.checkoutInode === "string" && /^[0-9]+$/.test(entry.checkoutInode) &&
    typeof entry.gitCommonDevice === "string" && /^[0-9]+$/.test(entry.gitCommonDevice) &&
    typeof entry.gitCommonInode === "string" && /^[0-9]+$/.test(entry.gitCommonInode) &&
    isDateString(entry.verifiedAt));
}

export function isInboxRemoteConfig(value: unknown): value is InboxRemoteConfig {
  return isRecord(value) && hasExactKeys(value, [
    "schemaVersion", "configuredAt", "remoteUrl", "canonicalRepository", "owner", "repository",
    "configuredHostId", "primaryHostId", "secondaryHostId",
  ]) && value.schemaVersion === 1 && isDateString(value.configuredAt) &&
    typeof value.remoteUrl === "string" && value.remoteUrl.length > 0 && value.remoteUrl.length <= 2048 &&
    typeof value.owner === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.owner) &&
    typeof value.repository === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.repository) &&
    value.canonicalRepository === `github.com/${value.owner.toLowerCase()}/${value.repository.toLowerCase()}` &&
    isSafeHostId(value.configuredHostId) && isSafeHostId(value.primaryHostId) &&
    isSafeHostId(value.secondaryHostId) && value.primaryHostId !== value.secondaryHostId &&
    (value.configuredHostId === value.primaryHostId || value.configuredHostId === value.secondaryHostId);
}

export function isInboxRemoteVerification(value: unknown): value is InboxRemoteVerification {
  return isRecord(value) && hasExactKeys(value, [
    "schemaVersion", "canonicalRepository", "nodeId", "deployKeyId", "keyFingerprint", "role", "verifiedAt",
  ]) && value.schemaVersion === 1 && typeof value.canonicalRepository === "string" &&
    /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.canonicalRepository) &&
    typeof value.nodeId === "string" && value.nodeId.length > 0 && value.nodeId.length <= 256 &&
    Number.isSafeInteger(value.deployKeyId) && (value.deployKeyId as number) > 0 &&
    typeof value.keyFingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.keyFingerprint) &&
    (value.role === "primary-reader" || value.role === "secondary-writer") && isDateString(value.verifiedAt);
}

export function isSecondaryInboxKeyPin(value: unknown): value is SecondaryInboxKeyPin {
  return isRecord(value) && hasExactKeys(value, [
    "schemaVersion", "canonicalRepository", "nodeId", "primaryHostId", "secondaryHostId",
    "role", "publicKey", "keyFingerprint", "pinnedAt",
  ]) && value.schemaVersion === 1 &&
    typeof value.canonicalRepository === "string" &&
    /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.canonicalRepository) &&
    typeof value.nodeId === "string" && value.nodeId.length > 0 && value.nodeId.length <= 256 &&
    isSafeHostId(value.primaryHostId) && isSafeHostId(value.secondaryHostId) &&
    value.primaryHostId !== value.secondaryHostId && value.role === "secondary-writer" &&
    typeof value.publicKey === "string" && value.publicKey.length <= 128 &&
    /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value.publicKey) &&
    typeof value.keyFingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.keyFingerprint) &&
    isDateString(value.pinnedAt);
}

export function isBusinessTransportStore(value: unknown): value is BusinessTransportStore {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "updatedAt", "repositories"]) ||
      value.schemaVersion !== 1 || !isDateString(value.updatedAt) || !isRecord(value.repositories)) return false;
  return Object.entries(value.repositories).every(([canonicalRemote, entry]) =>
    /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(canonicalRemote) && isRecord(entry) &&
    hasExactKeys(entry, [
      "canonicalRemote", "repositoryNodeId", "remoteName", "endpointHost", "advertisedRefsDigest",
      "receivePackDryRunObserved", "authorizationProven", "verifiedAt",
    ]) && entry.canonicalRemote === canonicalRemote && typeof entry.repositoryNodeId === "string" &&
    entry.repositoryNodeId.length > 0 && entry.repositoryNodeId.length <= 256 &&
    typeof entry.remoteName === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(entry.remoteName) &&
    entry.endpointHost === "github.com" && typeof entry.advertisedRefsDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(entry.advertisedRefsDigest) && entry.receivePackDryRunObserved === true &&
    entry.authorizationProven === false && isDateString(entry.verifiedAt));
}

export function isDesiredRegistry(value: unknown): value is DesiredRegistry {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isDateString(value.updatedAt) ||
    !isRecord(value.repositories)
  ) {
    return false;
  }
  return Object.entries(value.repositories).every(
    ([key, entry]) => isRegistryEntry(entry) && entry.canonicalRemote === key,
  );
}

export function isRegistryRemoteConfig(value: unknown): value is RegistryRemoteConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "configuredAt",
      "remoteUrl",
      "canonicalRepository",
      "owner",
      "repository",
      "configuredHostId",
      "primaryHostId",
      "requiredHostIds",
    ]) ||
    value.schemaVersion !== 1 ||
    !isDateString(value.configuredAt) ||
    typeof value.remoteUrl !== "string" ||
    value.remoteUrl.length === 0 ||
    value.remoteUrl.length > 2048 ||
    typeof value.owner !== "string" ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value.owner) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value.repository) ||
    value.canonicalRepository !== `github.com/${value.owner.toLowerCase()}/${value.repository.toLowerCase()}` ||
    !isSafeHostId(value.configuredHostId) ||
    !isSafeHostId(value.primaryHostId) ||
    !Array.isArray(value.requiredHostIds) ||
    value.requiredHostIds.length !== 2 ||
    !value.requiredHostIds.every(isSafeHostId) ||
    value.requiredHostIds[0] === value.requiredHostIds[1] ||
    !value.requiredHostIds.includes(value.configuredHostId) ||
    !value.requiredHostIds.includes(value.primaryHostId)
  ) {
    return false;
  }
  return true;
}

export function isRegistryRemoteVerification(
  value: unknown,
): value is RegistryRemoteVerification {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "canonicalRepository",
      "nodeId",
      "fullName",
      "verifiedAt",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.canonicalRepository === "string" &&
    /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.canonicalRepository) &&
    typeof value.nodeId === "string" &&
    value.nodeId.length > 0 &&
    value.nodeId.length <= 256 &&
    typeof value.fullName === "string" &&
    value.fullName.length > 0 &&
    value.fullName.length <= 201 &&
    isDateString(value.verifiedAt)
  );
}

const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CANONICAL_REPOSITORY_PATTERN = /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function isRegistryPolicyPublicationIntent(value: unknown): value is RegistryPolicyPublicationIntent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "ref", "oid", "previousOid", "localExpectedOid", "desiredOid",
    "desiredGeneration", "registryCanonicalRepository", "registryNodeId", "primaryHostId",
    "secondaryHostId", "canonicalRemote", "repositoryNodeId", "inboxCanonicalRemote",
    "inboxRepositoryNodeId", "primaryInboxReadKeyFingerprint", "secondaryInboxKeyFingerprint", "policyGeneration",
  ])) return false;
  return value.schemaVersion === 1 && typeof value.ref === "string" &&
    /^refs\/git-sync\/policies\/[0-9a-f]{64}$/.test(value.ref) &&
    typeof value.oid === "string" && FULL_OID_PATTERN.test(value.oid) &&
    (value.previousOid === null || (typeof value.previousOid === "string" && FULL_OID_PATTERN.test(value.previousOid))) &&
    (value.localExpectedOid === null || (typeof value.localExpectedOid === "string" && FULL_OID_PATTERN.test(value.localExpectedOid))) &&
    (value.localExpectedOid === null || value.localExpectedOid === value.previousOid) &&
    typeof value.desiredOid === "string" && FULL_OID_PATTERN.test(value.desiredOid) &&
    Number.isSafeInteger(value.desiredGeneration) && (value.desiredGeneration as number) > 0 &&
    Number.isSafeInteger(value.policyGeneration) && (value.policyGeneration as number) > 0 &&
    typeof value.registryCanonicalRepository === "string" && CANONICAL_REPOSITORY_PATTERN.test(value.registryCanonicalRepository) &&
    typeof value.registryNodeId === "string" && value.registryNodeId.length > 0 && value.registryNodeId.length <= 256 &&
    isSafeHostId(value.primaryHostId) && isSafeHostId(value.secondaryHostId) &&
    value.primaryHostId !== value.secondaryHostId &&
    typeof value.canonicalRemote === "string" && CANONICAL_REPOSITORY_PATTERN.test(value.canonicalRemote) &&
    typeof value.repositoryNodeId === "string" && value.repositoryNodeId.length > 0 && value.repositoryNodeId.length <= 256 &&
    typeof value.inboxCanonicalRemote === "string" && CANONICAL_REPOSITORY_PATTERN.test(value.inboxCanonicalRemote) &&
    typeof value.inboxRepositoryNodeId === "string" && value.inboxRepositoryNodeId.length > 0 && value.inboxRepositoryNodeId.length <= 256 &&
    typeof value.primaryInboxReadKeyFingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.primaryInboxReadKeyFingerprint) &&
    typeof value.secondaryInboxKeyFingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.secondaryInboxKeyFingerprint);
}

export function isRegistryAdmissionReport(value: unknown): value is RegistryAdmissionReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "admittedAt", "desiredGeneration", "desiredOid", "hostOids", "hostSequences", "report",
  ]) || value.schemaVersion !== 1 || !isDateString(value.admittedAt) ||
      !Number.isSafeInteger(value.desiredGeneration) || (value.desiredGeneration as number) < 1 ||
      typeof value.desiredOid !== "string" || !FULL_OID_PATTERN.test(value.desiredOid) ||
      !isRecord(value.hostOids) || !isRecord(value.hostSequences) || !isReconcileReport(value.report) ||
      !isRecord(value.report) || !hasExactKeys(value.report, [
        "schemaVersion", "generatedAt", "expectedHostCount", "hostIds", "repositories", "actions",
      ]) || !value.report.repositories.every((entry) => isRecord(entry) && hasExactKeys(entry, [
        "canonicalRemote", "desiredMode", "status", "presentOn", "missingOn",
      ]))) return false;
  const ids = value.report.hostIds;
  if (ids.length !== 2 || !ids.every(isSafeHostId) || ids[0] === ids[1] ||
      value.report.generatedAt !== value.admittedAt ||
      Object.keys(value.hostOids).sort().join("\0") !== [...ids].sort().join("\0") ||
      Object.keys(value.hostSequences).sort().join("\0") !== [...ids].sort().join("\0")) return false;
  return Object.values(value.hostOids).every((oid) => typeof oid === "string" && FULL_OID_PATTERN.test(oid)) &&
    Object.values(value.hostSequences).every((sequence) => Number.isSafeInteger(sequence) && (sequence as number) > 0);
}

export function isReconcileReport(value: unknown): value is ReconcileReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.expectedHostCount !== 2 ||
    !isDateString(value.generatedAt) ||
    !isStringArray(value.hostIds) ||
    !Array.isArray(value.repositories) ||
    !Array.isArray(value.actions) ||
    value.actions.length !== 0
  ) {
    return false;
  }
  return value.repositories.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.canonicalRemote === "string" &&
      (entry.desiredMode === null ||
        entry.desiredMode === "enabled" ||
        entry.desiredMode === "disabled" ||
        entry.desiredMode === "ignored") &&
      (entry.status === "managed" ||
        entry.status === "waiting-for-two-hosts" ||
        entry.status === "missing-on-host" ||
        entry.status === "blocked-duplicate-checkouts" ||
        entry.status === "disabled" ||
        entry.status === "ignored" ||
        entry.status === "unregistered") &&
      isStringArray(entry.presentOn) &&
      isStringArray(entry.missingOn),
  );
}
