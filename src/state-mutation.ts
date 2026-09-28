import type { AppPaths } from "./config.js";
import { withOwnedLocalLock } from "./local-lock.js";

/** Serialize bounded read-modify-write operations over app-owned local state. */
export function withStateMutationLock<T>(paths: AppPaths, action: () => Promise<T>): Promise<T> {
  return withOwnedLocalLock(paths.stateMutationLockFile, "State mutation", action);
}
