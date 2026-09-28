import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

// HOME and runtime registration belong solely to a disposable child process.
// Never read/write the real Pi runtime or invoke a notification sender.
test("live registered Desktop Guardian is an exact candidate without Git cwd or bridge; primary guard remains", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "guardian-candidates-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const module = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const script = `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { rm, writeFile, mkdir } from 'node:fs/promises';
    import { resolveAppPaths } from ${module("config")};
    import { createHostIdentity, saveHostIdentity } from ${module("host")};
    import { saveWorkflowFixture } from ${JSON.stringify(new URL("./guardian-workflow-fixture.js", import.meta.url).href)};
    import { writeJsonAtomic } from ${module("storage")};
    import { guardianCandidates } from ${module("guardian")};
    const paths = resolveAppPaths({ GIT_SYNC_HOME: join(process.env.HOME, 'app') });
    await saveHostIdentity(paths, createHostIdentity('host-a'));
    await saveWorkflowFixture(paths);
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const cwd = join(process.env.HOME, 'non-git-guardian');
    const sessionFile = join(process.env.HOME, '.pi/agent/sessions/guardian/session.jsonl');
    await mkdir(join(process.env.HOME, '.pi/agent/sessions/guardian'), { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\\n', { mode: 0o600 });
    const desktopPath = join(paths.stateDirectory, 'guardian-desktop.json');
    const runtimePath = join(process.env.HOME, '.pi/agent/runtime', process.pid + '.jsonl');
    const desktop = { enabled: true, pid: process.pid, sessionId, sessionFile, cwd, rmuxTarget: 'fake:1', profile: 'standard-pi' };
    await writeJsonAtomic(desktopPath, desktop);
    assert.deepEqual(await guardianCandidates(paths), []); // not registered
    await writeJsonAtomic(runtimePath, { type: 'pi_runtime', pid: process.pid, sessionPath: sessionFile, cwd });
    const candidates = await guardianCandidates(paths);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sessionId, sessionId);
    assert.equal(candidates[0].repositoryPath, cwd);
    assert.ok(Number.isFinite(Date.parse(candidates[0].lastEventAt)));
    const at = new Date().toISOString();
    await writeJsonAtomic(paths.sessionsFile, { schemaVersion: 1, projectedAt: at, sessions: { old: {
      hostId: 'host-a', sessionId, repositoryPath: '/old/bridge/cwd', sessionFile, status: 'active',
      startedAt: at, lastEventAt: at, lastEventId: 'old',
    } } });
    assert.equal((await guardianCandidates(paths)).length, 1);
    assert.equal((await guardianCandidates(paths))[0].repositoryPath, cwd);
    await rm(paths.sessionsFile);
    await writeJsonAtomic(runtimePath, { type: 'pi_runtime', pid: process.pid, sessionPath: sessionFile, cwd: '/wrong' });
    await assert.rejects(guardianCandidates(paths));
    await writeJsonAtomic(runtimePath, { type: 'pi_runtime', pid: process.pid, sessionPath: '/wrong', cwd });
    await assert.rejects(guardianCandidates(paths));
    await writeJsonAtomic(desktopPath, { ...desktop, enabled: false });
    assert.deepEqual(await guardianCandidates(paths), []);
    await saveHostIdentity(paths, createHostIdentity('host-b'));
    await assert.rejects(guardianCandidates(paths), /fixed primary host/);
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
    env: { PATH: "/usr/bin:/bin", HOME: home }, timeout: 20_000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.stderr, "");
});
