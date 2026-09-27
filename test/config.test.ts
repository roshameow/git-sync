import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, parseConfig, pinnedWire, quote, sshCommand, wireFingerprint } from "../src/config.js";
import { once, repoDirectory, status } from "../src/controller.js";
import { withOwnedLocalLock } from "../src/local-lock.js";

const exec = promisify(execFile), options = { timeout: 30_000 };
// Fresh public key generated per test process, never a genuine deployed host key.
const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const wire = `ssh-ed25519 ${Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), key]).toString("base64")}`;
const raw = () => ({ peer: { host: "peer.example.invalid", user: "operator", hostKey: { wire } },
  repos: [{ id: "project", localPath: "/example/local/project", peerPath: "/example/peer/project", branch: "main" }] });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "git-sync-config-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const absent = async (p: string) => assert.rejects(lstat(p), { code: "ENOENT" });
async function git(path: string, ...args: string[]) {
  return (await exec("/usr/bin/git", ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { timeout: 10_000, env: { PATH: "/usr/bin:/bin", HOME: path, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
}

test("strict generic configuration: explicit identities, default receive-only, no input mutation", options, () => {
  const input = raw(), before = JSON.stringify(input), c = parseConfig(input);
  assert.equal(c.applyCleanFastForward, false); assert.equal(c.pollSeconds, 60);
  assert.equal(JSON.stringify(input), before);
  assert.ok(c.stateDirectory.endsWith("/.local/state/git-sync"));
  for (const pollSeconds of [30, 900]) assert.equal(parseConfig({ ...raw(), pollSeconds }).pollSeconds, pollSeconds);
  for (const pollSeconds of [29, 901, 30.5, "60", null]) assert.throws(() => parseConfig({ ...raw(), pollSeconds }));
  for (const applyCleanFastForward of [null, "false", 0]) assert.throws(() => parseConfig({ ...raw(), applyCleanFastForward }));
  assert.equal(parseConfig({ ...raw(), applyCleanFastForward: true }).applyCleanFastForward, true);
  for (const bad of [{}, { ...raw(), command: "anything" }, { ...raw(), repos: [] }, { ...raw(), repos: [raw().repos[0], raw().repos[0]] }])
    assert.throws(() => parseConfig(bad));
  for (const host of ["-oProxyCommand=bad", "host;bad", "user@host", "host/path", "a..b", "a\nb", "*.invalid", "[::1]"])
    assert.throws(() => parseConfig({ ...raw(), peer: { ...raw().peer, host } }));
  for (const user of ["-bad", "user name", "x;bad", "x\ny"])
    assert.throws(() => parseConfig({ ...raw(), peer: { ...raw().peer, user } }));
  for (const branch of ["-main", "a..b", "x.lock", "a/.b", "a//b", "a/", "main;bad", "a@{b", "a."])
    assert.throws(() => parseConfig({ ...raw(), repos: [{ ...raw().repos[0], branch }] }));
  for (const localPath of ["relative", "/", "/a/../b", "/a\nb", "/a/"])
    assert.throws(() => parseConfig({ ...raw(), repos: [{ ...raw().repos[0], localPath }] }));
  for (const hostKey of [{ wire: "ssh-ed25519 REPLACE_ME" }, { wire, fingerprint: "extra" }, { wire, shell: "bad" }])
    assert.throws(() => parseConfig({ ...raw(), peer: { ...raw().peer, hostKey } }));
});

test("configuration requires owner 0600 regular files; missing config and status do not create state", options, async t => {
  const root = await fixture(t), file = join(root, "config.json"), stateDirectory = join(root, "state");
  await assert.rejects(loadConfig(file), { code: "ENOENT" });
  await writeFile(file, JSON.stringify({ ...raw(), stateDirectory }), { mode: 0o600 });
  const c = await loadConfig(file);
  assert.deepEqual(await status(c), [{ id: "project", status: "never-run" }]); await absent(stateDirectory);
  await chmod(file, 0o644); await assert.rejects(loadConfig(file), /0600/); await chmod(file, 0o600);
  const link = join(root, "link"); await symlink(file, link); await assert.rejects(loadConfig(link));
  await exec("/usr/bin/mkfifo", [join(root, "fifo")], { timeout: 5_000 }); await assert.rejects(loadConfig(join(root, "fifo")));
  const home = join(root, "home"); await mkdir(home);
  for (const cmd of ["once", "status", "invalid"]) await assert.rejects(exec(process.execPath, [resolve("dist/src/cli.js"), cmd],
    { timeout: 5_000, env: { ...process.env, HOME: home } }));
  assert.deepEqual(await readdir(home), []); await absent(stateDirectory);
});

test("knownHosts pin is exact and fingerprint-bound; generated SSH quoting cannot run a shell payload", options, async t => {
  const root = await fixture(t), hosts = join(root, "known_hosts");
  const c = parseConfig({ ...raw(), peer: { ...raw().peer, hostKey: { knownHosts: hosts, fingerprint: wireFingerprint(wire) } } });
  await writeFile(hosts, `${c.peer.host} ${wire} comment\n`, { mode: 0o600 }); assert.equal(await pinnedWire(c), wire);
  for (const text of [`other.invalid ${wire}\n`, `${c.peer.host} ${wire}\n${c.peer.host} ${wire}\n`, `${c.peer.host} ssh-ed25519 INVALID\n`]) {
    await writeFile(hosts, text); await assert.rejects(pinnedWire(c));
  }
  await writeFile(hosts, `${c.peer.host} ${wire}\n`);
  const changed = parseConfig({ ...raw(), peer: { ...raw().peer, hostKey: { knownHosts: hosts, fingerprint: `SHA256:${"A".repeat(43)}` } } });
  await assert.rejects(pinnedWire(changed), /fingerprint/);
  const sentinel = join(root, "injected"), tricky = join(root, `a ' \" $(touch ${sentinel}) ; hosts`);
  // -G only prints OpenSSH's parsed configuration: no connection or external host.
  const output = (await exec("/bin/sh", ["-c", `${sshCommand(tricky)} -G ${quote(c.peer.host)}`], { timeout: 5_000 })).stdout;
  assert.match(output, /stricthostkeychecking true/); assert.match(output, /batchmode yes/);
  assert.ok(output.includes(tricky)); await absent(sentinel);
  for (const stateDirectory of [join(root, "%h"), join(root, "${HOME}")]) {
    assert.throws(() => parseConfig({ ...raw(), stateDirectory }));
    assert.throws(() => sshCommand(join(stateDirectory, "known_hosts")), /filename expansions/);
  }
});

test("real Git controller retains old intents in receive-only mode, writes status, and serializes", options, async t => {
  const root = await fixture(t), localPath = join(root, "repo"), stateDirectory = join(root, "state");
  await mkdir(localPath); await git(localPath, "init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main");
  await writeFile(join(localPath, "tracked"), "original\n"); await git(localPath, "add", ".");
  await git(localPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial");
  const c = parseConfig({ ...raw(), stateDirectory, repos: [{ ...raw().repos[0], localPath }] });
  const dir = repoDirectory(c, c.repos[0]!); await mkdir(dir, { recursive: true, mode: 0o700 });
  const intent = join(dir, "apply-intent.json"); await writeFile(intent, "{partial evidence", { mode: 0o600 });
  const before = await readFile(join(localPath, ".git/index")), head = await git(localPath, "rev-parse", "HEAD");
  const result = await once(c); assert.equal(result[0]!.status, "needs-recovery");
  assert.equal((await status(c) as { status: string }[])[0]!.status, "needs-recovery");
  assert.equal(await readFile(intent, "utf8"), "{partial evidence");
  assert.deepEqual(await readFile(join(localPath, ".git/index")), before); assert.equal(await git(localPath, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(localPath, "tracked"), "utf8"), "original\n"); await absent(join(dir, "received.git"));
  assert.equal((await lstat(join(dir, "status.json"))).mode & 0o777, 0o600);
  const lock = join(stateDirectory, "controller.lock");
  await withOwnedLocalLock(lock, "test", async () => { await assert.rejects(once(c), /lock already exists/); });
  await absent(lock);
  await writeFile(lock, "stale evidence", { mode: 0o600 }); await assert.rejects(once(c), /lock already exists/);
  assert.equal(await readFile(lock, "utf8"), "stale evidence");
  await rm(lock); await rm(intent); // Explicit removal of test-owned evidence only.
  const id = async (p: string) => { const st = await lstat(p); return `${st.dev}:${st.ino}`; };
  const gitDir = join(localPath, ".git");
  const saved = { version: 1, ...c.repos[0], repositoryIdentity: await id(localPath), gitDir, gitDirIdentity: await id(gitDir),
    commonDir: gitDir, commonDirIdentity: await id(gitDir), host: c.peer.host, user: c.peer.user, fingerprint: wireFingerprint(wire) };
  await writeFile(join(dir, "identity.json"), JSON.stringify(saved), { mode: 0o600 });
  const renamed = parseConfig({ ...c, repos: [{ ...c.repos[0], id: "renamed" }] });
  assert.equal(repoDirectory(renamed, renamed.repos[0]!), dir);
  assert.deepEqual(await status(renamed), [{ id: "renamed", status: "needs-recovery", reason: "Saved status identity changed" }]);
  await rename(gitDir, join(root, "old-git"));
  await git(localPath, "init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main");
  const changed = await once(c);
  assert.equal(changed[0]!.status, "error"); assert.match(String(changed[0]!.reason), /mapping changed/);
  await absent(join(dir, "known_hosts")); // Rejection precedes SSH or any receive attempt.
  assert.deepEqual(JSON.parse(await readFile(join(dir, "identity.json"), "utf8")), saved);
  const target = join(root, "target"), alias = join(root, "alias"); await mkdir(target); await symlink(target, alias);
  await assert.rejects(once(parseConfig({ ...c, stateDirectory: join(alias, "new-state") })), /canonical/);
  assert.deepEqual(await readdir(target), []);
});
