import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { guardianDesktopStatus } from "../src/guardian-desktop-status.js";
import { __guardianRegisterForTests as api, readGuardianRecord } from "../src/guardian-register.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { writeJsonAtomic } from "../src/storage.js";
import { saveWorkflowFixture } from "./guardian-workflow-fixture.js";

const sessionId = "11111111-2222-4333-8444-555555555555";
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guardian-register-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  await saveWorkflowFixture(paths);
  const runtimeDirectory = join(root, "runtime"), sessionFile = join(root, "session.jsonl"), cwd = root;
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const header = { type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() };
  const transcript = JSON.stringify(header) + "\n" + JSON.stringify({ type: "message", private: "unread" }) + "\n";
  await writeFile(sessionFile, transcript, { mode: 0o600 });
  const registration = { type: "pi_runtime", pid: 41001, sessionPath: sessionFile, cwd, panePid: null, tty: "fixture", startedAt: 1 };
  const runtimeFile = join(runtimeDirectory, `${registration.pid}.jsonl`);
  await writeJsonAtomic(runtimeFile, registration);
  const live = new Set([registration.pid]);
  const deps = { runtimeDirectory, isAlive: (pid: number) => live.has(pid) };
  const register = (options: { rmuxTarget?: string } = { rmuxTarget: "existing:guardian.0" }) => api.register(paths, sessionId, options, deps);
  return { root, paths, sessionFile, header, transcript, runtimeFile, registration, live, deps, register,
    desktop: join(paths.stateDirectory, "guardian-desktop.json") };
}

test("register points to one existing normal Pi, keeps bytes unchanged and writes owner-0600 standard-pi shape", async t => {
  const f = await fixture(t), before = await stat(f.sessionFile);
  const result = await f.register();
  assert.deepEqual(result, { enabled: true, profile: "standard-pi", pid: 41001, sessionId,
    sessionFile: f.sessionFile, cwd: f.root, rmuxTarget: "existing:guardian.0" });
  assert.deepEqual(JSON.parse(await readFile(f.desktop, "utf8")), result);
  assert.equal((await stat(f.desktop)).mode & 0o777, 0o600);
  assert.equal(await readFile(f.sessionFile, "utf8"), f.transcript);
  assert.equal((await stat(f.sessionFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await f.register(), result); // no new writer/process/session
  assert.equal(await readFile(f.runtimeFile, "utf8"), `${JSON.stringify(f.registration, null, 2)}\n`);
});

test("requires an explicit existing target if runtime lacks one; accepts runtime target and rejects mismatch", async t => {
  const f = await fixture(t);
  await assert.rejects(f.register({}), /--rmux-target/);
  await writeJsonAtomic(f.runtimeFile, { ...f.registration, rmuxTarget: "registered:normal.0" });
  assert.equal((await f.register({})).rmuxTarget, "registered:normal.0");
  await assert.rejects(f.register(), /inconsistent/);
  for (const rmuxTarget of ["", "-target", "fake\ncommand", "a".repeat(257)]) await assert.rejects(f.register({ rmuxTarget }));
});

test("exact UUID, header identity, filename/PID and cwd must agree; legacy profile is rejected", async t => {
  const f = await fixture(t);
  for (const id of ["11111111", `${sessionId}\n`, "../../session", "11111111-2222-4333-8444-555555555556"]) {
    await assert.rejects(api.register(f.paths, id, { rmuxTarget: "existing:1" }, f.deps));
  }
  for (const patch of [{ pid: 41002 }, { sessionId: "wrong" }, { cwd: "/wrong" }, { type: "unknown" }]) {
    await writeJsonAtomic(f.runtimeFile, { ...f.registration, ...patch });
    await assert.rejects(f.register());
  }
  await writeJsonAtomic(f.runtimeFile, f.registration);
  await writeFile(f.sessionFile, JSON.stringify({ ...f.header, id: "not-a-uuid" }) + "\n");
  await assert.rejects(f.register());
  await writeJsonAtomic(f.desktop, { enabled: true, profile: "legacy" });
  await assert.rejects(guardianDesktopStatus(f.paths), /standard Pi/); // exits before any real runtime read
});

test("dead sessions and duplicate live writers fail; dead duplicate does not mask the unique live writer", async t => {
  const f = await fixture(t);
  f.live.clear(); await assert.rejects(f.register(), /No live/);
  f.live.add(41001); f.live.add(41002);
  await writeJsonAtomic(join(f.deps.runtimeDirectory, "41002.jsonl"), { ...f.registration, pid: 41002 });
  await assert.rejects(f.register(), /Multiple live/);
  // A different file with the same header UUID is also a duplicate writer.
  const copy = join(f.root, "copy.jsonl"); await writeFile(copy, f.transcript, { mode: 0o600 });
  await writeJsonAtomic(join(f.deps.runtimeDirectory, "41002.jsonl"), { ...f.registration, pid: 41002, sessionPath: copy });
  await assert.rejects(f.register(), /Multiple live/);
  f.live.delete(41002); assert.equal((await f.register()).pid, 41001);
  let probes = 0;
  await assert.rejects(api.register(f.paths, sessionId, { rmuxTarget: "existing:1" }, {
    ...f.deps, isAlive: () => ++probes === 1,
  }), /No live/);
});

test("runtime config is private; headers are owner-readable/non-writable by others; both are bounded regular single-link files", async t => {
  const f = await fixture(t);
  for (const file of [f.runtimeFile, f.sessionFile]) {
    await chmod(file, file === f.sessionFile ? 0o664 : 0o644); await assert.rejects(f.register()); await chmod(file, 0o600);
    const alias = join(f.root, "hardlink"); await link(file, alias); await assert.rejects(f.register()); await rm(alias);
    const bytes = await readFile(file); await rm(file); await writeFile(alias, bytes, { mode: 0o600 });
    await symlink(alias, file); await assert.rejects(f.register()); await rm(file); await rm(alias);
    await writeFile(file, bytes, { mode: 0o600 });
  }
  await writeFile(f.runtimeFile, " ".repeat(16385)); await assert.rejects(f.register());
  await writeJsonAtomic(f.runtimeFile, f.registration);
  await writeFile(f.sessionFile, " ".repeat(16385) + "\n"); await assert.rejects(f.register());
  await writeFile(f.sessionFile, JSON.stringify(f.header)); await assert.rejects(f.register()); // partial header
  await writeFile(f.sessionFile, JSON.stringify(f.header) + "\n" + "x".repeat(2 * 1024 * 1024));
  assert.equal((await f.register()).sessionId, sessionId); // bounded first-line read, not transcript parse
});

test("bounded enumeration, symlink directory, missing runtime and non-primary registration fail closed", async t => {
  const f = await fixture(t);
  await saveWorkflowFixture(f.paths, "host-b"); await assert.rejects(f.register(), /primary/);
  await saveWorkflowFixture(f.paths);
  assert.equal(await api.findSession(sessionId, { ...f.deps, runtimeDirectory: join(f.root, "absent") }), null);
  const alias = join(f.root, "alias"); await symlink(f.deps.runtimeDirectory, alias);
  await assert.rejects(api.findSession(sessionId, { ...f.deps, runtimeDirectory: alias }));
  for (let i = 0; i < 512; i++) await writeFile(join(f.deps.runtimeDirectory, `unrelated-${i}`), "");
  await assert.rejects(f.register(), /bounded limit/);
  assert.equal(await readGuardianRecord(join(f.root, "absent")), null);
});


test("normal Pi 0644 session headers register without chmod or transcript mutation", async t => {
  const f = await fixture(t);
  await chmod(f.sessionFile, 0o644);
  const before = await stat(f.sessionFile), bytes = await readFile(f.sessionFile);
  assert.equal((await f.register()).sessionId, sessionId);
  const after = await stat(f.sessionFile);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(f.sessionFile), bytes);
});
