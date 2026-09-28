import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { readJson, writeJsonAtomic } from "./storage.js";
import { isAppConfig } from "./validation.js";

export interface AppPaths {
  readonly configFile: string;
  readonly stateDirectory: string;
  readonly hostFile: string;
  readonly inventoryDirectory: string;
  readonly registryFile: string;
  readonly businessIdentityFile: string;
  readonly businessTransportFile: string;
  readonly inboxRemoteConfigFile: string;
  readonly inboxRemoteVerificationFile: string;
  readonly secondaryInboxKeyPinFile: string;
  readonly registryRemoteConfigFile: string;
  readonly registryRemoteVerificationFile: string;
  readonly registryControlDirectory: string;
  readonly registryControlLockFile: string;
  readonly registryCheckoutKeyFile: string;
  readonly registrySigningKeyFile: string;
  readonly registryTrustFile: string;
  readonly registryAdmissionFile: string;
  readonly registryPolicyIntentFile: string;
  readonly daemonLockFile: string;
  readonly stateMutationLockFile: string;
  readonly daemonRuntimeFile: string;
  readonly daemonWakeFile: string;
  readonly daemonLockQuarantineDirectory: string;
  readonly launchAgentReceiptFile: string;
  readonly daemonStdoutFile: string;
  readonly daemonStderrFile: string;
  readonly incidentDirectory: string;
  readonly incidentAcknowledgementDirectory: string;
  readonly guardianConfigFile: string;
  readonly guardianSenderDirectory: string;
  readonly guardianEventDirectory: string;
  readonly guardianDispatchDirectory: string;
  readonly guardianDispatchLockFile: string;
  readonly reconcileFile: string;
  readonly bridgeDirectory: string;
  readonly bridgeOutboxDirectory: string;
  readonly bridgeClaimsDirectory: string;
  readonly bridgeAcceptedDirectory: string;
  readonly bridgeQuarantineDirectory: string;
  readonly sessionsFile: string;
  readonly provenanceFile: string;
  readonly refsSnapshotFile: string;
}

export function resolveAppPaths(environment: NodeJS.ProcessEnv = process.env): AppPaths {
  const override = environment.GIT_SYNC_HOME;
  if (override !== undefined && override.trim() !== "") {
    const base = resolve(override);
    return makePaths(resolve(base, "config.json"), resolve(base, "state"));
  }

  const home = environment.HOME ?? homedir();
  const configBase = environment.XDG_CONFIG_HOME ?? resolve(home, ".config");
  const stateBase = environment.XDG_STATE_HOME ?? resolve(home, ".local", "state");
  return makePaths(resolve(configBase, "git-sync", "config.json"), resolve(stateBase, "git-sync"));
}

function makePaths(configFile: string, stateDirectory: string): AppPaths {
  const bridgeDirectory = resolve(stateDirectory, "bridge");
  const bridgeOutboxDirectory = resolve(dirname(configFile), "bridge-outbox");
  return {
    configFile,
    stateDirectory,
    hostFile: resolve(stateDirectory, "host.json"),
    inventoryDirectory: resolve(stateDirectory, "inventories"),
    registryFile: resolve(stateDirectory, "desired.json"),
    businessIdentityFile: resolve(stateDirectory, "business-identities.json"),
    businessTransportFile: resolve(stateDirectory, "business-transports.json"),
    inboxRemoteConfigFile: resolve(dirname(configFile), "inbox-remote.json"),
    inboxRemoteVerificationFile: resolve(stateDirectory, "inbox-remote-verification.json"),
    secondaryInboxKeyPinFile: resolve(stateDirectory, "secondary-inbox-key-pin.json"),
    registryRemoteConfigFile: resolve(dirname(configFile), "registry-remote.json"),
    registryRemoteVerificationFile: resolve(stateDirectory, "registry-remote-verification.json"),
    registryControlDirectory: resolve(stateDirectory, "registry-control.git"),
    registryControlLockFile: resolve(stateDirectory, "registry-control.lock"),
    registryCheckoutKeyFile: resolve(stateDirectory, "registry-checkout-key"),
    registrySigningKeyFile: resolve(stateDirectory, "registry-signing-key.json"),
    registryTrustFile: resolve(stateDirectory, "registry-trust.json"),
    registryAdmissionFile: resolve(stateDirectory, "registry-admission.json"),
    registryPolicyIntentFile: resolve(stateDirectory, "registry-policy-intent.json"),
    daemonLockFile: resolve(stateDirectory, "daemon.lock"),
    stateMutationLockFile: resolve(stateDirectory, "state-mutation.lock"),
    daemonRuntimeFile: resolve(stateDirectory, "daemon-runtime.json"),
    daemonWakeFile: resolve(stateDirectory, "daemon-wake.json"),
    daemonLockQuarantineDirectory: resolve(stateDirectory, "quarantine", "locks"),
    launchAgentReceiptFile: resolve(stateDirectory, "launch-agent-receipt.json"),
    daemonStdoutFile: resolve(stateDirectory, "daemon.stdout.log"),
    daemonStderrFile: resolve(stateDirectory, "daemon.stderr.log"),
    incidentDirectory: resolve(stateDirectory, "incidents"),
    incidentAcknowledgementDirectory: resolve(stateDirectory, "incident-acknowledgements"),
    guardianConfigFile: resolve(stateDirectory, "guardian.json"),
    guardianSenderDirectory: resolve(stateDirectory, "guardian-senders"),
    guardianEventDirectory: resolve(stateDirectory, "guardian-events"),
    guardianDispatchDirectory: resolve(stateDirectory, "guardian-dispatches"),
    guardianDispatchLockFile: resolve(stateDirectory, "guardian-dispatch.lock"),
    reconcileFile: resolve(stateDirectory, "reconcile.json"),
    bridgeDirectory,
    bridgeOutboxDirectory,
    // Claims live under the producer outbox so ownership is always acquired by
    // a same-filesystem atomic rename, even when config/state use separate mounts.
    bridgeClaimsDirectory: resolve(bridgeOutboxDirectory, ".claims"),
    bridgeAcceptedDirectory: resolve(bridgeDirectory, "accepted"),
    bridgeQuarantineDirectory: resolve(bridgeDirectory, "quarantine"),
    sessionsFile: resolve(stateDirectory, "sessions.json"),
    provenanceFile: resolve(stateDirectory, "provenance.json"),
    refsSnapshotFile: resolve(stateDirectory, "refs-snapshot.json"),
  };
}

export function createConfig(
  roots: readonly string[],
  excludedDirectories: readonly string[],
  cwd = process.cwd(),
  home = homedir(),
): AppConfig {
  if (roots.length === 0) throw new Error("At least one discovery root is required");
  return {
    schemaVersion: SCHEMA_VERSION,
    roots: uniqueSorted(roots.map((root) => resolveConfiguredPath(root, cwd, home))),
    excludedDirectories: uniqueSorted(
      excludedDirectories.map((entry) =>
        entry.includes("/") || entry.includes("\\")
          ? resolveConfiguredPath(entry, cwd, home)
          : entry,
      ),
    ),
  };
}

function resolveConfiguredPath(value: string, cwd: string, home: string): string {
  if (value === "~") return resolve(home);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(home, value.slice(2));
  }
  if (value.startsWith("~")) {
    throw new Error(`Unsupported home path (use ~ or ~/path): ${value}`);
  }
  return resolve(cwd, value);
}

export async function loadConfig(paths: AppPaths): Promise<AppConfig> {
  return readJson(paths.configFile, isAppConfig);
}

export async function saveConfig(paths: AppPaths, config: AppConfig): Promise<void> {
  await writeJsonAtomic(paths.configFile, config);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
