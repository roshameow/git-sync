export const SCHEMA_VERSION = 1 as const;

export interface AppConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly roots: readonly string[];
  readonly excludedDirectories: readonly string[];
}

export interface HostIdentity {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly hostname: string;
  readonly createdAt: string;
}

export type GitMarkerKind = "directory" | "file";

export interface RepositoryRecord {
  readonly path: string;
  readonly gitMarker: GitMarkerKind;
  readonly worktree: boolean;
  readonly remoteName: string | null;
  /** Credential-free normalized identity; the raw remote URL is never persisted. */
  readonly canonicalRemote: string | null;
}

export interface HostInventory {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly hostId: string;
  readonly generatedAt: string;
  readonly roots: readonly string[];
  readonly repositories: readonly RepositoryRecord[];
}

export type RegistryMode = "enabled" | "disabled" | "ignored";

export interface RegistryEntry {
  readonly canonicalRemote: string;
  readonly mode: RegistryMode;
  readonly updatedAt: string;
}

export interface BusinessRepositoryIdentity {
  readonly canonicalRemote: string;
  readonly nodeId: string;
  readonly fullName: string;
  readonly checkoutDevice: string;
  readonly checkoutInode: string;
  readonly gitCommonDevice: string;
  readonly gitCommonInode: string;
  readonly verifiedAt: string;
}

export interface InboxRemoteConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly configuredAt: string;
  readonly remoteUrl: string;
  readonly canonicalRepository: string;
  readonly owner: string;
  readonly repository: string;
  readonly configuredHostId: string;
  readonly primaryHostId: string;
  readonly secondaryHostId: string;
}

export interface InboxRemoteVerification {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly canonicalRepository: string;
  readonly nodeId: string;
  readonly deployKeyId: number;
  readonly keyFingerprint: string;
  /** Scope of the pinned SSH deploy key only, not the human/gh API account. */
  readonly role: "primary-reader" | "secondary-writer";
  readonly verifiedAt: string;
}

/** Primary's immutable, out-of-band pin of the secondary's *public* inbox writer key. */
export interface SecondaryInboxKeyPin {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly canonicalRepository: string;
  readonly nodeId: string;
  readonly primaryHostId: string;
  readonly secondaryHostId: string;
  readonly role: "secondary-writer";
  readonly publicKey: string;
  readonly keyFingerprint: string;
  readonly pinnedAt: string;
}

export interface BusinessTransportVerification {
  readonly canonicalRemote: string;
  readonly repositoryNodeId: string;
  readonly remoteName: string;
  readonly endpointHost: "github.com";
  readonly advertisedRefsDigest: string;
  readonly receivePackDryRunObserved: true;
  readonly authorizationProven: false;
  readonly verifiedAt: string;
}

export interface BusinessTransportStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly repositories: Readonly<Record<string, BusinessTransportVerification>>;
}

export interface BusinessIdentityStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly repositories: Readonly<Record<string, BusinessRepositoryIdentity>>;
}

export interface DesiredRegistry {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly repositories: Readonly<Record<string, RegistryEntry>>;
}

/** Configuration for an already-existing private GitHub control repository. */
export interface RegistryRemoteConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly configuredAt: string;
  readonly remoteUrl: string;
  readonly canonicalRepository: string;
  readonly owner: string;
  readonly repository: string;
  readonly configuredHostId: string;
  readonly primaryHostId: string;
  readonly requiredHostIds: readonly [string, string];
}

/** Short-lived proof that the configured repository was private and writable. */
export interface RegistryRemoteVerification {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly canonicalRepository: string;
  readonly nodeId: string;
  readonly fullName: string;
  readonly verifiedAt: string;
}

/** Privacy-preserving host inventory published to the remote registry. */
export interface RegistryHostCheckout {
  readonly checkoutId: string;
  readonly canonicalRemote: string;
  readonly gitMarker: GitMarkerKind;
  readonly worktree: boolean;
  readonly remoteName: string | null;
  readonly repositoryNodeId: string;
}

export interface RegistryHostDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly protocolVersion: 2;
  readonly registryNodeId: string;
  readonly refName: string;
  readonly hostId: string;
  readonly role: "primary" | "secondary";
  readonly sequence: number;
  readonly previousOid: string | null;
  readonly generatedAt: string;
  readonly checkouts: readonly RegistryHostCheckout[];
}

export interface RegistrySignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface SignedRegistryHostDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: "host";
  readonly payload: RegistryHostDocument;
  readonly signature: RegistrySignature;
}

export interface RegistryDesiredRepository extends RegistryEntry {
  readonly repositoryNodeId: string | null;
}

export interface RegistryDesiredDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly protocolVersion: 2;
  readonly registryNodeId: string;
  readonly refName: string;
  readonly generation: number;
  readonly previousOid: string | null;
  readonly issuedAt: string;
  readonly primaryHostId: string;
  readonly requiredHostIds: readonly [string, string];
  readonly hostKeyIds: Readonly<Record<string, readonly string[]>>;
  readonly repositories: Readonly<Record<string, RegistryDesiredRepository>>;
}

export interface SignedRegistryDesiredDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: "desired";
  readonly payload: RegistryDesiredDocument;
  readonly signature: RegistrySignature;
}

export interface RegistrySigningKeyFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly algorithm: "ed25519";
  readonly hostId: string;
  readonly keyId: string;
  readonly createdAt: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface RegistryTrustedPublicKey {
  readonly algorithm: "ed25519";
  readonly hostId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly status: "active" | "retired";
  readonly addedAt: string;
}

export interface RegistryTrustStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly hosts: Readonly<Record<string, readonly RegistryTrustedPublicKey[]>>;
}

/** Durable, exclusive primary publication attempt; never an authorization grant. */
export interface RegistryPolicyPublicationIntent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly ref: string;
  readonly oid: string;
  readonly previousOid: string | null;
  readonly localExpectedOid: string | null;
  readonly desiredOid: string;
  readonly desiredGeneration: number;
  readonly registryCanonicalRepository: string;
  readonly registryNodeId: string;
  readonly primaryHostId: string;
  readonly secondaryHostId: string;
  readonly canonicalRemote: string;
  readonly repositoryNodeId: string;
  readonly inboxCanonicalRemote: string;
  readonly inboxRepositoryNodeId: string;
  readonly primaryInboxReadKeyFingerprint: string;
  readonly secondaryInboxKeyFingerprint: string;
  readonly policyGeneration: number;
}

export interface RegistryAdmissionReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly admittedAt: string;
  readonly desiredGeneration: number;
  readonly desiredOid: string;
  readonly hostOids: Readonly<Record<string, string>>;
  readonly hostSequences: Readonly<Record<string, number>>;
  readonly report: ReconcileReport;
}

export type ReconcileStatus =
  | "managed"
  | "waiting-for-two-hosts"
  | "missing-on-host"
  | "blocked-duplicate-checkouts"
  | "disabled"
  | "ignored"
  | "unregistered";

export interface ReconcileRepository {
  readonly canonicalRemote: string;
  readonly desiredMode: RegistryMode | null;
  readonly status: ReconcileStatus;
  readonly presentOn: readonly string[];
  readonly missingOn: readonly string[];
}

export interface ReconcileReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly expectedHostCount: 2;
  readonly hostIds: readonly string[];
  readonly repositories: readonly ReconcileRepository[];
  readonly actions: readonly never[];
}

export const BRIDGE_PRODUCER = "pi-git-sync-bridge" as const;
export type BridgeEventType =
  | "session.registered"
  | "commit.observed"
  | "session.unregistered";

export interface BridgeEvidence {
  readonly source: "pi-extension";
  readonly trigger:
    | "session_start"
    | "tool_execution_end"
    | "agent_settled"
    | "session_shutdown";
  readonly observation: "session-lifecycle" | "git-head-transition";
  readonly reason?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolError?: boolean;
  readonly baselineCapturedAt?: string | null;
}

export interface BridgeEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly eventId: string;
  readonly eventType: BridgeEventType;
  readonly occurredAt: string;
  readonly producer: typeof BRIDGE_PRODUCER;
  readonly hostId: string;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly repoRoot: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly newCommitOids: readonly string[];
  readonly evidence: BridgeEvidence;
  readonly confidence: "high" | "medium";
}

export interface SessionProjectionEntry {
  readonly hostId: string;
  readonly sessionId: string;
  readonly repositoryPath: string;
  readonly sessionFile: string | null;
  readonly status: "active" | "offline";
  readonly startedAt: string;
  readonly lastEventAt: string;
  readonly lastEventId: string;
}

export interface SessionRegistry {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly projectedAt: string;
  readonly sessions: Readonly<Record<string, SessionProjectionEntry>>;
}

export type ExplicitProvenanceSource =
  | "manual"
  | "vscode"
  | "chatgpt-work"
  | "automation"
  | "external-agent";
export type ProvenanceSource = ExplicitProvenanceSource | "pi" | "unknown-local" | "remote";
export type ProvenanceClassification = "observed" | "created-candidate" | "attributed";

export interface CommitAttribution {
  readonly attributionId: string;
  readonly source: ProvenanceSource;
  readonly classification: ProvenanceClassification;
  readonly recordedAt: string;
  readonly hostId: string;
  readonly evidence: "bridge-claim" | "local-refs" | "explicit";
  readonly nonExclusive: true;
  readonly eventId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly refName?: string;
}

export interface CommitProvenanceEntry {
  readonly repositoryPath: string;
  readonly oid: string;
  readonly attributions: readonly CommitAttribution[];
}

export interface ProvenanceStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly commits: readonly CommitProvenanceEntry[];
}

export type IncidentSeverity = "yellow" | "red";

export interface IncidentRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly incidentId: string;
  readonly incidentType: "daemon.pass.failed" | "registry.admission.rejected" | "sync.attention";
  readonly severity: IncidentSeverity;
  readonly occurredAt: string;
  readonly hostId: string;
  readonly reasonCode: string;
  readonly summary: string;
}

export interface IncidentAcknowledgement {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly incidentId: string;
  readonly acknowledgedAt: string;
  readonly hostId: string;
}

export interface GuardianRoutingConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly hostId: string;
  readonly generation: number;
  readonly targetSessionId: string;
  readonly itemKey: string;
  readonly senderScript: string;
  readonly senderSha256: string;
  readonly configuredAt: string;
}

export interface GuardianDispatchReceipt {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly incidentId: string;
  readonly eventId: string;
  readonly routingGeneration: number;
  readonly targetSessionId: string;
  readonly senderSha256: string;
  readonly dispatchedAt: string;
}

export interface LaunchAgentReceipt {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly label: string;
  readonly uid: number;
  readonly installationId: string;
  readonly plistPath: string;
  readonly plistSha256: string;
  readonly nodeExecutable: string;
  readonly cliEntrypoint: string;
  readonly installedAt: string;
  readonly status: "prepared" | "loaded" | "uninstalling" | "unloaded";
  readonly updatedAt: string;
  readonly quarantinedPlistPath: string | null;
}

export interface DaemonRuntimeState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly mode: "local-only" | "direct-peer" | "upstream" | "direct-peer+upstream" | "guardian-monitor";
  readonly lifecycle: "running" | "stopped";
  readonly pid: number;
  readonly instanceId: string;
  readonly hostId: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly stoppedAt: string | null;
  readonly lastPassStartedAt: string | null;
  readonly lastPassCompletedAt: string | null;
  readonly nextSafetyPassAt: string;
  readonly completedPasses: number;
  readonly wakeups: number;
  readonly watchedRepositories: number;
  readonly lastTrigger: string | null;
  readonly lastError: string | null;
}

export interface RepositoryRefsSnapshot {
  readonly repositoryPath: string;
  readonly refs: Readonly<Record<string, string>>;
}

export interface RefsSnapshotStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly repositories: readonly RepositoryRefsSnapshot[];
}
