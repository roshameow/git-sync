import { chmod, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { loadDaemonRuntimeIfPresent } from "./daemon.js";
import { readOwnedLocalLock, type LocalLockRecord } from "./local-lock.js";
import { isNodeError, pathExists } from "./storage.js";

const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

export interface DaemonLockDoctorReport {
  readonly lockPresent: boolean;
  readonly lock: LocalLockRecord | null;
  readonly processAlive: boolean | null;
  readonly runtimeInstanceMatches: boolean;
  readonly heartbeatStale: boolean | null;
  readonly clearEligible: boolean;
}

export async function inspectDaemonLock(paths: AppPaths, now: Date = new Date()): Promise<DaemonLockDoctorReport> {
  if (!(await pathExists(paths.daemonLockFile))) {
    return {
      lockPresent: false,
      lock: null,
      processAlive: null,
      runtimeInstanceMatches: false,
      heartbeatStale: null,
      clearEligible: false,
    };
  }
  const lock = await readOwnedLocalLock(paths.daemonLockFile, "Daemon");
  const runtime = await loadDaemonRuntimeIfPresent(paths);
  const processAlive = isProcessAlive(lock.pid);
  const runtimeInstanceMatches = runtime?.instanceId === lock.nonce && runtime.pid === lock.pid;
  const heartbeatStale = runtime === null
    ? null
    : now.getTime() - Date.parse(runtime.heartbeatAt) > STALE_HEARTBEAT_MS;
  return {
    lockPresent: true,
    lock,
    processAlive,
    runtimeInstanceMatches,
    heartbeatStale,
    clearEligible: !processAlive && runtimeInstanceMatches &&
      (runtime?.lifecycle === "stopped" || heartbeatStale === true),
  };
}

export async function clearDaemonLock(
  paths: AppPaths,
  expectedInstanceId: string,
  confirmServiceStopped: boolean,
  now: Date = new Date(),
): Promise<{ readonly quarantinedPath: string; readonly instanceId: string }> {
  if (!confirmServiceStopped) {
    throw new Error("Refusing daemon lock recovery without --confirm-service-stopped");
  }
  if (!/^[0-9a-f-]{36}$/.test(expectedInstanceId)) throw new Error("Invalid daemon instance id");
  const report = await inspectDaemonLock(paths, now);
  if (!report.lockPresent || report.lock === null) throw new Error("Daemon lock does not exist");
  if (report.lock.nonce !== expectedInstanceId) throw new Error("Daemon lock instance id does not match");
  if (report.processAlive) throw new Error("Daemon lock owner PID is still alive");
  if (!report.runtimeInstanceMatches) throw new Error("Daemon runtime does not match the lock owner");
  if (!report.clearEligible) throw new Error("Daemon heartbeat is not stale enough for explicit recovery");

  // Re-read immediately before the atomic move so a changed owner is never
  // knowingly removed. The artifact is retained for diagnosis, not deleted.
  const current = await readOwnedLocalLock(paths.daemonLockFile, "Daemon");
  if (current.nonce !== expectedInstanceId || current.pid !== report.lock.pid) {
    throw new Error("Daemon lock changed during recovery");
  }
  await mkdir(paths.daemonLockQuarantineDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.daemonLockQuarantineDirectory, 0o700).catch(() => undefined);
  const stamp = now.toISOString().replaceAll(":", "-");
  const quarantinedPath = resolve(
    paths.daemonLockQuarantineDirectory,
    `${stamp}-${expectedInstanceId}.json`,
  );
  await rename(paths.daemonLockFile, quarantinedPath);
  await chmod(quarantinedPath, 0o600);
  return { quarantinedPath, instanceId: expectedInstanceId };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    if (isNodeError(error) && error.code === "EPERM") return true;
    throw error;
  }
}
