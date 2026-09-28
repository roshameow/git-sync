import { join } from "node:path";
import type { AppPaths } from "./config.js";
import { findLiveGuardianSession, isGuardianDesktopRecord, readGuardianRecord } from "./guardian-register.js";

/** An ordinary interactive Pi remains the only writer. No separate Guardian
 * runtime, special tool permissions, SDK process or transcript modification. */
export async function guardianDesktopStatus(paths: AppPaths) {
  const c = await readGuardianRecord(join(paths.stateDirectory, "guardian-desktop.json"));
  if (!c || c.enabled !== true) return { configured: false as const };
  if (!isGuardianDesktopRecord(c)) throw new Error("Invalid Guardian Desktop record; register a standard Pi session");
  const session = await findLiveGuardianSession(c.sessionId);
  const running = session !== null && session.pid === c.pid && session.sessionFile === c.sessionFile && session.cwd === c.cwd &&
    (session.rmuxTarget === undefined || session.rmuxTarget === c.rmuxTarget);
  return { configured: true as const, mode: "interactive-pi" as const, running, sessionId: c.sessionId,
    sessionFile: c.sessionFile, cwd: c.cwd, rmuxTarget: c.rmuxTarget, profile: "standard-pi" as const };
}
