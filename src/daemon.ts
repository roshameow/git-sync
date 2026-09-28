import { watch, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { consumeBridgeOutbox } from "./bridge.js";
import { acquireOwnedLocalLock, releaseOwnedLocalLock, withOwnedLocalLock } from "./local-lock.js";
import { runGitRead } from "./git.js";
import { loadDirectSyncConfig, runDirectSyncOnce } from "./direct-sync-service.js";
import { recordSyncAttention } from "./sync-attention.js";
import { loadUpstreamSyncConfig, runUpstreamSyncOnce, upstreamSyncStatus } from "./upstream-sync-service.js";
import { recordUpstreamSyncAttention } from "./upstream-sync-attention.js";
import { dispatchGuardianIncidents } from "./guardian.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import { loadHostIdentity } from "./host.js";
import { recordIncident } from "./incidents.js";
import { loadHostInventory } from "./inventory.js";
import { loadProvenance } from "./provenance.js";
import { loadRefsSnapshot, scanLocalRefs } from "./refs.js";
import { loadRegistry } from "./registry.js";
import { assertAppPathsOutsideGitRepositories } from "./safety.js";
import { withStateMutationLock } from "./state-mutation.js";
import { isNodeError, pathExists, readJson, writeJsonAtomic } from "./storage.js";
import type { DaemonRuntimeState, SessionRegistry } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_SAFETY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_RUNTIME_ERROR_LENGTH = 2_000;

export interface DaemonServiceOptions {
  readonly signal?: AbortSignal;
  readonly debounceMs?: number;
  readonly maxDebounceMs?: number;
  readonly heartbeatMs?: number;
  readonly safetyIntervalMs?: number;
  readonly installSignalHandlers?: boolean;
}

export async function runDaemonOnce(paths: AppPaths, options: { signal?: AbortSignal } = {}): Promise<{
  bridge: Awaited<ReturnType<typeof consumeBridgeOutbox>>;
  refs: Awaited<ReturnType<typeof scanLocalRefs>>;
}> {
  return withOwnedLocalLock(paths.daemonLockFile, "Daemon", async () => {
    const local = await performDaemonPass(paths);
    await runDirectSyncOnce(paths, options);
    await runUpstreamSyncOnce(paths, options);
    return local;
  });
}

async function performDaemonPass(paths: AppPaths): Promise<{
  bridge: Awaited<ReturnType<typeof consumeBridgeOutbox>>;
  refs: Awaited<ReturnType<typeof scanLocalRefs>>;
}> {
  return withStateMutationLock(paths, async () => {
    await assertAppPathsOutsideGitRepositories(paths);
    const bridge = await consumeBridgeOutbox(paths);
    const refs = await scanLocalRefs(paths);
    return { bridge, refs };
  });
}

/**
 * Run the local observer and explicitly configured peer/upstream transfers.
 * A workflow primary with a peer also monitors peer upstream status, independent
 * of local sync enrollment. Legacy publication remains disconnected; routine
 * observation needs no Pi session or model tokens.
 */
export async function runDaemonService(
  paths: AppPaths,
  options: DaemonServiceOptions = {},
): Promise<DaemonRuntimeState> {
  const debounceMs = boundedInterval(options.debounceMs, DEFAULT_DEBOUNCE_MS, 10, 60_000);
  const maxDebounceMs = boundedInterval(options.maxDebounceMs, 5_000, debounceMs, 5 * 60_000);
  const heartbeatMs = boundedInterval(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 100, 10 * 60_000);
  const safetyIntervalMs = boundedInterval(
    options.safetyIntervalMs,
    DEFAULT_SAFETY_INTERVAL_MS,
    1_000,
    24 * 60 * 60 * 1000,
  );
  // Validate required identity before creating a lifecycle lock so an
  // uninitialized/corrupt installation cannot strand an unrecoverable lock.
  const identity = await loadHostIdentity(paths);
  const lock = await acquireOwnedLocalLock(paths.daemonLockFile, "Daemon");
  const started = new Date();
  const controller = new AbortController();
  const externalSignal = options.signal;
  const watchers: FSWatcher[] = [];
  let repositoryWatchers: FSWatcher[] = [];
  let debounceTimer: NodeJS.Timeout | null = null;
  let maxDebounceTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let safetyTimer: NodeJS.Timeout | null = null;
  let peerTimer: NodeJS.Timeout | null = null;
  let nextPeerSyncAt = 0;
  let latestPeerError: string | null = null;
  let latestUpstreamError: string | null = null;
  let nextUpstreamSyncAt = 0;
  let nextUpstreamAttentionAt = 0;
  let polling = false;
  const signalFiles = [paths.configFile, resolve(dirname(paths.configFile), "workflow.json"),
    resolve(paths.stateDirectory, "direct-sync.json"), resolve(paths.stateDirectory, "upstream-sync.json"), paths.daemonWakeFile];
  const signalVersions = new Map<string, string>();
  const signalVersion = async (file: string) => {
    try {
      const st = await lstat(file);
      return [st.dev, st.ino, st.mode, st.uid, st.size, st.mtimeMs, st.ctimeMs].join(":");
    } catch (error) { return `unavailable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`; }
  };
  let passPromise: Promise<void> | null = null;
  let pending = false;
  let pendingWake = false;
  let pendingTrigger = "startup";
  let passFailureIncidentOpen = false;
  let stateWrite: Promise<void> = Promise.resolve();
  let runtime: DaemonRuntimeState = {
    schemaVersion: SCHEMA_VERSION,
    mode: "local-only",
    lifecycle: "running",
    pid: process.pid,
    instanceId: lock.nonce,
    hostId: identity.id,
    startedAt: started.toISOString(),
    heartbeatAt: started.toISOString(),
    stoppedAt: null,
    lastPassStartedAt: null,
    lastPassCompletedAt: null,
    nextSafetyPassAt: new Date(started.getTime() + safetyIntervalMs).toISOString(),
    completedPasses: 0,
    wakeups: 0,
    watchedRepositories: 0,
    lastTrigger: null,
    lastError: null,
  };

  const persistRuntime = async (): Promise<void> => {
    const snapshot = runtime;
    stateWrite = stateWrite.then(() => writeJsonAtomic(paths.daemonRuntimeFile, snapshot));
    await stateWrite;
  };

  const refreshRepositoryWatchers = async (): Promise<void> => {
    for (const watcher of repositoryWatchers) watcher.close();
    repositoryWatchers = [];
    const [inventory, registry] = await Promise.all([loadHostInventory(paths, identity.id), loadRegistry(paths)]);
    if (inventory === null) {
      runtime = { ...runtime, watchedRepositories: 0 };
      return;
    }
    const watchedDirectories = new Set<string>();
    for (const repository of inventory.repositories) {
      if (repository.canonicalRemote === null || registry.repositories[repository.canonicalRemote]?.mode !== "enabled") continue;
      try {
        const commonDirectory = (await runGitRead(repository.path, [
          "rev-parse", "--path-format=absolute", "--git-common-dir",
        ])).trim();
        const resolved = resolve(repository.path, commonDirectory);
        if (watchedDirectories.has(resolved)) continue;
        watchedDirectories.add(resolved);
        const watcher = watch(resolved, { recursive: true }, (_event, filename) => {
          const name = filename?.toString().replaceAll("\\", "/") ?? "";
          if (name === "HEAD" || name === "packed-refs" || name.startsWith("refs/")) {
            requestPass("repository-ref-change");
          }
        });
        watcher.on("error", () => requestPass("repository-watch-error"));
        repositoryWatchers.push(watcher);
      } catch {
        // A periodic pass remains the safety net when a platform/filesystem
        // cannot provide a recursive watch for this repository.
      }
    }
    runtime = { ...runtime, watchedRepositories: repositoryWatchers.length };
  };

  const drainPasses = async (): Promise<void> => {
    while (pending && !controller.signal.aborted) {
      pending = false;
      const trigger = pendingTrigger;
      const forceSync = pendingWake;
      pendingWake = false;
      let shouldDispatchGuardian = trigger === "startup" || trigger === "periodic-safety-pass" || trigger === "incident-change";
      const passStarted = new Date();
      runtime = {
        ...runtime,
        lastPassStartedAt: passStarted.toISOString(),
        lastTrigger: trigger,
        lastError: null,
      };
      await persistRuntime();
      try {
        await performDaemonPass(paths);
        const directConfig = await loadDirectSyncConfig(paths);
        const upstreamConfig = await loadUpstreamSyncConfig(paths);
        const workflow = await loadWorkflowConfig(paths);
        const monitorPeer = workflow.primaryHostId === identity.id &&
          Object.keys(workflow.peers).some(id => id !== identity.id);
        runtime = { ...runtime, mode: directConfig ? (upstreamConfig ? "direct-peer+upstream" : "direct-peer")
          : upstreamConfig ? "upstream" : monitorPeer ? "guardian-monitor" : "local-only" };
        // Network I/O never holds the global observer/state mutation lock. The
        // peer service has its own serialized lock and cancellation boundary.
        if (!directConfig) latestPeerError = null;
        if (directConfig && !controller.signal.aborted && (Date.now() >= nextPeerSyncAt || forceSync)) {
          try {
            const direct = await runDirectSyncOnce(paths, { signal: controller.signal });
            latestPeerError = direct?.repositories.some(row => row.state === "error")
              ? "Direct peer sync failed; inspect git-sync sync status" : null;
            if (direct) {
              await recordSyncAttention(paths, direct);
              // Existing sender receipts dedupe successful deliveries; retry
              // queued attention without waking the model on routine success.
              shouldDispatchGuardian = true;
            }
          } catch (error) {
            latestPeerError = boundedError(error);
            throw error;
          } finally { nextPeerSyncAt = Date.now() + directConfig.intervalSeconds * 1000; }
        }
        if (!upstreamConfig) latestUpstreamError = null;
        if (upstreamConfig && !controller.signal.aborted && (Date.now() >= nextUpstreamSyncAt || forceSync)) {
          try {
            const upstream = await runUpstreamSyncOnce(paths, { signal: controller.signal });
            latestUpstreamError = upstream?.repositories.some(row => row.state === "error")
              ? "GitHub upstream sync failed; inspect git-sync sync upstream status" : null;
          } catch (error) {
            latestUpstreamError = boundedError(error);
            throw error;
          } finally { nextUpstreamSyncAt = Date.now() + upstreamConfig.intervalSeconds * 1000; }
        }
        // The primary also monitors the peer's local-only repositories. It only
        // reads bounded status over the existing pinned connection, never needs
        // a local checkout, and routes problems via the existing Guardian sender.
        if (runtime.mode !== "local-only" && !controller.signal.aborted &&
            (Date.now() >= nextUpstreamAttentionAt || forceSync)) {
          await recordUpstreamSyncAttention(paths, upstreamConfig ? await upstreamSyncStatus(paths) : null,
            { signal: controller.signal });
          nextUpstreamAttentionAt = Date.now() + 30_000;
          shouldDispatchGuardian = true;
        }
        await refreshRepositoryWatchers();
        runtime = {
          ...runtime,
          completedPasses: runtime.completedPasses + 1,
          lastPassCompletedAt: new Date().toISOString(),
          lastError: latestPeerError ?? latestUpstreamError,
        };
        passFailureIncidentOpen = false;
      } catch (error: unknown) {
        runtime = {
          ...runtime,
          lastPassCompletedAt: new Date().toISOString(),
          lastError: boundedError(error),
        };
        if (!passFailureIncidentOpen) {
          try {
            await recordIncident(paths, {
              incidentType: runtime.mode !== "local-only" ? "sync.attention" : "daemon.pass.failed",
              severity: "yellow",
              reasonCode: "local-pass-failed",
              summary: "The local observer pass failed closed; inspect daemon status and local state",
            });
            passFailureIncidentOpen = true;
            shouldDispatchGuardian = true;
          } catch (incidentError: unknown) {
            runtime = { ...runtime, lastError: `incident journal failure: ${boundedError(incidentError)}` };
          }
        }
      }
      if (shouldDispatchGuardian) {
        try {
          await dispatchGuardianIncidents(paths, new Date(),
            runtime.mode !== "local-only" ? { incidentTypes: ["sync.attention"] } : {});
        } catch (dispatchError: unknown) {
          runtime = { ...runtime, lastError: `guardian dispatch failure: ${boundedError(dispatchError)}` };
        }
      }
      await persistRuntime();
    }
  };

  const startDrain = (): void => {
    if (passPromise !== null || controller.signal.aborted) return;
    passPromise = drainPasses()
      .catch((error: unknown) => {
        runtime = { ...runtime, lastError: boundedError(error) };
        controller.abort();
      })
      .finally(() => {
        passPromise = null;
        if (pending && !controller.signal.aborted) startDrain();
      });
  };

  const requestPass = (trigger: string, immediate = false): void => {
    if (controller.signal.aborted) return;
    if (trigger === "config-change" || trigger === "signal-reload") nextUpstreamAttentionAt = 0;
    pending = true;
    pendingTrigger = trigger;
    // Later config/ref hints may replace the diagnostic label, but cannot erase
    // an explicit wake queued behind an already running pass.
    if (trigger === "signal-wake") pendingWake = true;
    runtime = { ...runtime, wakeups: runtime.wakeups + 1, lastTrigger: trigger };
    const begin = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (maxDebounceTimer !== null) clearTimeout(maxDebounceTimer);
      debounceTimer = null;
      maxDebounceTimer = null;
      startDrain();
    };
    if (immediate) {
      begin();
      return;
    }
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(begin, debounceMs);
    if (maxDebounceTimer === null) maxDebounceTimer = setTimeout(begin, maxDebounceMs);
  };

  // Function declarations above close over requestPass; watchers are installed
  // only after all closures have been initialized.
  const installDirectoryWatcher = async (
    directory: string,
    trigger: string,
    filter?: (filename: string) => boolean,
  ): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const watcher = watch(directory, (_event, filename) => {
      const name = filename?.toString() ?? "";
      if (filter === undefined || filter(name)) requestPass(trigger);
    });
    watcher.on("error", () => requestPass(`${trigger}-watch-error`));
    watchers.push(watcher);
  };

  const stop = (): void => controller.abort();
  const reload = (): void => requestPass("signal-reload", true);
  const wakeFromSignal = (): void => requestPass("signal-wake", true);
  const installSignals = options.installSignalHandlers !== false;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", stop, { once: true });
  }
  if (installSignals) {
    // Keep listeners present through asynchronous cleanup. SDK dependencies
    // using signal-exit can re-send the signal if a once-listener disappears
    // before cleanup settles, terminating before our owned locks are released.
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", reload);
    process.on("SIGUSR1", wakeFromSignal);
  }

  try {
    await installDirectoryWatcher(paths.bridgeOutboxDirectory, "bridge-outbox", (name) => name.endsWith(".json"));
    await installDirectoryWatcher(paths.inventoryDirectory, "inventory-change", (name) => name.endsWith(".json"));
    await installDirectoryWatcher(paths.incidentDirectory, "incident-change", (name) => name.endsWith(".json"));
    await installDirectoryWatcher(dirname(paths.registryFile), "local-state-change", (name) =>
      name === basename(paths.registryFile) || name === "direct-sync.json" || name === "upstream-sync.json");
    // An explicit sync wake requests peer work now, not merely an observer pass
    // that can be skipped until the next polling deadline.
    await installDirectoryWatcher(dirname(paths.daemonWakeFile), "signal-wake", (name) =>
      name === basename(paths.daemonWakeFile));
    await installDirectoryWatcher(dirname(paths.configFile), "config-change", (name) =>
      name === basename(paths.configFile) || name === "workflow.json");
    for (const file of signalFiles) signalVersions.set(file, await signalVersion(file));
    await refreshRepositoryWatchers();
    await persistRuntime();

    heartbeatTimer = setInterval(() => {
      runtime = { ...runtime, heartbeatAt: new Date().toISOString() };
      void persistRuntime().catch(() => controller.abort());
    }, heartbeatMs);
    safetyTimer = setInterval(() => {
      const next = new Date(Date.now() + safetyIntervalMs).toISOString();
      runtime = { ...runtime, nextSafetyPassAt: next };
      requestPass("periodic-safety-pass", true);
    }, safetyIntervalMs);
    peerTimer = setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      void (async () => {
        // fs.watch is a hint: macOS may coalesce atomic replacements. A bounded
        // metadata poll also runs in local-only mode, so a missed wake/config
        // event cannot strand a new enrollment until the 15-minute safety pass.
        for (const file of signalFiles) {
          const version = await signalVersion(file);
          if (controller.signal.aborted) return;
          if (version !== signalVersions.get(file)) {
            signalVersions.set(file, version);
            requestPass(file === paths.daemonWakeFile ? "signal-wake" : "config-change", true);
          }
        }
        const now = Date.now();
        if (((runtime.mode === "direct-peer" || runtime.mode === "direct-peer+upstream") && now >= nextPeerSyncAt) ||
            ((runtime.mode === "upstream" || runtime.mode === "direct-peer+upstream") && now >= nextUpstreamSyncAt) ||
            (runtime.mode !== "local-only" && now >= nextUpstreamAttentionAt)) requestPass("sync-poll", true);
      })().finally(() => { polling = false; });
    }, 5_000);
    requestPass("startup", true);
    // The normal interactive Guardian is a separate Pi process. This daemon
    // sends persisted events through the existing notification channel only.

    if (!controller.signal.aborted) {
      await new Promise<void>((resolveStop) => controller.signal.addEventListener("abort", () => resolveStop(), { once: true }));
    }
  } finally {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maxDebounceTimer !== null) clearTimeout(maxDebounceTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    if (safetyTimer !== null) clearInterval(safetyTimer);
    if (peerTimer !== null) clearInterval(peerTimer);
    for (const watcher of watchers) watcher.close();
    pending = false;
    await Promise.resolve(passPromise).catch(() => undefined);
    // A pass that was already running may have rebuilt repository watchers;
    // close the final set only after that pass has settled.
    for (const watcher of repositoryWatchers) watcher.close();
    repositoryWatchers = [];
    runtime = {
      ...runtime,
      lifecycle: "stopped",
      heartbeatAt: new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
    };
    await persistRuntime().catch(() => undefined);
    await stateWrite.catch(() => undefined);
    if (externalSignal !== undefined) externalSignal.removeEventListener("abort", stop);
    try { await releaseOwnedLocalLock(lock); }
    finally {
      if (installSignals) {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGHUP", reload);
        process.removeListener("SIGUSR1", wakeFromSignal);
      }
    }
  }
  return runtime;
}

export async function wakeDaemon(paths: AppPaths, now: Date = new Date()): Promise<{ readonly requestedAt: string }> {
  const value = { schemaVersion: SCHEMA_VERSION, requestedAt: now.toISOString() };
  await writeJsonAtomic(paths.daemonWakeFile, value);
  return { requestedAt: value.requestedAt };
}

export async function daemonStatus(paths: AppPaths): Promise<{
  acceptedEvents: number;
  quarantinedEvents: number;
  activeSessions: number;
  offlineSessions: number;
  provenanceCommits: number;
  attributions: number;
  refsBaselines: number;
  lastRefsScanAt: string | null;
  service: {
    lockPresent: boolean;
    heartbeatFresh: boolean;
    runtime: DaemonRuntimeState | null;
  };
}> {
  const [acceptedEvents, quarantinedEvents, provenance, refs, sessions, runtime, lockPresent] = await Promise.all([
    countJsonFiles(paths.bridgeAcceptedDirectory),
    countJsonFiles(paths.bridgeQuarantineDirectory),
    loadProvenance(paths),
    loadRefsSnapshot(paths),
    loadSessionsIfPresent(paths),
    loadDaemonRuntimeIfPresent(paths),
    pathExists(paths.daemonLockFile),
  ]);
  const sessionEntries = sessions === null ? [] : Object.values(sessions.sessions);
  const heartbeatFresh = runtime !== null && runtime.lifecycle === "running" &&
    Date.now() - Date.parse(runtime.heartbeatAt) <= 2 * DEFAULT_HEARTBEAT_MS;
  return {
    acceptedEvents,
    quarantinedEvents,
    activeSessions: sessionEntries.filter((entry) => entry.status === "active").length,
    offlineSessions: sessionEntries.filter((entry) => entry.status === "offline").length,
    provenanceCommits: provenance.commits.length,
    attributions: provenance.commits.reduce((sum, entry) => sum + entry.attributions.length, 0),
    refsBaselines: refs.repositories.length,
    lastRefsScanAt: refs.updatedAt === new Date(0).toISOString() ? null : refs.updatedAt,
    service: { lockPresent, heartbeatFresh, runtime },
  };
}

async function countJsonFiles(directory: string): Promise<number> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(".json")).length;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function loadSessionsIfPresent(paths: AppPaths): Promise<SessionRegistry | null> {
  if (!(await pathExists(paths.sessionsFile))) return null;
  return readJson(paths.sessionsFile, isSessionRegistry);
}

export async function loadDaemonRuntimeIfPresent(paths: AppPaths): Promise<DaemonRuntimeState | null> {
  if (!(await pathExists(paths.daemonRuntimeFile))) return null;
  return readJson(paths.daemonRuntimeFile, isDaemonRuntimeState);
}

function isDaemonRuntimeState(value: unknown): value is DaemonRuntimeState {
  return isPlainObject(value) && hasExactKeys(value, [
    "schemaVersion", "mode", "lifecycle", "pid", "instanceId", "hostId", "startedAt", "heartbeatAt", "stoppedAt",
    "lastPassStartedAt", "lastPassCompletedAt", "nextSafetyPassAt", "completedPasses", "wakeups",
    "watchedRepositories", "lastTrigger", "lastError",
  ]) && value.schemaVersion === 1 && ["local-only", "direct-peer", "upstream", "direct-peer+upstream", "guardian-monitor"].includes(value.mode as string) &&
    (value.lifecycle === "running" || value.lifecycle === "stopped") &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    typeof value.instanceId === "string" && /^[0-9a-f-]{36}$/.test(value.instanceId) &&
    typeof value.hostId === "string" &&
    isDateString(value.startedAt) && isDateString(value.heartbeatAt) && isNullableDate(value.stoppedAt) &&
    isNullableDate(value.lastPassStartedAt) && isNullableDate(value.lastPassCompletedAt) &&
    isDateString(value.nextSafetyPassAt) && Number.isSafeInteger(value.completedPasses) &&
    (value.completedPasses as number) >= 0 && Number.isSafeInteger(value.wakeups) &&
    (value.wakeups as number) >= 0 && Number.isSafeInteger(value.watchedRepositories) &&
    (value.watchedRepositories as number) >= 0 &&
    (value.lastTrigger === null || typeof value.lastTrigger === "string") &&
    (value.lastError === null || (typeof value.lastError === "string" && value.lastError.length <= MAX_RUNTIME_ERROR_LENGTH));
}

function isSessionRegistry(value: unknown): value is SessionRegistry {
  if (!isPlainObject(value)) return false;
  if (
    !hasExactKeys(value, ["schemaVersion", "projectedAt", "sessions"]) ||
    value.schemaVersion !== 1 ||
    typeof value.projectedAt !== "string" ||
    !isPlainObject(value.sessions)
  ) return false;
  return Object.values(value.sessions).every((entry) =>
    isPlainObject(entry) &&
    hasExactKeys(entry, [
      "hostId", "sessionId", "repositoryPath", "sessionFile", "status", "startedAt", "lastEventAt", "lastEventId",
    ]) &&
    typeof entry.hostId === "string" && typeof entry.sessionId === "string" &&
    typeof entry.repositoryPath === "string" &&
    (entry.sessionFile === null || typeof entry.sessionFile === "string") &&
    (entry.status === "active" || entry.status === "offline") &&
    typeof entry.startedAt === "string" && typeof entry.lastEventAt === "string" &&
    typeof entry.lastEventId === "string",
  );
}

function boundedInterval(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`Daemon interval must be an integer between ${minimum} and ${maximum} milliseconds`);
  }
  return selected;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_RUNTIME_ERROR_LENGTH);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDateString(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}
