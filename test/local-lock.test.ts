import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { acquireOwnedLocalLock, releaseOwnedLocalLock } from "../src/local-lock.js";

async function fixture(context: { after: (cleanup: () => Promise<void>) => void }) {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-lock-parent-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  return resolveAppPaths({ GIT_SYNC_HOME: resolve(sandbox, "app") });
}

const cases = [
  { name: "state mutation", path: (p: ReturnType<typeof resolveAppPaths>) => p.stateMutationLockFile,
    attempt: (p: ReturnType<typeof resolveAppPaths>) => acquireOwnedLocalLock(p.stateMutationLockFile, "State mutation") },
  { name: "daemon", path: (p: ReturnType<typeof resolveAppPaths>) => p.daemonLockFile,
    attempt: (p: ReturnType<typeof resolveAppPaths>) => acquireOwnedLocalLock(p.daemonLockFile, "Daemon") },
];

// Fixture pitfall: mkdir without mode on an already-created app state usually
// produces 0755; the lock must reject it instead of silently repairing it.
for (const entry of cases) {
  test(`${entry.name} lock rejects permissive parent without repairing it`, async (context) => {
    const paths = await fixture(context);
    await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.stateDirectory, 0o755);
    const before = await lstat(paths.stateDirectory);
    await assert.rejects(entry.attempt(paths), /lock parent/);
    const after = await lstat(paths.stateDirectory);
    assert.equal(after.mode & 0o7777, 0o755);
    assert.equal(after.ino, before.ino);
    await assert.rejects(lstat(entry.path(paths)), /ENOENT/);
  });

  test(`${entry.name} lock rejects symlink ancestor before creating parent`, async (context) => {
    const paths = await fixture(context);
    const target = resolve(paths.stateDirectory, "../..", "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, resolve(paths.stateDirectory, ".."));
    await assert.rejects(entry.attempt(paths), /lock parent/);
    await assert.rejects(lstat(resolve(target, "state")), /ENOENT/);
  });

  test(`${entry.name} lock rejects hard-linked file parent without touching target`, async (context) => {
    const paths = await fixture(context);
    await mkdir(resolve(paths.stateDirectory, ".."), { mode: 0o700 });
    const target = resolve(paths.stateDirectory, "..", "target");
    await writeFile(target, "untouched");
    await link(target, paths.stateDirectory);
    await assert.rejects(entry.attempt(paths), /lock parent/);
    assert.equal(await readFile(target, "utf8"), "untouched");
    assert.equal((await lstat(target)).nlink, 2);
  });

  test(`${entry.name} lock rejects symlink parent without touching target`, async (context) => {
    const paths = await fixture(context);
    const target = resolve(paths.stateDirectory, "..", "target");
    await mkdir(target, { recursive: true, mode: 0o755 });
    await chmod(target, 0o755);
    await writeFile(resolve(target, "sentinel"), "untouched");
    await symlink(target, paths.stateDirectory);
    await assert.rejects(entry.attempt(paths), /lock parent/);
    assert.equal((await lstat(paths.stateDirectory)).isSymbolicLink(), true);
    assert.equal((await stat(target)).mode & 0o7777, 0o755);
    assert.equal(await readFile(resolve(target, "sentinel"), "utf8"), "untouched");
    await assert.rejects(lstat(resolve(target, basename(entry.path(paths)))), /ENOENT/);
  });
}

test("first-time owned lock creates private parent and exclusive 0600 file, then releases", async (context) => {
  const paths = await fixture(context);
  const lock = await acquireOwnedLocalLock(paths.stateMutationLockFile, "State mutation");
  assert.equal((await stat(paths.stateDirectory)).mode & 0o7777, 0o700);
  assert.equal((await stat(paths.stateMutationLockFile)).mode & 0o7777, 0o600);
  await assert.rejects(acquireOwnedLocalLock(paths.stateMutationLockFile, "State mutation"), /lock already exists/);
  await releaseOwnedLocalLock(lock);
  await assert.rejects(lstat(paths.stateMutationLockFile), /ENOENT/);
});
