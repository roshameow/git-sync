import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { resolveAppPaths } from "../src/config.js";
import { inspectRepositoryPath } from "../src/discovery.js";
import { receiveCommittedBranch, type DirectSyncInput } from "../src/direct-sync.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, loadRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import { writeJsonAtomic } from "../src/storage.js";
import { withStateMutationLock } from "../src/state-mutation.js";
import {
  __runUpstreamSyncOnceForTests, configureUpstreamSync, loadUpstreamSyncConfig, runUpstreamSyncOnce, upstreamSyncStatus,
  type UpstreamSyncConfig, type UpstreamSyncTestTransport,
} from "../src/upstream-sync-service.js";

const exec = promisify(execFile);
const remote = "github.com/example/upstream-project";
const options = { timeout: 60_000 };
// Independent temp-Git oracle: only file transport is permitted, no global Git
// configuration/credentials, no hooks. No live repository or network is opened.
async function tempGit(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  })).stdout.trim();
}
async function commit(repo: string, contents: string): Promise<string> {
  await writeFile(join(repo, "tracked.txt"), contents);
  await tempGit(repo, "add", ".");
  await tempGit(repo, "commit", "--quiet", "-m", contents);
  return tempGit(repo, "rev-parse", "HEAD");
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "upstream-sync-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const source = join(root, "github-TEST-source"), repository = join(root, "existing-checkout");
  await mkdir(source);
  await tempGit(source, "init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main");
  await tempGit(source, "config", "user.name", "Upstream Test");
  await tempGit(source, "config", "user.email", "upstream@example.invalid");
  await tempGit(source, "config", "commit.gpgSign", "false");
  await writeFile(join(source, ".gitignore"), "ignored.txt\ncache/\n");
  const first = await commit(source, "first\n");
  await tempGit(root, "clone", "--quiet", "--no-hardlinks", "--template=", source, repository);
  await tempGit(repository, "remote", "set-url", "origin", "git@github.com:Example/Upstream-Project.git");
  await tempGit(repository, "config", "user.name", "Upstream Test");
  await tempGit(repository, "config", "user.email", "upstream@example.invalid");
  await tempGit(repository, "config", "commit.gpgSign", "false");
  const tip = await commit(source, "second\n");
  const host = createHostIdentity("generic-single-host");
  await saveHostIdentity(paths, host);
  const record = await inspectRepositoryPath(repository);
  const inventory = { schemaVersion: 1 as const, hostId: host.id, generatedAt: new Date().toISOString(),
    roots: [root], repositories: [record] };
  await saveInventory(paths, inventory);
  const registry = setRepositoryMode(createEmptyRegistry(), remote, "enabled");
  await saveRegistry(paths, registry);
  const config: UpstreamSyncConfig = { schemaVersion: 1, hostId: host.id, intervalSeconds: 60,
    repositories: [{ canonicalRemote: remote, branch: "main", enabled: true, applyCleanFastForward: true }] };
  const file = join(paths.stateDirectory, "upstream-sync.json"), statusFile = join(paths.stateDirectory, "upstream-sync-status.json");
  const appRoot = join(paths.stateDirectory, "upstream-sync");
  const key = createHash("sha256").update(`github-upstream:${remote}`).digest("hex");
  const store = join(appRoot, `${key}.git`), intentPath = join(appRoot, `apply-${key}.json`);
  const calls: DirectSyncInput[] = [];
  const adapter: UpstreamSyncTestTransport = { TEST_ONLY: true, receive: async input => {
    calls.push(input);
    assert.equal(input.source, `https://${remote}.git`);
    assert.equal(input.store, store);
    assert.equal(input.githubHttps, true);
    assert.equal(input.githubCli, "/usr/bin/gh");
    assert.equal(input.sshCommand, undefined);
    assert.ok(Object.keys(input).every(key => ["store", "source", "branch", "githubHttps", "githubCli", "signal"].includes(key)),
      "production supplies only the fixed GitHub HTTPS transport; no configurable credentials or SSH fallback");
    // This is the ONLY substituted operation. Receive, immutable refs, identity
    // checks, state locks, durable intents and checkout apply remain real.
    // Drop the HTTPS flag as well as replacing the endpoint: keeping it would
    // correctly reject our local test path before any receive/store operation.
    const { githubHttps: _unused, ...local } = input;
    return receiveCommittedBranch({ ...local, source, timeoutMs: 10_000 });
  } };
  const run = (signal?: AbortSignal) => __runUpstreamSyncOnceForTests(paths, adapter, signal ? { signal } : {});
  const save = (value: unknown = config) => writeJsonAtomic(file, value);
  return { root, paths, source, repository, first, tip, host, record, inventory, registry, config, file, statusFile,
    appRoot, store, intentPath, adapter, calls, run, save };
}
async function absent(path: string) { await assert.rejects(lstat(path), { code: "ENOENT" }); }
async function snapshot(repository: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (path === ".git/objects") continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
      else files[path] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
    }
  }
  await walk(repository);
  return files;
}

// Verified offline method / persistence: these regression tests are the durable
// experience artifact. Atomic same-content replacement revokes a pass; retained
// receive refs are evidence, never permission to replay a cached/offline apply.
// The HTTPS transport adapter must drop githubHttps for its local file source;
// the real core validates fixed GitHub URLs before even initializing the store.
// Temporary tsc output needs its own {"type":"module"} package.json outside this
// package; Node 25 no longer accepts --experimental-default-type=module.
test("absent config is an offline no-op and does not manufacture state", options, async t => {
  const f = await fixture(t);
  assert.equal(await loadUpstreamSyncConfig(f.paths), null);
  assert.equal(await runUpstreamSyncOnce(f.paths), null);
  assert.equal(await upstreamSyncStatus(f.paths), null);
  assert.equal(await f.run(), null);
  assert.equal(f.calls.length, 0);
  await absent(f.statusFile); await absent(f.appRoot);
});

test("explicit registration enables registry and safe apply, preserves all other registry fields; disable stays local", options, async t => {
  const f = await fixture(t);
  await saveRegistry(f.paths, { ...f.registry, extraRegistry: "retained",
    repositories: { ...f.registry.repositories, [remote]: { ...f.registry.repositories[remote]!, mode: "ignored",
      repositoryNodeId: "R_fixture", extraEntry: { keep: true } } } } as typeof f.registry);
  const before = await loadRegistry(f.paths);
  const result = await configureUpstreamSync(f.paths, "github.com/Example/Upstream-Project", "main", true);
  assert.deepEqual(result, f.config);
  assert.deepEqual(await loadUpstreamSyncConfig(f.paths), f.config);
  const after = await loadRegistry(f.paths);
  assert.deepEqual({ ...after, updatedAt: before.updatedAt, repositories: before.repositories }, before);
  assert.deepEqual({ ...after.repositories[remote], mode: "ignored", updatedAt: before.repositories[remote]!.updatedAt }, before.repositories[remote]);
  assert.equal(after.repositories[remote]?.mode, "enabled");
  const disabled = await configureUpstreamSync(f.paths, remote, "ignored-disable-argument", false);
  assert.deepEqual(disabled.repositories[0], { canonicalRemote: remote, branch: "main", enabled: false, applyCleanFastForward: false });
  assert.deepEqual(await loadRegistry(f.paths), after);
  assert.equal((await runUpstreamSyncOnce(f.paths))!.repositories[0]!.apply.state, "blocked-disabled");
  assert.equal((await lstat(f.file)).mode & 0o7777, 0o600);
  assert.equal((await lstat(f.statusFile)).mode & 0o7777, 0o600);
});

test("registration requires one real local identity, but disabling works after checkout disappears", options, async t => {
  const f = await fixture(t);
  const before = await readFile(f.paths.registryFile, "utf8");
  await saveInventory(f.paths, { ...f.inventory, repositories: [] });
  await assert.rejects(configureUpstreamSync(f.paths, remote, "main", true), /Local inventory/);
  await absent(f.file);
  assert.equal(await readFile(f.paths.registryFile, "utf8"), before);
  await saveInventory(f.paths, f.inventory);
  await configureUpstreamSync(f.paths, remote, "main", true);
  await rename(f.repository, `${f.repository}-removed`);
  await assert.rejects(configureUpstreamSync(f.paths, remote, "main", true), /Local inventory/);
  const disabled = await configureUpstreamSync(f.paths, remote, "different-branch", false);
  assert.deepEqual(disabled.repositories[0], { canonicalRemote: remote, branch: "main", enabled: false, applyCleanFastForward: false });
  assert.deepEqual((await configureUpstreamSync(f.paths, remote, "another-disable-argument", false)).repositories, disabled.repositories);
});

test("config bounds, canonical-only remotes, explicit per-row opt-in and safe refs", options, async t => {
  const f = await fixture(t), row = f.config.repositories[0]!;
  for (const intervalSeconds of [30, 900]) {
    await f.save({ ...f.config, intervalSeconds });
    assert.equal((await loadUpstreamSyncConfig(f.paths))!.intervalSeconds, intervalSeconds);
  }
  await f.save({ ...f.config, repositories: [] });
  assert.deepEqual((await f.run())!.repositories, []);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...row, canonicalRemote: `github.com/example/repo-${i}` }));
  await f.save({ ...f.config, repositories: hundred });
  assert.equal((await loadUpstreamSyncConfig(f.paths))!.repositories.length, 100);
  const registryBefore = await readFile(f.paths.registryFile, "utf8");
  await assert.rejects(configureUpstreamSync(f.paths, remote, "main", true), /Invalid upstream sync config/);
  assert.equal(await readFile(f.paths.registryFile, "utf8"), registryBefore);
  const invalid: unknown[] = [null, [], {}, { ...f.config, schemaVersion: 2 }, { ...f.config, hostId: "../other" },
    { ...f.config, peerHostId: "peer" }, { ...f.config, sshCommand: "unsafe" },
    { ...f.config, githubHttps: false }, { ...f.config, transport: "ssh" }, { ...f.config, credentialHelper: "unsafe" },
    { ...f.config, intervalSeconds: 29 },
    { ...f.config, intervalSeconds: 901 }, { ...f.config, intervalSeconds: 60.5 }, { ...f.config, intervalSeconds: "60" },
    { ...f.config, repositories: [...hundred, { ...row, canonicalRemote: "github.com/example/extra" }] },
    { ...f.config, repositories: [row, row] }];
  for (const canonicalRemote of ["https://github.com/example/repo", "git@github.com:example/repo.git", "github.com/example/repo.git",
    "github.com/example/repo/extra", "evil.example/example/repo", "github.com:22/example/repo", "github.com/example/..",
    "github.com/-owner/repo", "github.com/owner-/repo", "github.com/example/repo;touch", "github.com/example/repo\n"])
    invalid.push({ ...f.config, repositories: [{ ...row, canonicalRemote }] });
  for (const branch of ["", "-main", "main.lock", "main.", "a/.b", "a//b", "a..b", "main\n", "a".repeat(201)])
    invalid.push({ ...f.config, repositories: [{ ...row, branch }] });
  for (const override of [{ enabled: undefined }, { applyCleanFastForward: undefined }, { applyCleanFastForward: "yes" },
    { peerPath: "/never-opened" }, { source: "file:///not-authority" }])
    invalid.push({ ...f.config, repositories: [{ ...row, ...override }] });
  for (const value of invalid) { await f.save(value); await assert.rejects(f.run(), /Invalid/); }
  assert.equal(f.calls.length, 0);
  for (const value of ["https://github.com/example/repo", "git@github.com:example/repo.git", "github.com/example/repo;echo"])
    await assert.rejects(configureUpstreamSync(f.paths, value, "main", true), /Invalid canonical/);
});

test("config and status require owned 0600 bounded single-link regular files", options, async t => {
  const f = await fixture(t); f.config.repositories[0]!.enabled = false; await f.save(); await f.run();
  for (const [file, limit, load] of [[f.file, 128 * 1024, () => loadUpstreamSyncConfig(f.paths)],
    [f.statusFile, 512 * 1024, () => upstreamSyncStatus(f.paths)]] as const) {
    const original = await readFile(file, "utf8");
    await chmod(file, 0o644); await assert.rejects(load(), /Unsafe/); await chmod(file, 0o600);
    const alias = join(f.root, "hardlink"); await link(file, alias); await assert.rejects(load(), /Unsafe/); await rm(alias);
    await rm(file); const target = join(f.root, "target"); await writeFile(target, original, { mode: 0o600 });
    await symlink(target, file); await assert.rejects(load(), /Unsafe/); await rm(file); await rm(target);
    await mkdir(file); await assert.rejects(load(), /Unsafe/); await rm(file, { recursive: true });
    await writeFile(file, "x".repeat(limit + 1), { mode: 0o600 }); await assert.rejects(load(), /Unsafe/);
    await writeFile(file, original, { mode: 0o600 });
  }
  const status = (await upstreamSyncStatus(f.paths))!;
  for (const altered of [ { ...status, mode: "direct-peer" }, { ...status, hostId: "../escape" },
    { ...status, repositories: [{ ...status.repositories[0], peerHostId: "peer" }] },
    { ...status, repositories: [{ ...status.repositories[0], transfer: { state: "unknown" } }] },
    { ...status, repositories: [{ ...status.repositories[0], apply: { state: "error", error: "bad\nvalue" } }] },
    ...[42, "", "not-an-oid", "a".repeat(39), "a".repeat(40) + "\n"].map(localHead =>
      ({ ...status, repositories: [{ ...status.repositories[0], localHead }] })) ]) {
    await writeJsonAtomic(f.statusFile, altered); await assert.rejects(upstreamSyncStatus(f.paths), /Invalid/);
  }
});

test("single LOCAL inventory suffices; safe FF preserves unrelated untracked/ignored files and business refs", options, async t => {
  const f = await fixture(t); await f.save();
  // Even unreadable remote-host inventory cannot make a peer a prerequisite.
  await writeFile(join(f.paths.inventoryDirectory, "unrelated-peer.json"), "not valid JSON");
  await writeFile(join(f.repository, "notes.txt"), "untracked notes\n");
  await mkdir(join(f.repository, "cache")); await writeFile(join(f.repository, "cache/output.txt"), "ignored output\n");
  await writeFile(join(f.repository, ".git/FETCH_HEAD"), "previous local observation\n");
  await tempGit(f.repository, "tag", "local-only", f.first);
  const refs = await tempGit(f.repository, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags");
  const source = await snapshot(f.source);
  const status = (await f.run())!, row = status.repositories[0]!;
  assert.equal(status.mode, "upstream"); assert.equal(status.hostId, f.host.id); assert.ok(status.completedAt);
  assert.equal(row.peerHostId, undefined); assert.ok(!Object.hasOwn(row, "peerHostId"));
  assert.equal(row.state, "applied"); assert.equal(row.transfer.state, "received"); assert.equal(row.apply.state, "fast-forwarded");
  assert.equal(row.received?.oid, f.tip);
  assert.equal(row.localHead, f.tip, "post-apply HEAD is fresh evidence from the validated local checkout");
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.tip);
  assert.equal(await readFile(join(f.repository, "tracked.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(f.repository, "notes.txt"), "utf8"), "untracked notes\n");
  assert.equal(await readFile(join(f.repository, "cache/output.txt"), "utf8"), "ignored output\n");
  assert.equal(await readFile(join(f.repository, ".git/FETCH_HEAD"), "utf8"), "previous local observation\n");
  assert.equal(await tempGit(f.repository, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags"), refs);
  assert.deepEqual(await snapshot(f.source), source, "upstream source is strictly read-only");
  assert.equal(await tempGit(f.store, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(await tempGit(f.store, "rev-parse", row.received!.receivedRef), f.tip);
  await absent(f.intentPath);
  assert.deepEqual(await upstreamSyncStatus(f.paths), status);
  assert.equal((await f.run())!.repositories[0]!.apply.state, "up-to-date");
});

test("explicit receive-only leaves checkout unchanged; source reset retains both immutable received refs", options, async t => {
  const f = await fixture(t); f.config.repositories[0]!.applyCleanFastForward = false; await f.save();
  const before = await snapshot(f.repository);
  const first = (await f.run())!.repositories[0]!;
  assert.equal(first.apply.state, "not-requested"); assert.equal(first.state, "received-not-applied");
  assert.equal(first.localHead, f.first);
  assert.deepEqual(await snapshot(f.repository), before);
  await tempGit(f.source, "reset", "--hard", f.first);
  const next = (await f.run())!.repositories[0]!;
  assert.equal(next.received?.oid, f.first);
  assert.equal(await tempGit(f.store, "rev-parse", first.received!.receivedRef), f.tip);
  assert.equal(await tempGit(f.store, "rev-parse", next.received!.receivedRef), f.first);
  assert.deepEqual(await snapshot(f.repository), before);
});

// Verified static reason contract: tracked/staged dirt and untracked/ignored
// target-path collisions stay distinct without persisting paths or Git stderr.
// Neither safety gate is reported as a merge conflict.
test("dirty, diverged, branch and target-collision gates preserve bytes and distinct static dirty reasons", options, async t => {
  for (const scenario of ["dirty", "staged", "diverged", "branch", "collision", "ignored-collision"] as const) {
    const f = await fixture(t); await f.save();
    if (scenario === "dirty" || scenario === "staged") await writeFile(join(f.repository, "tracked.txt"), "dirty local bytes\n");
    if (scenario === "staged") await tempGit(f.repository, "add", "tracked.txt");
    if (scenario === "diverged") await commit(f.repository, "independent local commit\n");
    if (scenario === "branch") await tempGit(f.repository, "checkout", "-b", "another-branch");
    if (scenario === "collision" || scenario === "ignored-collision") {
      const path = scenario === "collision" ? "new.txt" : "ignored.txt";
      await writeFile(join(f.repository, path), "untracked local bytes\n");
      await writeFile(join(f.source, path), "upstream addition\n");
      await tempGit(f.source, "add", "--force", path); await commit(f.source, "third\n");
    }
    const before = await snapshot(f.repository);
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.transfer.state, "received");
    assert.equal(row.apply.state, scenario === "diverged" ? "blocked-diverged" : scenario === "branch" ? "blocked-branch" : "blocked-dirty");
    if (scenario !== "diverged" && scenario !== "branch") {
      assert.equal(row.apply.result?.status, "blocked-dirty");
      assert.ok(row.apply.result && "reason" in row.apply.result);
      assert.equal(row.apply.result.reason, scenario === "dirty" || scenario === "staged"
        ? "Tracked or staged changes" : "Untracked or ignored path collides with target checkout");
      assert.deepEqual((await upstreamSyncStatus(f.paths))!.repositories[0]!.apply, row.apply);
    }
    assert.equal(row.state, "blocked"); assert.deepEqual(await snapshot(f.repository), before);
    assert.equal(await tempGit(f.store, "rev-parse", row.received!.receivedRef), row.received!.oid);
    await absent(f.intentPath);
  }
});

test("missing/disabled registry or inventory, duplicate checkouts, changed remotes and symlinks block before transport", options, async t => {
  for (const scenario of ["registry-missing", "disabled", "inventory-missing", "duplicate", "remote", "symlink", "host", "host-missing"] as const) {
    const f = await fixture(t); await f.save();
    if (scenario === "registry-missing") await rm(f.paths.registryFile);
    if (scenario === "disabled") await saveRegistry(f.paths, setRepositoryMode(f.registry, remote, "disabled"));
    if (scenario === "inventory-missing") await rm(join(f.paths.inventoryDirectory, `${f.host.id}.json`));
    if (scenario === "duplicate") await saveInventory(f.paths, { ...f.inventory, repositories: [f.record, f.record] });
    if (scenario === "remote") await tempGit(f.repository, "remote", "set-url", "origin", "git@github.com:example/different.git");
    if (scenario === "symlink") {
      await rename(f.repository, `${f.repository}-target`); await symlink(`${f.repository}-target`, f.repository);
    }
    if (scenario === "host") await saveHostIdentity(f.paths, createHostIdentity("another-host"));
    if (scenario === "host-missing") await rm(f.paths.hostFile);
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.apply.state, ["registry-missing", "disabled"].includes(scenario) ? "blocked-disabled" : "blocked-identity");
    assert.equal(f.calls.length, 0); assert.equal(row.localHead, null); await absent(f.store);
  }
});

test("path spelling is normalized, but a changed Git marker/common-directory binding is rejected", options, async t => {
  const f = await fixture(t); await f.save();
  await saveInventory(f.paths, { ...f.inventory, repositories: [{ ...f.record, path: `${f.repository}/../existing-checkout/` }] });
  const receive = f.adapter.receive;
  f.adapter.receive = async input => {
    const result = await receive(input);
    await rename(join(f.repository, ".git"), join(f.repository, ".git-moved"));
    await writeFile(join(f.repository, ".git"), "gitdir: .git-moved\n");
    return result;
  };
  const row = (await f.run())!.repositories[0]!;
  assert.equal(row.transfer.state, "received"); assert.equal(row.apply.state, "blocked-identity");
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
});

test("config deletion, identical replacement, branch change and apply revoke during receive prevent any apply", options, async t => {
  for (const scenario of ["delete", "replace", "branch", "revoke"] as const) {
    const f = await fixture(t); await f.save();
    const receive = f.adapter.receive;
    f.adapter.receive = async input => {
      const result = await receive(input);
      // Acquisition here proves network does NOT hold the global mutation lock.
      if (scenario === "revoke") await configureUpstreamSync(f.paths, remote, "main", false);
      else await withStateMutationLock(f.paths, async () => {
        if (scenario === "delete") await rm(f.file);
        else { if (scenario === "branch") f.config.repositories[0]!.branch = "changed"; await f.save(); }
      });
      return result;
    };
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.transfer.state, "received"); assert.equal(row.received?.oid, f.tip);
    assert.equal(row.apply.state, "blocked-settings-changed");
    assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first); await absent(f.intentPath);
    if (scenario === "delete") assert.equal(await upstreamSyncStatus(f.paths), null);
  }
});

test("registry, inventory, checkout inode and remote identity changes during receive are fenced", options, async t => {
  for (const scenario of ["disable", "entry", "path", "inode", "remote"] as const) {
    const f = await fixture(t); await f.save();
    const receive = f.adapter.receive;
    f.adapter.receive = async input => {
      const result = await receive(input);
      await withStateMutationLock(f.paths, async () => {
        if (scenario === "disable") await saveRegistry(f.paths, setRepositoryMode(f.registry, remote, "ignored"));
        if (scenario === "entry") await saveRegistry(f.paths, { ...f.registry, repositories: {
          ...f.registry.repositories, [remote]: { ...f.registry.repositories[remote]!, updatedAt: "2020-01-01T00:00:00.000Z" } } });
        if (scenario === "path") await saveInventory(f.paths, { ...f.inventory, repositories: [{ ...f.record, path: f.source }] });
        if (scenario === "inode") {
          await rename(f.repository, `${f.repository}-old`);
          await tempGit(f.root, "clone", "--quiet", "--no-hardlinks", "--template=", `${f.repository}-old`, f.repository);
          await tempGit(f.repository, "remote", "set-url", "origin", `https://${remote}.git`);
        }
        if (scenario === "remote") await tempGit(f.repository, "remote", "set-url", "origin", "https://github.com/example/changed.git");
      });
      return result;
    };
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.transfer.state, "received"); assert.equal(row.apply.state, scenario === "disable" ? "blocked-disabled" : "blocked-identity");
    assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first); await absent(f.intentPath);
  }
});

test("offline/missing branch failure retains receipt/ref evidence and sanitizes error text without cached apply", options, async t => {
  const f = await fixture(t); f.config.repositories[0]!.applyCleanFastForward = false; await f.save();
  const received = (await f.run())!.repositories[0]!.received!;
  f.config.repositories[0]!.applyCleanFastForward = true; await f.save();
  const receive = f.adapter.receive;
  f.adapter.receive = async () => { throw new Error("HTTPS auth failure: secret-token=https://user:password@example.invalid/secret\n/private/path"); };
  let row = (await f.run())!.repositories[0]!;
  assert.equal(row.transfer.state, "error"); assert.equal(row.apply.state, "blocked-transfer");
  assert.deepEqual(row.received, received);
  assert.doesNotMatch(await readFile(f.statusFile, "utf8"), /secret-token|password|private\/path/);
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
  f.adapter.receive = receive;
  await tempGit(f.source, "branch", "-m", "main", "removed-main");
  row = (await f.run())!.repositories[0]!;
  assert.equal(row.transfer.state, "error"); assert.deepEqual(row.received, received);
  assert.equal(await tempGit(f.store, "rev-parse", received.receivedRef), f.tip);
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
});

test("unresolved durable intent blocks even receive and is never rewritten or replayed", options, async t => {
  const f = await fixture(t); await f.save();
  await mkdir(f.appRoot, { mode: 0o700 }); await writeFile(f.intentPath, "interrupted exact intent bytes\n", { mode: 0o600 });
  for (let n = 0; n < 2; n++) {
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.apply.state, "needs-recovery"); assert.equal(row.transfer.state, "blocked");
    assert.equal(f.calls.length, 0); assert.equal(await readFile(f.intentPath, "utf8"), "interrupted exact intent bytes\n");
  }
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
});

test("unsafe store roots are not adopted or repaired", options, async t => {
  for (const scenario of ["mode", "symlink", "existing-repo"] as const) {
    const f = await fixture(t); await f.save();
    if (scenario === "mode") { await mkdir(f.appRoot, { mode: 0o700 }); await chmod(f.appRoot, 0o755); }
    if (scenario === "symlink") await symlink(f.source, f.appRoot);
    if (scenario === "existing-repo") {
      await mkdir(f.appRoot, { mode: 0o700 }); await mkdir(f.store, { mode: 0o700 });
      await tempGit(f.store, "init", "--bare", "--quiet", "--template=");
    }
    const before = await snapshot(f.repository);
    assert.equal((await f.run())!.repositories[0]!.transfer.state, "error");
    assert.deepEqual(await snapshot(f.repository), before);
    if (scenario === "mode") assert.equal((await lstat(f.appRoot)).mode & 0o777, 0o755);
  }
});

test("direct peer enabled collision rejects registration and fences both initial and final run authority", options, async t => {
  const f = await fixture(t);
  // Offline exclusion authority ONLY: no peer path is inspected or opened.
  const peerRemote = remote;
  const direct = { schemaVersion: 1, hostId: f.host.id, peerHostId: "absent-peer", applyCleanFastForward: false, intervalSeconds: 60,
    repositories: [{ canonicalRemote: peerRemote, branch: "main", enabled: true, peerPath: join(f.root, "absent-peer-checkout") }] };
  await writeJsonAtomic(join(f.paths.stateDirectory, "direct-sync.json"), direct);
  await assert.rejects(configureUpstreamSync(f.paths, peerRemote, "main", true), /direct peer sync/); await absent(f.file);
  f.config.repositories[0]!.canonicalRemote = peerRemote; await f.save();
  assert.equal((await f.run())!.repositories[0]!.apply.state, "blocked-settings-changed"); assert.equal(f.calls.length, 0);
  direct.repositories[0]!.enabled = false; await writeJsonAtomic(join(f.paths.stateDirectory, "direct-sync.json"), direct);
  await configureUpstreamSync(f.paths, peerRemote, "main", true);
  f.adapter.receive = async input => {
    const { githubHttps: _unused, ...local } = input;
    assert.equal(input.githubHttps, true); assert.equal(input.sshCommand, undefined);
    assert.equal(input.source, "https://github.com/example/upstream-project.git");
    const result = await receiveCommittedBranch({ ...local, source: f.source, timeoutMs: 10_000 });
    await withStateMutationLock(f.paths, async () => {
      direct.repositories[0]!.enabled = true; await writeJsonAtomic(join(f.paths.stateDirectory, "direct-sync.json"), direct);
    });
    return result;
  };
  const row = (await f.run())!.repositories[0]!;
  assert.equal(row.transfer.state, "received"); assert.equal(row.apply.state, "blocked-settings-changed");
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
});

test("registration and final real apply share peer's normal mutation lock, with fail-closed contention", options, async t => {
  const f = await fixture(t); await f.save();
  await withStateMutationLock(f.paths, async () => {
    await assert.rejects(configureUpstreamSync(f.paths, remote, "main", false), /State mutation lock already exists/);
    await assert.rejects(f.run(), /State mutation lock already exists/);
  });
  const receive = f.adapter.receive;
  f.adapter.receive = async input => {
    await withStateMutationLock(f.paths, async () => undefined);
    return receive(input);
  };
  let observed = false;
  let verify: Promise<void> = Promise.resolve();
  // Bounded in-process test observation, not an external polling/wait command.
  // 'applying' is persisted inside the critical section before real Git apply.
  const watcher = watch(f.paths.stateDirectory, (_event, name) => {
    if (name?.toString() !== "upstream-sync-status.json" || observed) return;
    verify = verify.then(async () => {
      if (observed) return;
      const value = JSON.parse(await readFile(f.statusFile, "utf8"));
      if (value.repositories[0]?.apply.state !== "applying") return;
      observed = true;
      assert.equal(value.repositories[0].received.oid, f.tip, "receive receipt is durable before apply");
      await assert.rejects(configureUpstreamSync(f.paths, remote, "main", false), /State mutation lock already exists/);
      await assert.rejects(withStateMutationLock(f.paths, async () => undefined), /State mutation lock already exists/);
    });
    void verify.catch(() => undefined); // surfaced by the await below
  });
  t.after(() => watcher.close());
  const row = (await f.run())!.repositories[0]!;
  watcher.close(); await verify;
  assert.equal(row.apply.state, "fast-forwarded"); assert.equal(observed, true);
  await withStateMutationLock(f.paths, async () => undefined);
});

test("concurrent registrations cannot interleave or lose an update silently", options, async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    configureUpstreamSync(f.paths, remote, "main", true), configureUpstreamSync(f.paths, remote, "other", true),
  ]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const success = outcomes.find(r => r.status === "fulfilled")!;
  assert.equal(success.status, "fulfilled");
  if (success.status === "fulfilled") assert.deepEqual(await loadUpstreamSyncConfig(f.paths), success.value);
  const failure = outcomes.find(r => r.status === "rejected")!;
  if (failure.status === "rejected") assert.match(String(failure.reason), /State mutation lock already exists/);
  assert.equal((await loadRegistry(f.paths)).repositories[remote]?.mode, "enabled");
});

test("overlapping passes exclude each other; revoke and abort during transfer prevent apply and release locks", options, async t => {
  const f = await fixture(t); await f.save();
  const controller = new AbortController();
  let started!: () => void, release!: () => void;
  const receiving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const receive = f.adapter.receive;
  f.adapter.receive = async input => {
    assert.equal(input.signal, controller.signal);
    const result = await receive(input); started(); await gate; return result;
  };
  const running = f.run(controller.signal);
  try {
    await receiving;
    await assert.rejects(f.run(), /Upstream sync lock already exists/);
    await configureUpstreamSync(f.paths, remote, "main", false);
    controller.abort();
  } finally { release(); }
  const row = (await running)!.repositories[0]!;
  assert.equal(row.transfer.state, "received"); assert.equal(row.received?.oid, f.tip); assert.equal(row.apply.state, "blocked-cancelled");
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
  await absent(f.intentPath);
  await withStateMutationLock(f.paths, async () => undefined);
  const count = f.calls.length;
  assert.equal((await f.run(controller.signal))!.repositories[0]!.apply.state, "blocked-cancelled");
  assert.equal(f.calls.length, count);
});

test("already-aborted pass performs no transport, and failures never expose unsupported checkout config keys", options, async t => {
  const f = await fixture(t); await f.save();
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.run(controller.signal))!.repositories[0]!.apply.state, "blocked-cancelled");
  assert.equal(f.calls.length, 0);
  await tempGit(f.repository, "config", "filter.secret-token.clean", "this command must never run");
  const row = (await f.run())!.repositories[0]!;
  assert.equal(row.apply.state, "needs-recovery"); assert.equal(row.transfer.state, "received");
  assert.doesNotMatch(await readFile(f.statusFile, "utf8"), /secret-token|this command/);
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
});

test("abort after durable intent creation retains recovery evidence and stops later repositories", options, async t => {
  const f = await fixture(t); await f.save();
  f.config.repositories.push({ canonicalRemote: "github.com/example/later", branch: "main", enabled: false, applyCleanFastForward: false });
  await f.save();
  const controller = new AbortController(), receive = f.adapter.receive;
  let intentObserved = false;
  f.adapter.receive = async input => {
    const result = await receive(input);
    const observer = watch(f.appRoot, (_event, name) => {
      if (!name?.toString().startsWith("apply-")) return;
      intentObserved = true; controller.abort(); observer.close();
    });
    t.after(() => observer.close());
    return result;
  };
  const status = (await f.run(controller.signal))!;
  assert.equal(intentObserved, true);
  assert.equal(status.repositories[0]!.transfer.state, "received");
  assert.equal(status.repositories[0]!.apply.state, "needs-recovery");
  assert.equal(status.repositories[1]!.apply.state, "blocked-cancelled");
  assert.equal(f.calls.length, 1);
  const intent = await readFile(f.intentPath, "utf8");
  assert.equal(JSON.parse(intent).target, f.tip);
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
  assert.deepEqual(await upstreamSyncStatus(f.paths), status);
  assert.equal((await f.run())!.repositories[0]!.apply.state, "needs-recovery");
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(f.intentPath, "utf8"), intent);
  await withStateMutationLock(f.paths, async () => undefined);
});

test("blocked rows do not prevent later repositories; HTTPS credentials never become the source", options, async t => {
  const f = await fixture(t);
  await tempGit(f.repository, "remote", "set-url", "origin", "https://fixture-user:fixture-secret@github.com/Example/Upstream-Project.git");
  f.config.repositories.unshift({ canonicalRemote: "github.com/example/disabled-first", branch: "main", enabled: false, applyCleanFastForward: false });
  await f.save();
  const before = await tempGit(f.repository, "config", "--get", "remote.origin.url");
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.apply.state, "blocked-disabled");
  assert.equal(status.repositories[1]!.apply.state, "fast-forwarded");
  assert.equal(f.calls.length, 1);
  assert.equal(await tempGit(f.repository, "config", "--get", "remote.origin.url"), before);
  assert.doesNotMatch(await readFile(f.statusFile, "utf8"), /fixture-user|fixture-secret/);
});

// Verified notification evidence contract: dirty/same-HEAD still reports HEAD
// without touching the index/worktree. New passes never inherit cached HEAD;
// an unvalidated/missing checkout stays null, and legacy rows remain readable.
test("dirty same-HEAD passes expose stable localHead read-only; failed identity never inherits cached HEAD", options, async t => {
  const f = await fixture(t); await f.save();
  assert.equal((await f.run())!.repositories[0]!.localHead, f.tip);
  await writeFile(join(f.repository, "tracked.txt"), "dirty local work at the received HEAD\n");
  const before = await snapshot(f.repository);
  for (let pass = 0; pass < 2; pass++) {
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.apply.state, "blocked-dirty");
    assert.equal(row.localHead, f.tip);
    assert.equal(row.localHead, row.received?.oid);
    assert.equal((await upstreamSyncStatus(f.paths))!.repositories[0]!.localHead, f.tip);
    assert.deepEqual(await snapshot(f.repository), before);
  }
  await tempGit(f.repository, "remote", "set-url", "origin", "https://github.com/example/changed.git");
  const blocked = (await f.run())!.repositories[0]!;
  assert.equal(blocked.apply.state, "blocked-identity");
  assert.equal(blocked.localHead, null);
  assert.equal(blocked.received?.oid, f.tip, "receipt retention does not imply local HEAD retention");
});

test("localHead refresh follows user commits during transfer without treating HEAD as checkout identity", options, async t => {
  const f = await fixture(t); await f.save();
  let localTip: string | null = null;
  const receive = f.adapter.receive;
  f.adapter.receive = async input => {
    const result = await receive(input);
    localTip = await commit(f.repository, "user commit during receive\n");
    return result;
  };
  const row = (await f.run())!.repositories[0]!;
  assert.equal(row.apply.state, "blocked-diverged");
  assert.equal(row.localHead, localTip);
  assert.notEqual(row.localHead, f.first);
  assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), localTip);
  assert.deepEqual((await upstreamSyncStatus(f.paths))!.repositories[0], row);
});

test("unborn local HEAD remains null and legacy status rows without localHead remain readable", options, async t => {
  const f = await fixture(t); f.config.repositories[0]!.applyCleanFastForward = false; await f.save();
  await tempGit(f.repository, "checkout", "--orphan", "unborn");
  const before = await snapshot(f.repository);
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.localHead, null);
  assert.equal(status.repositories[0]!.apply.state, "not-requested");
  assert.deepEqual(await snapshot(f.repository), before);
  delete status.repositories[0]!.localHead;
  await writeJsonAtomic(f.statusFile, status);
  assert.deepEqual(await upstreamSyncStatus(f.paths), status);
  assert.equal((await f.run())!.repositories[0]!.localHead, null);
});

test("upstream cannot bypass direct intent after config removal, including intent created during receive", options, async t => {
  for (const duringReceive of [false, true]) {
    const f = await fixture(t); await f.save();
    const intent = join(f.paths.stateDirectory, `direct-sync-apply-${"d".repeat(64)}.json`);
    const bytes = "opaque retained direct apply intent\n";
    const create = () => withStateMutationLock(f.paths, () => writeFile(intent, bytes, { mode: 0o600 }));
    if (!duringReceive) await create();
    else {
      const receive = f.adapter.receive;
      f.adapter.receive = async input => { const result = await receive(input); await create(); return result; };
    }
    const before = await snapshot(f.repository);
    const result = (await f.run())!.repositories[0]!;
    assert.equal(result.apply.state, "needs-recovery");
    assert.equal(f.calls.length, duringReceive ? 1 : 0);
    assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
    assert.deepEqual(await snapshot(f.repository), before);
    assert.equal(await readFile(intent, "utf8"), bytes);
    await absent(join(f.paths.stateDirectory, "direct-sync.json"));
  }
});


test("post-receive workflow permission or helper changes revoke apply and preserve exact receipt", options, async t => {
  for (const mutation of ["permissions", "helper", "primary"] as const) {
    const f = await fixture(t); await f.save();
    const file = join(dirname(f.paths.configFile), "workflow.json");
    const workflow = { schemaVersion: 1, primaryHostId: f.host.id, peers: {},
      executables: { githubCli: "/usr/bin/gh", python: "/usr/bin/python3" } };
    await writeJsonAtomic(file, workflow);
    const original = f.adapter.receive;
    f.adapter.receive = async input => {
      const received = await original(input);
      if (mutation === "permissions") await chmod(file, 0o666);
      else await writeJsonAtomic(file, mutation === "helper" ? { ...workflow, executables: { ...workflow.executables, githubCli: "/different/gh" } }
        : { ...workflow, primaryHostId: "different-primary" });
      return received;
    };
    const before = await snapshot(f.repository);
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.transfer.state, "received");
    assert.equal(row.received?.oid, f.tip);
    assert.equal(row.apply.state, "blocked-settings-changed");
    assert.equal(await tempGit(f.repository, "rev-parse", "HEAD"), f.first);
    assert.deepEqual(await snapshot(f.repository), before);
    await absent(f.intentPath);
  }
});
