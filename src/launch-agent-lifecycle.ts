import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { loadHostIdentity } from "./host.js";
import { launchAgentLabel, renderLaunchAgent } from "./launch-agent.js";
import { pathExists, readJson, writeJsonAtomic, writeTextExclusive } from "./storage.js";
import type { LaunchAgentReceipt } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_OUTPUT = 64 * 1024;

export interface LaunchAgentLifecycleOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly userHome?: string;
  readonly launchctlExecutable?: string;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface LaunchAgentStatus {
  readonly installed: boolean;
  readonly ownershipVerified: boolean;
  readonly receipt: LaunchAgentReceipt | null;
  readonly loaded: boolean;
  readonly loadedJobOwned: boolean;
  readonly plistPresent: boolean;
  readonly plistIntegrity: "absent" | "verified" | "mismatch" | "unsafe";
}

export async function installLaunchAgent(
  paths: AppPaths,
  cliEntrypoint: string,
  nodeExecutable: string,
  options: LaunchAgentLifecycleOptions = {},
  now: Date = new Date(),
): Promise<LaunchAgentReceipt> {
  const context = await resolveContext(paths, cliEntrypoint, nodeExecutable, options);
  await ensureSafeOwnedDirectory(context.launchAgentsDirectory, context.uid, "LaunchAgents");
  let receipt = await loadReceiptIfPresent(paths);
  const originalStatus = receipt?.status ?? null;
  if (receipt?.status === "uninstalling") {
    throw new Error("LaunchAgent uninstall is incomplete; retry uninstall before install");
  }
  const installationId = receipt?.installationId ?? randomUUID();
  const plist = await renderLifecyclePlist(paths, context, options, installationId);
  const plistSha256 = sha256(plist);

  if (receipt === null) {
    if (await pathExists(context.plistPath)) {
      throw new Error("LaunchAgent plist already exists without a git-sync ownership receipt");
    }
    const loaded = await inspectLoadedJob(context, installationId);
    if (loaded.loaded) throw new Error("LaunchAgent label is already loaded without a git-sync ownership receipt");
    // Persist ownership intent before exclusive creation. A crash leaves a
    // recoverable prepared receipt, never an unowned plist that must be guessed.
    receipt = makeReceipt(context, installationId, plistSha256, "prepared", now, null);
    await saveReceipt(paths, receipt);
    await writeTextExclusive(context.plistPath, plist);
    await chmod(context.plistPath, 0o600);
  } else {
    assertReceiptOwnership(receipt, context, plistSha256);
    if (receipt.status === "loaded") {
      await requirePlistIntegrity(context.plistPath, receipt.plistSha256, context.uid);
      const loaded = await inspectLoadedJob(context, receipt.installationId);
      if (loaded.loaded && loaded.owned) return receipt;
      if (loaded.loaded) throw new Error("Loaded LaunchAgent label does not match the ownership receipt");
      receipt = { ...receipt, status: "prepared", updatedAt: now.toISOString() };
      await saveReceipt(paths, receipt);
    } else if (receipt.status === "unloaded") {
      if (await pathExists(context.plistPath)) {
        throw new Error("Unloaded LaunchAgent receipt conflicts with an existing plist");
      }
      receipt = {
        ...receipt,
        status: "prepared",
        installedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quarantinedPlistPath: null,
      };
      await saveReceipt(paths, receipt);
      await writeTextExclusive(context.plistPath, plist);
      await chmod(context.plistPath, 0o600);
    } else {
      if (!(await pathExists(context.plistPath))) {
        await writeTextExclusive(context.plistPath, plist);
        await chmod(context.plistPath, 0o600);
      } else {
        await requirePlistIntegrity(context.plistPath, receipt.plistSha256, context.uid);
      }
    }
  }

  const beforeBootstrap = await inspectLoadedJob(context, receipt.installationId);
  if (beforeBootstrap.loaded) {
    if (originalStatus !== "prepared" || !beforeBootstrap.owned) {
      throw new Error("LaunchAgent label became loaded concurrently; refusing to adopt an unproven job");
    }
    const adopted = { ...receipt, status: "loaded" as const, updatedAt: now.toISOString() };
    await saveReceipt(paths, adopted);
    return adopted;
  }
  if (await pathExists(paths.daemonLockFile)) {
    throw new Error("A daemon lifecycle lock exists while the LaunchAgent label is unloaded; run doctor before bootstrap");
  }
  const bootstrap = await runLaunchctl(context, ["bootstrap", `gui/${context.uid}`, context.plistPath]);
  if (bootstrap.code !== 0) {
    const observed = await inspectLoadedJob(context, receipt.installationId);
    if (!observed.loaded || !observed.owned) {
      throw new Error("launchctl bootstrap failed; prepared receipt and plist were preserved for inspection");
    }
  }
  const loaded = { ...receipt, status: "loaded" as const, updatedAt: now.toISOString() };
  await saveReceipt(paths, loaded);
  return loaded;
}

export async function uninstallLaunchAgent(
  paths: AppPaths,
  cliEntrypoint: string,
  nodeExecutable: string,
  options: LaunchAgentLifecycleOptions = {},
  now: Date = new Date(),
): Promise<LaunchAgentReceipt> {
  const context = await resolveContext(paths, cliEntrypoint, nodeExecutable, options);
  let receipt = await loadReceiptIfPresent(paths);
  if (receipt === null) throw new Error("LaunchAgent ownership receipt does not exist");
  assertReceiptContext(receipt, context);
  if (receipt.status === "unloaded") return receipt;
  if (receipt.status === "uninstalling") {
    return completeUninstall(paths, context, receipt, now);
  }
  await requirePlistIntegrity(context.plistPath, receipt.plistSha256, context.uid);
  const loaded = await inspectLoadedJob(context, receipt.installationId);
  if (loaded.loaded && !loaded.owned) {
    throw new Error("Refusing to boot out a same-label LaunchAgent not owned by this receipt");
  }
  if (loaded.loaded) {
    const bootout = await runLaunchctl(context, ["bootout", `gui/${context.uid}/${context.label}`]);
    if (bootout.code !== 0) throw new Error("launchctl bootout failed; plist and receipt were left unchanged");
    await waitForDaemonLockRelease(paths);
  } else if (await pathExists(paths.daemonLockFile)) {
    throw new Error("LaunchAgent label is unloaded but a daemon lifecycle lock still exists; run doctor first");
  }

  const quarantineDirectory = resolve(context.launchAgentsDirectory, ".git-sync-quarantine");
  await ensureSafeOwnedDirectory(quarantineDirectory, context.uid, "LaunchAgent quarantine");
  const quarantinePath = resolve(
    quarantineDirectory,
    `${now.toISOString().replaceAll(":", "-")}-${receipt.installationId}.plist`,
  );
  if (await pathExists(quarantinePath)) throw new Error("LaunchAgent quarantine destination already exists");
  receipt = {
    ...receipt,
    status: "uninstalling",
    updatedAt: now.toISOString(),
    quarantinedPlistPath: quarantinePath,
  };
  await saveReceipt(paths, receipt);
  return completeUninstall(paths, context, receipt, now);
}

export async function launchAgentStatus(
  paths: AppPaths,
  cliEntrypoint: string,
  nodeExecutable: string,
  options: LaunchAgentLifecycleOptions = {},
): Promise<LaunchAgentStatus> {
  const context = await resolveContext(paths, cliEntrypoint, nodeExecutable, options);
  const receipt = await loadReceiptIfPresent(paths);
  if (receipt === null) {
    const loaded = await inspectLoadedJob(context, null);
    const plistPresent = await pathExists(context.plistPath);
    return {
      installed: false,
      ownershipVerified: false,
      receipt: null,
      loaded: loaded.loaded,
      loadedJobOwned: false,
      plistPresent,
      plistIntegrity: plistPresent ? "unsafe" : "absent",
    };
  }

  let ownershipVerified = false;
  try {
    const plist = await renderLifecyclePlist(paths, context, options, receipt.installationId);
    assertReceiptOwnership(receipt, context, sha256(plist));
    ownershipVerified = true;
  } catch {}
  let integrity: LaunchAgentStatus["plistIntegrity"] = "absent";
  if (await pathExists(receipt.plistPath)) {
    try {
      await requirePlistIntegrity(receipt.plistPath, receipt.plistSha256, receipt.uid);
      integrity = "verified";
    } catch (error: unknown) {
      integrity = error instanceof Error && error.message.includes("unsafe") ? "unsafe" : "mismatch";
    }
  }
  const loaded = await inspectLoadedJob(context, receipt.installationId);
  return {
    installed: receipt.status === "loaded" && ownershipVerified && loaded.loaded && loaded.owned && integrity === "verified",
    ownershipVerified,
    receipt,
    loaded: loaded.loaded,
    loadedJobOwned: loaded.owned,
    plistPresent: integrity !== "absent",
    plistIntegrity: integrity,
  };
}

interface LifecycleContext {
  readonly uid: number;
  readonly userHome: string;
  readonly launchctlExecutable: string;
  readonly launchAgentsDirectory: string;
  readonly label: string;
  readonly plistPath: string;
  readonly cliEntrypoint: string;
  readonly nodeExecutable: string;
}

async function resolveContext(
  paths: AppPaths,
  cliEntrypoint: string,
  nodeExecutable: string,
  options: LaunchAgentLifecycleOptions,
): Promise<LifecycleContext> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("LaunchAgent lifecycle is supported only on macOS");
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid <= 0) throw new Error("LaunchAgent must run as a non-root user");
  const requestedHome = options.userHome ?? homedir();
  if (!isAbsolute(requestedHome)) throw new Error("LaunchAgent user home must be absolute");
  const userHome = await realpath(requestedHome);
  const homeDetails = await lstat(userHome);
  if (!homeDetails.isDirectory() || homeDetails.uid !== uid) throw new Error("LaunchAgent user home is not owned by the target uid");
  const launchAgentsDirectory = resolve(userHome, "Library", "LaunchAgents");
  const identity = await loadHostIdentity(paths);
  const label = launchAgentLabel(identity.id);
  const launchctlExecutable = options.launchctlExecutable ?? "/bin/launchctl";
  if (!isAbsolute(launchctlExecutable)) throw new Error("launchctl executable must be absolute");
  return {
    uid,
    userHome,
    launchctlExecutable,
    launchAgentsDirectory,
    label,
    plistPath: resolve(launchAgentsDirectory, `${label}.plist`),
    cliEntrypoint: await requireRegularExecutablePath(cliEntrypoint, "CLI entrypoint"),
    nodeExecutable: await requireRegularExecutablePath(nodeExecutable, "Node executable"),
  };
}

async function renderLifecyclePlist(
  paths: AppPaths,
  context: LifecycleContext,
  options: LaunchAgentLifecycleOptions,
  installationId: string,
): Promise<string> {
  return renderLaunchAgent(paths, context.cliEntrypoint, context.nodeExecutable, {
    ...(options.sourceEnvironment ?? process.env),
    GIT_SYNC_LAUNCH_AGENT_RECEIPT: installationId,
  });
}

async function requireRegularExecutablePath(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const canonical = await realpath(path);
  const details = await lstat(canonical);
  if (!details.isFile()) throw new Error(`${label} must resolve to a regular file`);
  return canonical;
}

async function ensureSafeOwnedDirectory(path: string, expectedUid: number, label: string): Promise<void> {
  const parent = dirname(path);
  if (!(await pathExists(parent))) await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink() || parentDetails.uid !== expectedUid) {
    throw new Error(`${label} parent path is unsafe or has the wrong owner`);
  }
  if (!(await pathExists(path))) await mkdir(path, { mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== expectedUid) {
    throw new Error(`${label} directory is unsafe or has the wrong owner`);
  }
}

async function requirePlistIntegrity(path: string, expectedHash: string, expectedUid: number): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.uid !== expectedUid || details.size > 1024 * 1024) {
    throw new Error("LaunchAgent plist path is unsafe");
  }
  if (sha256(await readFile(path)) !== expectedHash) throw new Error("LaunchAgent plist hash does not match its ownership receipt");
}

async function completeUninstall(
  paths: AppPaths,
  context: LifecycleContext,
  receipt: LaunchAgentReceipt,
  now: Date,
): Promise<LaunchAgentReceipt> {
  const quarantinePath = receipt.quarantinedPlistPath;
  if (quarantinePath === null || dirname(quarantinePath) !== resolve(context.launchAgentsDirectory, ".git-sync-quarantine")) {
    throw new Error("Uninstalling receipt has an invalid quarantine path");
  }
  if (await pathExists(quarantinePath)) {
    if (await pathExists(context.plistPath)) throw new Error("Both active and quarantined LaunchAgent plists exist");
    await requirePlistIntegrity(quarantinePath, receipt.plistSha256, context.uid);
  } else {
    await requirePlistIntegrity(context.plistPath, receipt.plistSha256, context.uid);
    await rename(context.plistPath, quarantinePath);
    try {
      await requirePlistIntegrity(quarantinePath, receipt.plistSha256, context.uid);
    } catch (error: unknown) {
      // Restore without overwriting a concurrently-created active path.
      if (!(await pathExists(context.plistPath))) {
        await link(quarantinePath, context.plistPath);
        await rm(quarantinePath);
      }
      throw error;
    }
  }
  const unloaded: LaunchAgentReceipt = {
    ...receipt,
    status: "unloaded",
    updatedAt: now.toISOString(),
  };
  await saveReceipt(paths, unloaded);
  return unloaded;
}

async function loadReceiptIfPresent(paths: AppPaths): Promise<LaunchAgentReceipt | null> {
  if (!(await pathExists(paths.launchAgentReceiptFile))) return null;
  const details = await lstat(paths.launchAgentReceiptFile);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("LaunchAgent receipt path is unsafe");
  return readJson(paths.launchAgentReceiptFile, isLaunchAgentReceipt);
}

async function saveReceipt(paths: AppPaths, receipt: LaunchAgentReceipt): Promise<void> {
  if (!isLaunchAgentReceipt(receipt)) throw new Error("Refusing invalid LaunchAgent receipt");
  await writeJsonAtomic(paths.launchAgentReceiptFile, receipt);
}

function makeReceipt(
  context: LifecycleContext,
  installationId: string,
  plistSha256: string,
  status: LaunchAgentReceipt["status"],
  now: Date,
  quarantinedPlistPath: string | null,
): LaunchAgentReceipt {
  return {
    schemaVersion: SCHEMA_VERSION,
    label: context.label,
    uid: context.uid,
    installationId,
    plistPath: context.plistPath,
    plistSha256,
    nodeExecutable: context.nodeExecutable,
    cliEntrypoint: context.cliEntrypoint,
    installedAt: now.toISOString(),
    status,
    updatedAt: now.toISOString(),
    quarantinedPlistPath,
  };
}

function assertReceiptContext(receipt: LaunchAgentReceipt, context: LifecycleContext): void {
  if (receipt.label !== context.label || receipt.uid !== context.uid || receipt.plistPath !== context.plistPath ||
      receipt.nodeExecutable !== context.nodeExecutable || receipt.cliEntrypoint !== context.cliEntrypoint) {
    throw new Error("LaunchAgent receipt does not match the current installation context");
  }
}

function assertReceiptOwnership(receipt: LaunchAgentReceipt, context: LifecycleContext, expectedHash: string): void {
  assertReceiptContext(receipt, context);
  if (receipt.plistSha256 !== expectedHash) {
    throw new Error("LaunchAgent receipt does not match the requested installation; refusing replacement");
  }
}

async function inspectLoadedJob(
  context: LifecycleContext,
  installationId: string | null,
): Promise<{ readonly loaded: boolean; readonly owned: boolean }> {
  const result = await runLaunchctl(context, ["print", `gui/${context.uid}/${context.label}`]);
  if (result.code !== 0) return { loaded: false, owned: false };
  if (installationId === null) return { loaded: true, owned: false };
  const required = [context.nodeExecutable, context.cliEntrypoint, "daemon", "run", installationId];
  return { loaded: true, owned: required.every((value) => result.stdout.includes(value)) };
}

async function waitForDaemonLockRelease(paths: AppPaths): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await pathExists(paths.daemonLockFile))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("LaunchAgent was booted out but the daemon lifecycle lock did not clear; run doctor before retrying uninstall");
}

async function runLaunchctl(
  context: LifecycleContext,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(context.launchctlExecutable, [...args], {
      env: { HOME: context.userHome, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "pipe", "pipe"],
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
        finish(new Error("launchctl output exceeded the bounded limit"));
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(new Error("Could not execute launchctl", { cause: error })));
    child.on("close", (code) => finish(null, code ?? -1));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("launchctl exceeded the bounded timeout"));
    }, COMMAND_TIMEOUT_MS);
  });
}

function isLaunchAgentReceipt(value: unknown): value is LaunchAgentReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion", "label", "uid", "installationId", "plistPath", "plistSha256", "nodeExecutable", "cliEntrypoint",
    "installedAt", "status", "updatedAt", "quarantinedPlistPath",
  ];
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key)) &&
    record.schemaVersion === 1 && typeof record.label === "string" && /^com\.git-sync\.daemon\.[A-Za-z0-9._-]+$/.test(record.label) &&
    Number.isSafeInteger(record.uid) && (record.uid as number) > 0 &&
    typeof record.installationId === "string" && /^[0-9a-f-]{36}$/.test(record.installationId) &&
    typeof record.plistPath === "string" && isAbsolute(record.plistPath) &&
    typeof record.plistSha256 === "string" && /^[0-9a-f]{64}$/.test(record.plistSha256) &&
    typeof record.nodeExecutable === "string" && isAbsolute(record.nodeExecutable) &&
    typeof record.cliEntrypoint === "string" && isAbsolute(record.cliEntrypoint) &&
    isDateString(record.installedAt) &&
    (record.status === "prepared" || record.status === "loaded" || record.status === "uninstalling" || record.status === "unloaded") &&
    isDateString(record.updatedAt) &&
    (record.quarantinedPlistPath === null || (typeof record.quarantinedPlistPath === "string" && isAbsolute(record.quarantinedPlistPath)));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
