import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
// Curated leaf helper from storage.ts; no storage framework is included.
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export interface OwnedLocalLock {
  readonly handle: FileHandle;
  readonly nonce: string;
  readonly path: string;
  readonly label: string;
}

export interface LocalLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly acquiredAt: string;
}

// A lock never repairs an existing app directory: an unsafe parent must be
// inspected by the operator, not chmod'd (possibly through a symlink).
export async function ensureLocalLockParent(path: string, label: string): Promise<Stats> {
  const parent = resolve(dirname(path));
  const missing: string[] = [];
  let ancestor = parent;
  while (true) {
    try {
      const entry = await lstat(ancestor);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`${label} lock parent has an unsafe ancestor`);
      }
      break;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      missing.unshift(ancestor);
      const next = dirname(ancestor);
      if (next === ancestor) throw error;
      ancestor = next;
    }
  }
  for (const directory of missing) {
    // Non-recursive/exclusive creation avoids following an existing symlink
    // into a target before validation. A concurrent creator must be checked.
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    });
    await checkLocalLockDirectory(directory, label);
  }
  return checkLocalLockDirectory(parent, label);
}

async function checkLocalLockDirectory(parent: string, label: string, pinned?: Stats): Promise<Stats> {
  const entry = await lstat(parent);
  const uid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() ||
      uid === undefined || entry.uid !== uid || (entry.mode & 0o7777) !== 0o700 ||
      (pinned !== undefined && (entry.dev !== pinned.dev || entry.ino !== pinned.ino))) {
    throw new Error(`${label} lock parent must be an owned, non-symlink 0700 directory with stable identity`);
  }
  // Check the path itself, rather than accepting a symlink-resolved target.
  if (await realpath(parent) !== resolve(await realpath(dirname(parent)), basename(parent))) {
    throw new Error(`${label} lock parent resolves through an unsafe path`);
  }
  return entry;
}

export async function verifyLocalLockParent(path: string, label: string, pinned: Stats): Promise<void> {
  await checkLocalLockDirectory(resolve(dirname(path)), label, pinned);
}

export async function acquireOwnedLocalLock(path: string, label: string): Promise<OwnedLocalLock> {
  const parent = await ensureLocalLockParent(path, label);
  const nonce = randomUUID();
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`${label} lock already exists; refusing concurrent or automatic stale-lock recovery`);
    }
    throw error;
  }
  const record: LocalLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    nonce,
    acquiredAt: new Date().toISOString(),
  };
  try {
    await verifyLocalLockParent(path, label, parent);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    return { handle, nonce, path, label };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    // Do not unlink through a replaced parent after a failed post-open check.
    await verifyLocalLockParent(path, label, parent).then(
      () => rm(path, { force: true }),
      () => undefined,
    ).catch(() => undefined);
    throw error;
  }
}

export async function releaseOwnedLocalLock(lock: OwnedLocalLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const details = await lstat(lock.path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (details === null) throw new Error(`${lock.label} lock disappeared before release`);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) {
    throw new Error(`${lock.label} lock path changed before release`);
  }
  const value = await readOwnedLocalLock(lock.path, lock.label);
  if (value.nonce !== lock.nonce || value.pid !== process.pid) {
    throw new Error(`${lock.label} lock ownership changed before release`);
  }
  await rm(lock.path);
}

export async function withOwnedLocalLock<T>(
  path: string,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireOwnedLocalLock(path, label);
  try {
    return await action();
  } finally {
    await releaseOwnedLocalLock(lock);
  }
}

export async function readOwnedLocalLock(path: string, label: string): Promise<LocalLockRecord> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) {
    throw new Error(`${label} lock path is unsafe`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} lock is unreadable`, { cause: error });
  }
  if (!isLockRecord(value)) throw new Error(`${label} lock has an invalid schema`);
  return value;
}

function isLockRecord(value: unknown): value is LocalLockRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 4 && keys.every((key) => ["schemaVersion", "pid", "nonce", "acquiredAt"].includes(key)) &&
    record.schemaVersion === 1 && Number.isSafeInteger(record.pid) && (record.pid as number) > 0 &&
    typeof record.nonce === "string" && /^[0-9a-f-]{36}$/.test(record.nonce) &&
    typeof record.acquiredAt === "string" && Number.isFinite(Date.parse(record.acquiredAt));
}
