import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type Validator<T> = (value: unknown) => value is T;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson<T>(path: string, validator: Validator<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Required state file does not exist: ${path}`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
  if (!validator(value)) {
    throw new Error(`Invalid or unsupported state schema in ${path}`);
  }
  return value;
}

/** Write JSON by fsyncing a same-directory temporary file and atomically renaming it. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextExclusive(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    // Leave a partial exclusive-create artifact for explicit inspection rather
    // than risk unlinking a path that another process replaced concurrently.
    throw error;
  }
  await handle.close();
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);

    // Best effort directory fsync. Some platforms/filesystems do not support it.
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error: unknown) {
      if (!isIgnorableDirectorySyncError(error)) throw error;
    }
  } catch (error: unknown) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isIgnorableDirectorySyncError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EINVAL" || error.code === "EISDIR" || error.code === "EPERM")
  );
}
