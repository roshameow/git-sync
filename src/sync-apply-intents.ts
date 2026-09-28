import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AppPaths } from "./config.js";

const MAX_BYTES = 16_384;
const MAX_ENTRIES = 4096; // Per namespace, including unrelated entries; no recursive scans.
const fields = ["version", "repository", "repositoryId", "gitDir", "gitDirId", "commonDir", "store", "branch", "head", "target"];
const canonicalPath = (value: unknown): value is string => typeof value === "string" &&
  isAbsolute(value) && resolve(value) === value && !/[\r\n\0]/.test(value);
const fingerprint = (st: Stats) =>
  [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(":");

async function privateDirectory(path: string): Promise<Stats> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() ||
    (st.mode & 0o7777) !== 0o700 || await realpath(path) !== path) throw new Error("Unsafe intent namespace");
  return st;
}

async function intentRepository(file: string): Promise<string> {
  const check = (st: Stats) => {
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o600 || st.size > MAX_BYTES) throw new Error("Unsafe apply intent");
  };
  const before = await lstat(file); check(before);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const initial = await fd.stat(); check(initial);
    if (fingerprint(before) !== fingerprint(initial)) throw new Error("Apply intent replaced");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await fd.stat(), named = await lstat(file);
    if (size > MAX_BYTES || size !== initial.size || fingerprint(initial) !== fingerprint(after) ||
      fingerprint(after) !== fingerprint(named)) throw new Error("Apply intent changed or exceeds bound");
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally { await fd.close(); }

  // The existing direct-sync-apply Intent is flat. Reject duplicate (including
  // escaped) keys rather than letting JSON.parse's last-key-wins hide ownership.
  const saved: unknown = JSON.parse(text);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid apply intent");
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}:[\],]/g) ?? [];
  const keys = tokens.filter((token, i) => token.startsWith('"') && tokens[i + 1] === ":")
    .map(token => JSON.parse(token) as string);
  const value = saved as Record<string, unknown>;
  if (keys.length !== fields.length || new Set(keys).size !== fields.length || keys.some(key => !fields.includes(key)) ||
    value.version !== 1 || ![value.repository, value.gitDir, value.commonDir, value.store].every(canonicalPath) ||
    ![value.repositoryId, value.gitDirId].every(id => typeof id === "string" && /^[0-9]+:[0-9]+$/.test(id)) ||
    typeof value.branch !== "string" || !value.branch || value.branch.startsWith("-") || value.branch.endsWith(".") ||
    /[\x00-\x20\x7f~^:?*[\]\\]/.test(value.branch) || value.branch.includes("..") || value.branch.includes("@{") ||
    value.branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) ||
    ![value.head, value.target].every(oid => typeof oid === "string" && /^[0-9a-f]{40}$/.test(oid)))
    throw new Error("Invalid apply intent");
  return value.repository as string;
}

async function scan(directory: string, names: RegExp, repository: string): Promise<boolean> {
  // Only an absent namespace is harmless. A vanished entry after enumeration,
  // unreadable namespace, unsafe root or exhausted scan budget is uncertainty.
  try { await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const before = await privateDirectory(directory);
  let count = 0;
  const entries = await opendir(directory, { bufferSize: 32 });
  for await (const entry of entries) {
    if (++count > MAX_ENTRIES) return true;
    if (names.test(entry.name) && await intentRepository(join(directory, entry.name)) === repository) return true;
  }
  const after = await privateDirectory(directory);
  // Heartbeats and unrelated status writers replace files in the state root
  // outside the mutation lock. Those directory mtimes are not recovery intents.
  // Managed intent creation itself is serialized by the caller's state lock.
  return before.dev !== after.dev || before.ino !== after.ino;
}

/** Read-only cross-mode recovery fence. Caller holds the global state mutation
 * lock before transfer and again before final apply. No config, remote, Git or
 * checkout existence is consulted: only a valid different-checkout intent may
 * be ignored. All uncertainty requires explicit recovery; nothing is repaired.
 */
export async function hasRetainedApplyIntent(paths: AppPaths, repository: string): Promise<boolean> {
  try {
    if (!canonicalPath(repository) || !canonicalPath(paths.stateDirectory)) return true;
    return await scan(paths.stateDirectory, /^direct-sync-apply-[0-9a-f]{64}\.json$/i, repository) ||
      await scan(join(paths.stateDirectory, "upstream-sync"), /^apply-[0-9a-f]{64}\.json$/i, repository);
  } catch { return true; }
}
