import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AppPaths } from "./config.js";
import { loadHostIdentity } from "./host.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { writeJsonAtomic } from "./storage.js";
import { loadWorkflowConfig } from "./workflow-config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORD = 16 * 1024, MAX_RUNTIME_ENTRIES = 512;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const absolute = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && !/[\0\r\n]/.test(v);
const target = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 &&
  v.trim() === v && !v.startsWith("-") && !/[\x00-\x1f\x7f]/.test(v);
const safe = (s: Stats, headerOnly: boolean) => s.isFile() && s.nlink === 1 && s.uid === process.getuid?.() &&
  // Native Pi transcripts commonly use 0644 inside the user's Pi directory.
  // Reading their immutable header does not require chmod or a custom session.
  (headerOnly ? (s.mode & 0o7133) === 0 && (s.mode & 0o400) !== 0 : (s.mode & 0o7777) === 0o600);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
const invalid = () => new Error("Unsafe or inconsistent Guardian session registration");

/** Owner-private descriptor reads. Header-only reads parse no transcript entries;
 * an active Pi may append while we inspect its immutable first line. */
export async function readGuardianRecord(file: string, headerOnly = false): Promise<Record<string, unknown> | null> {
  let fd;
  try { fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = await fd.stat();
    if (!safe(before, headerOnly) || (!headerOnly && before.size > MAX_RECORD)) throw invalid();
    const b = Buffer.alloc(MAX_RECORD + 1); let size = 0;
    while (size < b.length) {
      const { bytesRead } = await fd.read(b, size, b.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (headerOnly && b.subarray(0, size).includes(10)) break;
    }
    const after = await fd.stat(), named = await lstat(file);
    if (!safe(after, headerOnly) || !safe(named, headerOnly) || named.isSymbolicLink() || !same(before, after) || !same(after, named) ||
        (!headerOnly && (size > MAX_RECORD || before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))) throw invalid();
    const newline = b.subarray(0, size).indexOf(10);
    if (headerOnly && (newline < 0 || newline > MAX_RECORD)) throw invalid();
    const v: unknown = JSON.parse(b.subarray(0, headerOnly ? newline : size).toString("utf8"));
    if (!object(v)) throw invalid();
    return v;
  } finally { await fd.close(); }
}

export interface GuardianDesktopRecord {
  enabled: true; profile: "standard-pi"; pid: number; sessionId: string;
  sessionFile: string; cwd: string; rmuxTarget: string;
}
export function isGuardianDesktopRecord(c: Record<string, unknown>): c is Record<string, unknown> & GuardianDesktopRecord {
  return c.enabled === true && c.profile === "standard-pi" && Number.isSafeInteger(c.pid) && (c.pid as number) > 0 &&
    typeof c.sessionId === "string" && UUID.test(c.sessionId) && absolute(c.sessionFile) && absolute(c.cwd) && target(c.rmuxTarget);
}
interface RuntimeDependencies { runtimeDirectory: string; isAlive: (pid: number) => boolean }
const production = (): RuntimeDependencies => ({ runtimeDirectory: join(homedir(), ".pi", "agent", "runtime"),
  isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } } });
type LiveSession = Omit<GuardianDesktopRecord, "enabled" | "profile" | "rmuxTarget"> & { rmuxTarget?: string };

async function findSession(sessionId: string, deps: RuntimeDependencies): Promise<LiveSession | null> {
  if (!UUID.test(sessionId)) throw new Error("Guardian requires an exact session UUID");
  let directory;
  try {
    const st = await lstat(deps.runtimeDirectory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0 ||
        await realpath(deps.runtimeDirectory) !== deps.runtimeDirectory) throw invalid();
    directory = await opendir(deps.runtimeDirectory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const matches: LiveSession[] = []; let count = 0;
  for await (const entry of directory) {
    if (++count > MAX_RUNTIME_ENTRIES) throw new Error("Pi runtime enumeration exceeds bounded limit");
    if (!entry.name.endsWith(".jsonl")) continue;
    if (!/^[1-9][0-9]*\.jsonl$/.test(entry.name)) throw invalid();
    const pid = Number(entry.name.slice(0, -6));
    if (!Number.isSafeInteger(pid)) throw invalid();
    const r = await readGuardianRecord(join(deps.runtimeDirectory, entry.name));
    if (!r) continue; // normal process shutdown may remove its registration
    if (r.type !== "pi_runtime" || r.pid !== pid || !absolute(r.sessionPath) || !absolute(r.cwd)) throw invalid();
    if (!deps.isAlive(pid)) continue;
    // Reject aliases, including symlink ancestors. Never open the session for writing.
    if (await realpath(r.sessionPath) !== r.sessionPath) throw invalid();
    const h = await readGuardianRecord(r.sessionPath, true);
    if (!h || h.type !== "session" || typeof h.id !== "string" || !UUID.test(h.id) ||
        ![1, 2, 3].includes(h.version as number) || h.cwd !== r.cwd ||
        (r.sessionId !== undefined && r.sessionId !== h.id)) throw invalid();
    if (h.id !== sessionId) continue;
    if (r.rmuxTarget !== undefined && !target(r.rmuxTarget)) throw invalid();
    matches.push({ pid, sessionId, sessionFile: r.sessionPath, cwd: r.cwd,
      ...(r.rmuxTarget === undefined ? {} : { rmuxTarget: r.rmuxTarget as string }) });
  }
  if (matches.length > 1) throw new Error("Multiple live Pi writers claim this session UUID");
  const match = matches[0];
  if (match && !deps.isAlive(match.pid)) return null;
  return match ?? null;
}

/** No process creation, session resume, transcript writes, model/tool selection,
 * or new runtime. The caller attests --rmux-target is this existing Pi's target
 * when the durable package registration has no rmuxTarget (current format).
 * CLI contract: guardian register SESSION_ID --rmux-target TARGET. */
export async function registerGuardianSession(paths: AppPaths, sessionId: string,
  options: { rmuxTarget?: string } = {}): Promise<GuardianDesktopRecord> {
  return register(paths, sessionId, options, production());
}
async function register(paths: AppPaths, sessionId: string, options: { rmuxTarget?: string }, deps: RuntimeDependencies) {
  if (options.rmuxTarget !== undefined && !target(options.rmuxTarget)) throw new Error("Invalid existing rmux target");
  const [own, workflow] = await Promise.all([loadHostIdentity(paths), loadWorkflowConfig(paths)]);
  if (own.id !== workflow.primaryHostId) throw new Error("Guardian registration is only allowed on the configured primary host");
  return withOwnedLocalLock(paths.guardianDispatchLockFile, "Guardian registration", async () => {
    const session = await findSession(sessionId, deps);
    if (!session) throw new Error("No live registered Pi session matches this UUID");
    if (session.rmuxTarget && options.rmuxTarget && session.rmuxTarget !== options.rmuxTarget) throw invalid();
    const rmuxTarget = session.rmuxTarget ?? options.rmuxTarget;
    if (!rmuxTarget) throw new Error("Runtime has no rmux target; supply --rmux-target for this existing interactive Pi");
    // Check again immediately before publishing the pointer; registration never
    // grants a lease on a Pi process that can exit or switch sessions at any time.
    const again = await findSession(sessionId, deps);
    if (JSON.stringify(again) !== JSON.stringify(session)) throw invalid();
    const record: GuardianDesktopRecord = { ...session, enabled: true, profile: "standard-pi", rmuxTarget };
    await writeJsonAtomic(join(paths.stateDirectory, "guardian-desktop.json"), record);
    return record;
  });
}
export function findLiveGuardianSession(sessionId: string) { return findSession(sessionId, production()); }
/** Offline seam: fake liveness plus fixture-owned runtime/session files only. */
export const __guardianRegisterForTests = { register, findSession };
