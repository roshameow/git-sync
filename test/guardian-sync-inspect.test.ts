import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowFixture, saveWorkflowFixture, quotedPeerCommand } from "./guardian-workflow-fixture.js";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import { writeJsonAtomic } from "../src/storage.js";
import { loadDirectSyncConfig, verifiedWorkflowPeerSshArgv, type DirectSyncConfig } from "../src/direct-sync-service.js";
import { __guardianInspectForTests as api, inspectGuardianLocal } from "../src/guardian-sync-inspect.js";

// Verified regression: received history is not applied history. Dirty tracked edits
// plus an untracked backup must remain visible even when clean-FF permission is true.
// All subprocesses are local Git in disposable fixtures; SSH/installed CLI are fakes.
const remote = "github.com/example/project";
const options = { timeout: 20_000 };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guardian-inspection-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") }), repo = join(root, "sample-project");
  await mkdir(repo); await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await promisify(execFile)("/usr/bin/git", ["-C", repo, ...args], {
    timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("remote", "add", "origin", `https://${remote}.git`);
  await mkdir(join(repo, "plugins")); await writeFile(join(repo, "plugins", "entry.ts"), "export const n = 1;\n");
  await git("add", "."); await git("commit", "-m", "base"); const head = await git("rev-parse", "HEAD");
  await git("commit", "--allow-empty", "-m", "target already received"); const target = await git("rev-parse", "HEAD");
  await git("reset", "--hard", head);
  await writeFile(join(repo, "plugins", "entry.ts"), "export const n = 2; // private content\n");
  await writeFile(join(repo, "entry.backup"), "private backup contents");
  const config: DirectSyncConfig = { schemaVersion: 1, hostId: "host-b", peerHostId: "host-a", applyCleanFastForward: true,
    intervalSeconds: 60, repositories: [{ canonicalRemote: remote, branch: "main", enabled: true,
      localPath: repo, peerPath: "/fixture/peer/project" }] };
  await writeJsonAtomic(join(paths.stateDirectory, "direct-sync.json"), config);
  await saveHostIdentity(paths, createHostIdentity(config.hostId));
  await saveWorkflowFixture(paths, config.hostId, config.peerHostId);
  const inventory = { schemaVersion: 1 as const, hostId: config.hostId, generatedAt: new Date().toISOString(), roots: [root],
    repositories: [{ path: repo, gitMarker: "directory" as const, worktree: false, remoteName: "origin", canonicalRemote: remote }] };
  await saveInventory(paths, inventory);
  await saveRegistry(paths, setRepositoryMode(createEmptyRegistry(), remote, "enabled"));
  const now = new Date().toISOString();
  await writeJsonAtomic(join(paths.stateDirectory, "direct-sync-status.json"), { mode: "direct-peer", startedAt: now, completedAt: now,
    repositories: [{ canonicalRemote: remote, branch: "main", peerHostId: config.peerHostId, state: "blocked",
      transfer: { state: "received" }, apply: { state: "blocked-dirty", error: "SECRET CACHE ERROR" },
      received: { branch: "main", oid: target, receivedRef: `refs/received/${target}`, changed: true, completedAt: now, worktreeUpdated: false } }] });
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const deps = { workflow: async () => workflowFixture("host-b", "host-a"), config: async () => config,
    peer: async (p: typeof paths, id: string) => {
      assert.equal(p, paths); assert.equal(id, "host-a");
      return { executable: "FAKE-SSH-NEVER-EXECUTED", args: ["PIN-VERIFIED", "fixture-peer"] };
    },
    run: async (file: string, args: string[], env: NodeJS.ProcessEnv) => { calls.push({ file, args, env }); return JSON.stringify({ requestedAt: now }); } };
  return { root, paths, repo, git, head, target, config, inventory, now, calls, deps };
}

test("real Git: dirty edits + backup, received target, blocked-dirty and engine permission are distinct", options, async t => {
  const f = await fixture(t), index = await readFile(join(f.repo, ".git", "index"));
  const s = await inspectGuardianLocal(f.paths, remote), r = s.repositories[0]!;
  assert.equal(s.applyCleanFastForward, true); assert.equal(s.diagnosticEndpointCapabilities.apply, false);
  assert.equal(r.head, f.head); assert.equal(r.branch, "main"); assert.equal(r.cached?.receivedOid, f.target);
  assert.equal(r.cached?.apply, "blocked-dirty"); assert.equal(r.currentFresh, true);
  assert.deepEqual(r.dirty, { paths: [{ status: " M", path: "plugins/entry.ts" }, { status: "??", path: "entry.backup" }], total: 2, truncated: false });
  assert.equal(s.freshness.atomic, false); assert.equal(s.freshness.cachedStatus, true);
  assert.doesNotMatch(JSON.stringify(s), /private content|backup contents|SECRET|fingerprint|peerPath/);
  assert.deepEqual(await readFile(join(f.repo, ".git", "index")), index); assert.equal(await f.git("rev-parse", "HEAD"), f.head);
});

test("real Git parser preserves whitespace/newlines, lists both rename paths, caps at 40, handles detached HEAD", options, async t => {
  const f = await fixture(t);
  await f.git("mv", "plugins/entry.ts", "renamed file.ts");
  await writeFile(join(f.repo, "line\nbreak \".txt"), "secret");
  for (let i = 0; i < 45; i++) await writeFile(join(f.repo, `z${i}`), "secret");
  await f.git("checkout", "--detach");
  const r = (await inspectGuardianLocal(f.paths)).repositories[0]!;
  assert.equal(r.branch, null); assert.equal(r.dirty?.paths.length, 40); assert.equal(r.dirty?.total, 49); assert.equal(r.dirty?.truncated, true);
  assert.ok(r.dirty?.paths.some(p => p.path === 'line\nbreak ".txt'));
  assert.ok(r.dirty?.paths.some(p => p.path === "plugins/entry.ts"));
  assert.ok(r.dirty?.paths.some(p => p.path === "renamed file.ts"));
  assert.deepEqual(api.dirtyPaths("R  new name\0old\nname\0"), { paths: [{ status: "R ", path: "new name" }, { status: "R ", path: "old\nname" }], total: 2, truncated: false });
  assert.throws(() => api.dirtyPaths(" M broken"));
});

test("read-only Git disables fsmonitor/hooks and ignores hostile inherited Git environment", options, async t => {
  const f = await fixture(t), script = join(f.root, "must-not-run");
  await writeFile(script, `#!/bin/sh\ntouch '${f.root}/executed'\n`, { mode: 0o700 });
  await f.git("config", "core.fsmonitor", script); await f.git("config", "core.hooksPath", f.root);
  const old = process.env.GIT_DIR; process.env.GIT_DIR = "/nonexistent/hostile";
  try { assert.equal((await inspectGuardianLocal(f.paths)).repositories[0]?.currentFresh, true); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  await assert.rejects(readFile(join(f.root, "executed")), { code: "ENOENT" });
});

test("reject path/shell selectors; disabled, duplicate, mismatched remote and symlink inventory are not inspected", options, async t => {
  const f = await fixture(t);
  for (const bad of [f.repo, `${remote};id`, `${remote}\nwhoami`, "github.com/example/unknown", "-oProxyCommand=x"]) await assert.rejects(inspectGuardianLocal(f.paths, bad));
  f.config.repositories[0]!.enabled = false;
  assert.equal((await api.local(f.paths, remote, f.deps)).repositories[0]?.dirty, null);
  f.config.repositories[0]!.enabled = true;
  await saveInventory(f.paths, { ...f.inventory, repositories: [...f.inventory.repositories, ...f.inventory.repositories] });
  assert.equal((await inspectGuardianLocal(f.paths)).repositories[0]?.currentFresh, false);
  await saveInventory(f.paths, f.inventory); await f.git("remote", "set-url", "origin", "https://example.invalid/other.git");
  assert.equal((await inspectGuardianLocal(f.paths)).repositories[0]?.currentFresh, false);
  await symlink(f.repo, join(f.root, "alias"));
  await saveInventory(f.paths, { ...f.inventory, repositories: [{ ...f.inventory.repositories[0]!, path: join(f.root, "alias") }] });
  assert.equal((await inspectGuardianLocal(f.paths)).repositories[0]?.dirty, null);
  assert.equal(f.calls.length, 0);
});

test("bilateral transport uses fixed command + validated selector; drops unknown fields; offline never means synchronized", options, async t => {
  const f = await fixture(t), snapshot = await inspectGuardianLocal(f.paths, remote);
  const response = { ...snapshot, hostId: f.config.peerHostId, peerHostId: f.config.hostId, secretKey: "SECRET", fingerprint: "SECRET",
    repositories: [{ ...snapshot.repositories[0]!, head: f.target, dirty: { paths: [], total: 0, truncated: false } }] };
  f.deps.run = async (file, args, env) => { f.calls.push({ file, args, env }); return JSON.stringify(response); };
  const both = await api.both(f.paths, remote, f.deps);
  assert.equal(both.peer.available, true); assert.equal(both.synchronized, "unknown");
  assert.equal(both.local.repositories[0]?.head, f.head); assert.equal(both.local.repositories[0]?.dirty?.total, 2);
  assert.equal(both.peer.snapshot?.repositories[0]?.head, f.target); assert.equal(both.peer.snapshot?.repositories[0]?.dirty?.total, 0);
  assert.deepEqual(f.calls[0]?.args.slice(2), [quotedPeerCommand(["guardian", "local-inspect", remote])]);
  assert.doesNotMatch(JSON.stringify(both), /SECRET/);
  for (const text of ["not json", "x".repeat(512 * 1024 + 1), JSON.stringify({ ...response, hostId: "wrong" }),
    JSON.stringify({ ...response, repositories: [{ ...response.repositories[0], canonicalRemote: "github.com/example/other" }] })]) {
    f.deps.run = async () => text;
    const failed = await api.both(f.paths, remote, f.deps); assert.equal(failed.peer.available, false); assert.equal(failed.synchronized, "unknown");
  }
  f.deps.run = async () => JSON.stringify({ ...response, observedAt: new Date(Date.now() + 500).toISOString() });
  assert.equal((await api.both(f.paths, remote, f.deps)).peer.snapshot?.repositories[0]?.currentFresh, true);
  f.deps.run = async () => JSON.stringify({ ...response, observedAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await api.both(f.paths, remote, f.deps)).peer.snapshot?.repositories[0]?.currentFresh, false);
  f.deps.run = async () => JSON.stringify({ ...response, observedAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await api.both(f.paths, remote, f.deps)).peer.snapshot?.repositories[0]?.currentFresh, false);
  f.deps.peer = async () => { throw new Error("SECRET PIN"); };
  const offline = await api.both(f.paths, undefined, f.deps);
  assert.equal(offline.peer.snapshot, null); assert.match(offline.peer.error!, /Peer unavailable/); assert.doesNotMatch(offline.peer.error!, /SECRET/);
});

test("wake only requests reviewed CLI sync wake on both sides, scopes local env, and reports partial failure", options, async t => {
  const f = await fixture(t), result = await api.wake(f.paths, f.deps);
  assert.equal(result.local.requested, true); assert.equal(result.peer.requested, true); assert.equal(result.applied, false);
  assert.equal(result.result, "requested-not-applied"); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.file, process.execPath);
  assert.deepEqual(f.calls[0]!.args, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "sync", "wake"]);
  assert.deepEqual(f.calls[1]!.args.slice(2), [quotedPeerCommand(["sync", "wake"])]);
  assert.equal(resolveAppPaths(f.calls[0]!.env).daemonWakeFile, f.paths.daemonWakeFile);
  assert.equal(f.calls[0]!.env.NODE_OPTIONS, undefined);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  f.deps.peer = async () => { throw new Error("offline secret"); };
  const partial = await api.wake(f.paths, f.deps);
  assert.equal(partial.local.requested, true); assert.equal(partial.peer.requested, false); assert.equal(partial.applied, false);
  f.deps.run = async () => { throw new Error("SECRET CLI OUTPUT"); };
  const failed = await api.wake(f.paths, f.deps); assert.equal(failed.result, "not-requested");
  assert.equal(failed.local.requested, false); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  await assert.rejects(verifiedWorkflowPeerSshArgv(f.paths, "unsafe;id"));
});

test("stale or malformed cached evidence is explicit; host mismatch fails closed", options, async t => {
  const f = await fixture(t), cacheFile = join(f.paths.stateDirectory, "direct-sync-status.json");
  const cached = JSON.parse(await readFile(cacheFile, "utf8")); cached.completedAt = "2000-01-01T00:00:00.000Z";
  await writeJsonAtomic(cacheFile, cached);
  assert.equal((await inspectGuardianLocal(f.paths)).freshness.cachedRecent, false);
  await writeJsonAtomic(cacheFile, { invalid: true });
  const s = await inspectGuardianLocal(f.paths); assert.equal(s.freshness.cacheError, true); assert.equal(s.repositories[0]?.currentFresh, true);
  await saveHostIdentity(f.paths, createHostIdentity("fixture-other")); await assert.rejects(inspectGuardianLocal(f.paths), /host/);
});

// Reproduced pitfall: even read-only `git status` can invoke a clean filter.
// The diagnostic rejects configured filter keys before hashing, never emits values.
test("configured clean filters are rejected before status, with no index/worktree side effects", options, async t => {
  const f = await fixture(t), marker = join(f.root, "filter-executed"), script = join(f.root, "filter-script");
  await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`, { mode: 0o700 });
  await writeFile(join(f.repo, ".gitattributes"), "plugins/entry.ts filter=fixture\n");
  await f.git("config", "filter.fixture.clean", script);
  // Same-sized edit forces content hashing rather than the size-only dirty shortcut.
  await writeFile(join(f.repo, "plugins", "entry.ts"), "export const n = 2;\n");
  const index = await readFile(join(f.repo, ".git", "index"));
  const contents = await readFile(join(f.repo, "plugins", "entry.ts"));
  const s = await inspectGuardianLocal(f.paths), row = s.repositories[0]!;
  assert.equal(row.currentFresh, false); assert.equal(row.dirty, null);
  assert.match(row.error!, /configured Git filters/);
  assert.equal(row.cached?.apply, "blocked-dirty");
  assert.doesNotMatch(JSON.stringify(s), /filter-script|filter\.fixture|private content/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.repo, ".git", "index")), index);
  assert.deepEqual(await readFile(join(f.repo, "plugins", "entry.ts")), contents);
  // Positive control runs only this disposable fixture's harmless marker filter.
  await f.git("status", "--porcelain=v1");
  assert.equal(await readFile(marker, "utf8"), "executed");
});

test("submodule dirty scan is unavailable rather than invoking nested filter configuration", options, async t => {
  const f = await fixture(t);
  await f.git("update-index", "--add", "--cacheinfo", `160000,${f.head},nested-fixture`);
  const row = (await inspectGuardianLocal(f.paths)).repositories[0]!;
  assert.equal(row.currentFresh, false); assert.equal(row.dirty, null); assert.match(row.error!, /submodule/);
});

test("dirty filename JSON is capped at 16 KiB after escaping, with complete total and explicit truncation", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `?? ${i}${"\x01".repeat(1024)}\0`).join("");
  const dirty = api.dirtyPaths(rows);
  assert.equal(dirty.total, 20); assert.equal(dirty.truncated, true);
  assert.ok(dirty.paths.length > 0 && dirty.paths.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(dirty.paths)) <= 16 * 1024);
  const tooLong = api.dirtyPaths(`?? ${"é".repeat(3000)}\0`);
  assert.deepEqual(tooLong, { paths: [], total: 1, truncated: true });
});

test("SSH command quoting round-trips configured paths with spaces, quotes and dollar signs", options, async t => {
  const f = await fixture(t);
  await api.wake(f.paths, f.deps);
  const command = f.calls[1]!.args.at(-1)!;
  // Only a local shell printing arguments, never an SSH connection or CLI run.
  const result = await promisify(execFile)("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: f.root } });
  assert.deepEqual(result.stdout.split("\0"), ["/fixture/node bin/node", "/fixture/cli's $dir/cli.js", "sync", "wake", ""]);
});

test("peer projection allows 100 generic rows and rejects overflow", options, async t => {
  const f = await fixture(t), initial = (await inspectGuardianLocal(f.paths)).repositories[0]!;
  f.config.repositories = Array.from({ length: 100 }, (_, i) => ({ ...f.config.repositories[0]!,
    canonicalRemote: `github.com/example/repository-${i}`, enabled: false, reason: "fixture" }));
  const response = { schemaVersion: 1, hostId: f.config.peerHostId, peerHostId: f.config.hostId, observedAt: f.now,
    configured: true, applyCleanFastForward: true, freshness: { cachedCompletedAt: f.now, cacheError: false },
    repositories: f.config.repositories.map(r => ({ ...initial, canonicalRemote: r.canonicalRemote })) };
  f.deps.run = async () => JSON.stringify(response);
  const view = await api.both(f.paths, undefined, f.deps);
  assert.equal(view.peer.available, true); assert.equal(view.peer.snapshot?.repositories.length, 100);
  response.repositories.push({ ...response.repositories[0]!, canonicalRemote: "github.com/example/overflow" });
  assert.equal((await api.both(f.paths, undefined, f.deps)).peer.available, false);
});

test("workflow-only diagnostics and bilateral wake need no direct-sync enrollment", options, async t => {
  const f = await fixture(t);
  const directFile = join(f.paths.stateDirectory, "direct-sync.json");
  await rm(directFile);
  await rm(join(f.paths.stateDirectory, "direct-sync-status.json"));
  await rm(f.paths.registryFile);
  await rm(f.paths.inventoryDirectory, { recursive: true });
  const deps = { ...f.deps, config: loadDirectSyncConfig };
  const local = await api.local(f.paths, undefined, deps);
  assert.equal(local.configured, false); assert.deepEqual(local.repositories, []);
  assert.equal(local.peerHostId, "host-a");
  const response = { ...local, hostId: "host-a", peerHostId: "host-b" };
  deps.run = async (file, args, env) => { f.calls.push({ file, args, env }); return JSON.stringify(response); };
  const both = await api.both(f.paths, undefined, deps);
  assert.equal(both.peer.available, true); assert.equal(both.peer.snapshot?.configured, false);
  assert.equal(both.synchronized, "unknown");
  assert.equal(f.calls[0]?.args.at(-1), quotedPeerCommand(["guardian", "local-inspect"]));
  // A normal peer without reverse enrollment may report no peer identity.
  deps.run = async () => JSON.stringify({ ...response, peerHostId: null });
  assert.equal((await api.both(f.paths, undefined, deps)).peer.available, true);
  // Wake never needs to read the direct config at all.
  deps.config = async () => { throw new Error("must not read direct config for wake"); };
  deps.run = f.deps.run;
  const wake = await api.wake(f.paths, deps);
  assert.equal(wake.local.requested, true); assert.equal(wake.peer.requested, true);
  assert.equal(wake.applied, false);
  await assert.rejects(readFile(directFile), { code: "ENOENT" });
});

test("peer-only canonical selector is independent of local direct allowlist but still syntax checked", options, async t => {
  const f = await fixture(t), original = await api.local(f.paths, undefined, f.deps);
  const selected = "github.com/example/peer-only";
  await rm(join(f.paths.stateDirectory, "direct-sync.json"));
  const deps = { ...f.deps, config: loadDirectSyncConfig,
    run: async () => JSON.stringify({ ...original, hostId: "host-a", peerHostId: "host-b",
      repositories: [{ ...original.repositories[0]!, canonicalRemote: selected }] }) };
  const both = await api.both(f.paths, selected, deps);
  assert.equal(both.local.configured, false); assert.deepEqual(both.local.repositories, []);
  assert.equal(both.peer.available, true); assert.equal(both.peer.snapshot?.repositories[0]?.canonicalRemote, selected);
  for (const bad of ["/a/path", `${selected};id`, `${selected}\n`, "-oProxyCommand=bad"])
    await assert.rejects(api.both(f.paths, bad, deps));
});

test("wake with zero or ambiguous workflow peers still wakes locally but never guesses a remote", options, async t => {
  const f = await fixture(t), good = workflowFixture("host-b", "host-a");
  for (const peers of [{}, { ...good.peers, extra: good.peers["host-a"]! }, { "host-b": good.peers["host-a"]! }]) {
    let verified = 0;
    const deps = { ...f.deps, workflow: async () => ({ ...good, peers }),
      peer: async () => { verified++; throw new Error("must not guess peer"); } };
    const result = await api.wake(f.paths, deps);
    assert.equal(result.local.requested, true); assert.equal(result.peer.requested, false);
    assert.equal(result.result, "requested-not-applied"); assert.equal(verified, 0);
  }
});
