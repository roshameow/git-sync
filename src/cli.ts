#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConfig, loadConfig, resolveAppPaths, saveConfig } from "./config.js";
import { daemonStatus, runDaemonOnce, runDaemonService, wakeDaemon } from "./daemon.js";
import { directSyncStatus, loadDirectSyncConfig, runDirectSyncOnce } from "./direct-sync-service.js";
import { configureUpstreamSync, loadUpstreamSyncConfig, runUpstreamSyncOnce, upstreamSyncStatus } from "./upstream-sync-service.js";
import { inspectUpstreamSyncSources } from "./upstream-sync-attention.js";
import { previewGuardianRepository } from "./guardian-preview-command.js";
import { registerGuardianSession } from "./guardian-register.js";
import { guardianDesktopStatus } from "./guardian-desktop-status.js";
import { inspectGuardianLocal, inspectGuardianBoth, requestGuardianSync } from "./guardian-sync-inspect.js";
import { discoverRepositories, inspectRepositoryPath } from "./discovery.js";
import { clearDaemonLock, inspectDaemonLock } from "./doctor.js";
import {
  configureGuardianRouting,
  dispatchGuardianIncidents,
  guardianCandidates,
  guardianStatus,
} from "./guardian.js";
import { acknowledgeIncident, getIncident, listIncidents } from "./incidents.js";
import { renderLaunchAgent } from "./launch-agent.js";
import {
  installLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
} from "./launch-agent-lifecycle.js";
import { createHostIdentity, loadHostIdentity, saveHostIdentity } from "./host.js";
import { saveInventory } from "./inventory.js";
import { validateOid } from "./git.js";
import { normalizeRemote } from "./remote.js";
import {
  filterProvenance,
  isExplicitProvenanceSource,
  loadProvenance,
  recordExplicitProvenance,
} from "./provenance.js";
import {
  createEmptyRegistry,
  loadRegistry,
  saveRegistry,
  setRepositoryMode,
} from "./registry.js";
import { assertAppPathsOutsideGitRepositories } from "./safety.js";
import { pathExists } from "./storage.js";
import { withStateMutationLock } from "./state-mutation.js";
import { loadWorkflowConfig } from "./workflow-config.js";
import type { RegistryMode } from "./types.js";

const DEFAULT_EXCLUSIONS = [
  ".Trash",
  ".cache",
  ".npm",
  "DerivedData",
  "Library",
  "node_modules",
  "vendor",
] as const;

const HELP = `git-sync - explicit repository synchronization and Guardian observation

Usage:
  git-sync init [--root PATH ...] [--exclude NAME_OR_PATH ...] [--host-id ID]
  git-sync discover [--root PATH ...]
  git-sync registry status
  git-sync repo <enable|disable|ignore> REMOTE_OR_REPOSITORY_PATH
  git-sync sync <once|status|wake>
  git-sync sync upstream <status|once|enable CANONICAL_REMOTE BRANCH|disable CANONICAL_REMOTE>
  git-sync daemon <once|run|wake|status|launch-agent|install|install-status|uninstall>
  git-sync doctor daemon-lock [clear --instance-id ID --confirm-service-stopped]
  git-sync incidents <list [--all]|show ID|acknowledge ID>
  git-sync guardian register SESSION_ID --rmux-target TARGET
  git-sync guardian configure --session-id ID --sender PATH
  git-sync guardian <candidates|status|dispatch|request-sync>
  git-sync guardian <inspect|local-inspect> [CANONICAL_REMOTE]
  git-sync guardian preview CANONICAL_REMOTE
  git-sync provenance show [REPOSITORY_PATH] [OID]
  git-sync provenance record REPOSITORY_PATH OID --source SOURCE [--run-id ID]

Environment:
  GIT_SYNC_HOME  Override config/state base directory

Discovery adds roots without replacing exclusions or repository selections; it never changes checkouts.
Sync requires explicit direct-sync.json or upstream-sync.json settings. The daemon also monitors
peer upstream status when workflow.json configures this host as primary with a peer.
No automatic clone, stash, reset, clean, push, or conflict resolution. Guardian registers an
existing interactive Pi session; it never creates or resumes a separate agent runtime.`;

export async function runCli(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const paths = resolveAppPaths();
  await assertAppPathsOutsideGitRepositories(paths);
  switch (command) {
    case "init":
      if (await pathExists(paths.daemonLockFile)) throw new Error("Stop the resident daemon before init");
      await withStateMutationLock(paths, () => initialize(paths, rest));
      return;
    case "discover":
      await withStateMutationLock(paths, () => discover(paths, rest));
      return;
    case "registry":
      await runRegistryCommand(paths, rest);
      return;
    case "repo":
      await withStateMutationLock(paths, () => updateRepository(paths, rest));
      return;
    case "sync":
      if (rest[0] === "upstream") { await runUpstreamSyncCommand(paths, rest.slice(1)); return; }
      if (rest.length !== 1) throw new Error("Usage: git-sync sync <once|status|wake>");
      if (rest[0] === "status") {
        print({ config: await loadDirectSyncConfig(paths), status: await directSyncStatus(paths),
          upstream: { config: await loadUpstreamSyncConfig(paths), status: await upstreamSyncStatus(paths) } });
      } else if (rest[0] === "wake") {
        print(await wakeDaemon(paths));
      } else if (rest[0] === "once") {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
        try {
          const result = await runDirectSyncOnce(paths, { signal: controller.signal });
          const upstream = await runUpstreamSyncOnce(paths, { signal: controller.signal });
          if (result === null && upstream === null) throw new Error("Sync is not configured");
          print(upstream ? { direct: result, upstream } : result);
          if ([...(result?.repositories ?? []), ...(upstream?.repositories ?? [])].some(row => row.state === "error")) process.exitCode = 1;
        } finally {
          process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
        }
      } else throw new Error("Usage: git-sync sync <once|status|wake>");
      return;
    case "daemon":
      await runDaemonCommand(paths, rest);
      return;
    case "doctor":
      await runDoctorCommand(paths, rest);
      return;
    case "incidents":
      await runIncidentCommand(paths, rest);
      return;
    case "guardian":
      await runGuardianCommand(paths, rest);
      return;
    case "provenance":
      await runProvenanceCommand(paths, rest);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

async function runUpstreamSyncCommand(paths: ReturnType<typeof resolveAppPaths>, args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "status") {
    print({ config: await loadUpstreamSyncConfig(paths), status: await upstreamSyncStatus(paths) });
    return;
  }
  if ((args.length === 3 && args[0] === "enable") || (args.length === 2 && args[0] === "disable")) {
    const branch = args[0] === "enable" ? args[2]! :
      (await loadUpstreamSyncConfig(paths))?.repositories.find(r => r.canonicalRemote === args[1])?.branch;
    if (!branch) throw new Error("Select an already registered upstream repository to disable");
    const config = await configureUpstreamSync(paths, args[1]!, branch, args[0] === "enable");
    const wake = await wakeDaemon(paths);
    print({ config, wake, applied: false }); // registration/wake is not a completed pull
    return;
  }
  if (args.length === 1 && args[0] === "once") {
    const controller = new AbortController(), cancel = () => controller.abort();
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    try {
      const result = await runUpstreamSyncOnce(paths, { signal: controller.signal });
      if (!result) throw new Error("Upstream sync is not configured");
      print(result);
      if (result.repositories.some(row => row.state === "error")) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  throw new Error("Usage: git-sync sync upstream <status|once|enable CANONICAL_REMOTE BRANCH|disable CANONICAL_REMOTE>");
}

async function initialize(paths: ReturnType<typeof resolveAppPaths>, args: readonly string[]) {
  const options = parseInitOptions(args);
  if ((await pathExists(paths.configFile)) || (await pathExists(paths.hostFile))) {
    throw new Error("git-sync is already initialized; use discover --root PATH to add roots");
  }
  const config = createConfig(
    options.roots.length === 0 ? [process.cwd()] : options.roots,
    options.exclusions.length === 0 ? DEFAULT_EXCLUSIONS : options.exclusions,
  );
  const identity = createHostIdentity(options.hostId);
  await saveConfig(paths, config);
  await saveHostIdentity(paths, identity);
  // Initialization never erases existing explicit repository selections.
  if (!(await pathExists(paths.registryFile))) {
    await saveRegistry(paths, createEmptyRegistry());
  }
  print({ config, host: identity, paths });
}

async function discover(paths: ReturnType<typeof resolveAppPaths>, args: readonly string[]) {
  const roots: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "--root" || !args[i + 1] || args[i + 1]!.startsWith("--")) {
      throw new Error("Usage: git-sync discover [--root PATH ...]");
    }
    roots.push(args[i + 1]!);
  }
  const [existing, identity] = await Promise.all([loadConfig(paths), loadHostIdentity(paths)]);
  const config = roots.length ? createConfig([...existing.roots, ...roots], existing.excludedDirectories) : existing;
  // Inspect first: a missing/unreadable root must not replace the saved config
  // or inventory. The caller holds the normal state mutation lock throughout.
  const inventory = await discoverRepositories(config, identity);
  if (roots.length) await saveConfig(paths, config);
  await saveInventory(paths, inventory);
  print(inventory);
}

async function runRegistryCommand(paths: ReturnType<typeof resolveAppPaths>, args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "status") throw new Error("Usage: git-sync registry status");
  print(await loadRegistry(paths));
}

async function updateRepository(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  const [action, target, ...extra] = args;
  if (!isRepoAction(action) || target === undefined || extra.length !== 0) {
    throw new Error("Usage: git-sync repo <enable|disable|ignore> <REMOTE_OR_REPOSITORY_PATH>");
  }

  const previous = await loadRegistry(paths);
  const canonicalRemote = Object.hasOwn(previous.repositories, target) ? target : await resolveRepositoryTarget(target);
  const mode: RegistryMode =
    action === "enable" ? "enabled" : action === "disable" ? "disabled" : "ignored";
  const registry = setRepositoryMode(previous, canonicalRemote, mode);
  await saveRegistry(paths, registry);
  print(registry.repositories[canonicalRemote]);
}

async function runDaemonCommand(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  if (args.length !== 1) {
    throw new Error("Usage: git-sync daemon <once|run|wake|status|launch-agent|install|install-status|uninstall>");
  }
  const cliEntrypoint = fileURLToPath(import.meta.url);
  if (args[0] === "once") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try { print(await runDaemonOnce(paths, { signal: controller.signal })); }
    finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
  } else if (args[0] === "status") print(await daemonStatus(paths));
  else if (args[0] === "wake") print(await wakeDaemon(paths));
  else if (args[0] === "run") await runDaemonService(paths);
  else if (args[0] === "install") print(await installLaunchAgent(paths, cliEntrypoint, process.execPath));
  else if (args[0] === "install-status") print(await launchAgentStatus(paths, cliEntrypoint, process.execPath));
  else if (args[0] === "uninstall") print(await uninstallLaunchAgent(paths, cliEntrypoint, process.execPath));
  else if (args[0] === "launch-agent") {
    process.stdout.write(await renderLaunchAgent(paths, cliEntrypoint, process.execPath, process.env));
  } else {
    throw new Error("Usage: git-sync daemon <once|run|wake|status|launch-agent|install|install-status|uninstall>");
  }
}

async function runIncidentCommand(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  if (args[0] === "list" && (args.length === 1 || (args.length === 2 && args[1] === "--all"))) {
    print(await listIncidents(paths, args[1] === "--all"));
    return;
  }
  if (args[0] === "show" && args.length === 2) {
    print(await getIncident(paths, args[1] as string));
    return;
  }
  if (args[0] === "acknowledge" && args.length === 2) {
    print(await withStateMutationLock(paths, () => acknowledgeIncident(paths, args[1] as string)));
    return;
  }
  throw new Error("Usage: git-sync incidents <list [--all]|show ID|acknowledge ID>");
}

async function runGuardianCommand(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  if (args[0] === "register") {
    if (args.length !== 4 || args[2] !== "--rmux-target") {
      throw new Error("Usage: git-sync guardian register SESSION_ID --rmux-target TARGET");
    }
    print(await registerGuardianSession(paths, args[1]!, { rmuxTarget: args[3]! }));
    return;
  }
  if ((args.length === 1 || args.length === 2) && args[0] === "inspect") {
    const remote = args[1], direct = await loadDirectSyncConfig(paths);
    if (remote && !direct?.repositories.some(r => r.canonicalRemote === remote)) {
      if (remote.trim() !== remote || !/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote))
        throw new Error("Select a canonical GitHub remote, not a path");
      const upstream = await inspectUpstreamSyncSources(paths);
      const selected = [upstream.local, upstream.peer].filter(s => s.config?.repositories.some(r => r.canonicalRemote === remote));
      print({ mode: "upstream", canonicalRemote: remote, cachedOnly: true, live: false,
        selection: selected.length ? "configured" : !upstream.peer.available ? "unknown-peer" : "not-found",
        sources: selected.map(s => ({ ...s,
          config: { ...s.config!, repositories: s.config!.repositories.filter(r => r.canonicalRemote === remote) },
          status: s.status ? { ...s.status, rows: s.status.rows.filter(r => r.canonicalRemote === remote &&
            s.config!.repositories.some(c => c.canonicalRemote === remote && c.branch === r.branch)) } : null })),
        peerAvailable: upstream.peer.available,
        guidance: "Single-host GitHub upstream. Cached evidence only; inspect the owner checkout before acting. No local peer copy is required." });
    } else {
      const peer = await inspectGuardianBoth(paths, remote);
      print(remote ? peer : { ...peer, upstream: await inspectUpstreamSyncSources(paths) });
    }
    return;
  }
  if ((args.length === 1 || args.length === 2) && args[0] === "local-inspect") {
    print(await inspectGuardianLocal(paths, args[1]));
    return;
  }
  if (args.length === 1 && args[0] === "request-sync") {
    print(await requestGuardianSync(paths));
    return;
  }
  if (args.length === 2 && args[0] === "preview") {
    print(await previewGuardianRepository(paths, args[1]!));
    return;
  }
  if (args.length === 1 && args[0] === "candidates") {
    print(await guardianCandidates(paths));
    return;
  }
  if (args.length === 1 && args[0] === "status") {
    const desktop = await guardianDesktopStatus(paths);
    if (desktop.configured) { print(desktop); return; }
    print(await guardianStatus(paths));
    return;
  }
  if (args.length === 1 && args[0] === "dispatch") {
    const direct = await loadDirectSyncConfig(paths);
    const upstream = await loadUpstreamSyncConfig(paths);
    const [workflow, own] = await Promise.all([loadWorkflowConfig(paths), loadHostIdentity(paths)]);
    const monitor = workflow.primaryHostId === own.id && Object.keys(workflow.peers).some(id => id !== own.id);
    print(await dispatchGuardianIncidents(paths, new Date(), direct || upstream || monitor ? { incidentTypes: ["sync.attention"] } : {}));
    return;
  }
  if (args[0] === "configure") {
    let sessionId: string | undefined;
    let sender: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const option = args[index];
      const value = args[index + 1];
      if (option === "--session-id" || option === "--sender") {
        if (value === undefined) throw new Error(`Missing value for ${option}`);
        if (option === "--session-id") sessionId = value;
        else sender = value;
        index += 1;
      } else {
        throw new Error(`Unknown guardian configure option: ${option}`);
      }
    }
    if (sessionId === undefined || sender === undefined) {
      throw new Error("guardian configure requires --session-id and --sender");
    }
    print(await withStateMutationLock(paths, () => configureGuardianRouting(paths, sessionId, sender)));
    return;
  }
  throw new Error("Usage: git-sync guardian <register SESSION_ID --rmux-target TARGET|configure --session-id ID --sender PATH|candidates|status|inspect [CANONICAL_REMOTE]|local-inspect [CANONICAL_REMOTE]|request-sync|preview CANONICAL_REMOTE|dispatch>");
}

async function runDoctorCommand(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  if (args.length === 1 && args[0] === "daemon-lock") {
    print(await inspectDaemonLock(paths));
    return;
  }
  if (args[0] === "daemon-lock" && args[1] === "clear") {
    let instanceId: string | undefined;
    let confirmed = false;
    for (let index = 2; index < args.length; index += 1) {
      const option = args[index];
      if (option === "--instance-id") {
        instanceId = args[index + 1];
        if (instanceId === undefined) throw new Error("Missing value for --instance-id");
        index += 1;
      } else if (option === "--confirm-service-stopped") {
        confirmed = true;
      } else {
        throw new Error(`Unknown doctor daemon-lock option: ${option}`);
      }
    }
    if (instanceId === undefined) throw new Error("--instance-id is required");
    print(await clearDaemonLock(paths, instanceId, confirmed));
    return;
  }
  throw new Error("Usage: git-sync doctor daemon-lock [clear --instance-id ID --confirm-service-stopped]");
}

async function runProvenanceCommand(
  paths: ReturnType<typeof resolveAppPaths>,
  args: readonly string[],
): Promise<void> {
  const [action, ...rest] = args;
  if (action === "show") {
    if (rest.length > 2) throw new Error("Usage: git-sync provenance show [REPOSITORY_PATH] [OID]");
    let repositoryPath: string | undefined;
    let oid: string | undefined;
    if (rest.length === 1) {
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rest[0] ?? "")) oid = rest[0];
      else repositoryPath = await realpath(rest[0] as string);
    } else if (rest.length === 2) {
      repositoryPath = await realpath(rest[0] as string);
      oid = rest[1];
    }
    if (oid !== undefined) validateOid(oid);
    print(filterProvenance(await loadProvenance(paths), repositoryPath, oid));
    return;
  }
  if (action === "record") {
    const parsed = parseProvenanceRecord(rest);
    const entry = await withStateMutationLock(paths, () => recordExplicitProvenance(
      paths,
      parsed.repositoryPath,
      parsed.oid,
      parsed.source,
      parsed.runId,
    ));
    print(entry);
    return;
  }
  throw new Error(
    "Usage: git-sync provenance <show [REPOSITORY_PATH] [OID]|record REPOSITORY_PATH OID --source SOURCE [--run-id ID]>",
  );
}

function parseProvenanceRecord(args: readonly string[]): {
  repositoryPath: string;
  oid: string;
  source: import("./types.js").ExplicitProvenanceSource;
  runId: string | undefined;
} {
  const positional: string[] = [];
  let sourceValue: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value?.startsWith("--source=")) {
      sourceValue = value.slice("--source=".length);
    } else if (value?.startsWith("--run-id=")) {
      runId = value.slice("--run-id=".length);
    } else if (value === "--source" || value === "--run-id") {
      const optionValue = args[index + 1];
      if (optionValue === undefined) throw new Error(`Missing value for ${value}`);
      index += 1;
      if (value === "--source") sourceValue = optionValue;
      else runId = optionValue;
    } else if (value?.startsWith("--")) {
      throw new Error(`Unknown provenance option: ${value}`);
    } else if (value !== undefined) positional.push(value);
  }
  if (positional.length !== 2 || sourceValue === undefined || !isExplicitProvenanceSource(sourceValue)) {
    throw new Error(
      "Usage: git-sync provenance record REPOSITORY_PATH OID --source manual|vscode|chatgpt-work|automation|external-agent [--run-id ID]",
    );
  }
  const repositoryPath = positional[0];
  const oid = positional[1];
  if (repositoryPath === undefined || oid === undefined) throw new Error("Missing provenance target");
  return { repositoryPath, oid, source: sourceValue, runId };
}

async function resolveRepositoryTarget(target: string): Promise<string> {
  const candidate = resolve(target);
  if (await pathExists(candidate)) {
    const repository = await inspectRepositoryPath(candidate);
    if (repository.canonicalRemote === null) {
      throw new Error(`Repository has no configured remote: ${candidate}`);
    }
    return repository.canonicalRemote;
  }
  // Bare canonical network IDs are identities, not relative filesystem URLs.
  // Keep existing checkout paths and ordinary URL/scp normalization above/below.
  if (target.trim() === target && /^[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(target))
    return normalizeRemote(`https://${target}`);
  return normalizeRemote(target);
}

function parseInitOptions(args: readonly string[]): {
  roots: string[];
  exclusions: string[];
  hostId: string | undefined;
} {
  const roots: string[] = [];
  const exclusions: string[] = [];
  let hostId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--root" || option === "--exclude" || option === "--host-id") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${option}`);
      index += 1;
      if (option === "--root") roots.push(value);
      else if (option === "--exclude") exclusions.push(value);
      else hostId = value;
      continue;
    }
    throw new Error(`Unknown init option: ${option}`);
  }

  return { roots, exclusions, hostId };
}

function isRepoAction(value: string | undefined): value is "enable" | "disable" | "ignore" {
  return value === "enable" || value === "disable" || value === "ignore";
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`git-sync: ${message}\n`);
    process.exitCode = 1;
  });
}
