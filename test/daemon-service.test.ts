import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConfig, resolveAppPaths, saveConfig } from "../src/config.js";
import { daemonStatus, loadDaemonRuntimeIfPresent, runDaemonService, wakeDaemon } from "../src/daemon.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, saveRegistry } from "../src/registry.js";
import { writeJsonAtomic } from "../src/storage.js";
import type { DaemonRuntimeState } from "../src/types.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sync-daemon-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  const checkoutRoot = join(root, "checkouts"); await mkdir(checkoutRoot);
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  await saveConfig(paths, createConfig([checkoutRoot], []));
  await saveRegistry(paths, createEmptyRegistry());
  await saveInventory(paths, { schemaVersion: 1, hostId: "host-a", generatedAt: new Date().toISOString(),
    roots: [checkoutRoot], repositories: [] });
  const workflowFile = join(dirname(paths.configFile), "workflow.json");
  // Missing fixture-owned known_hosts fails before SSH is spawned: no network,
  // local direct enrollment, local upstream selection or peer checkout is used.
  const workflow = (primaryHostId = "host-a", withPeer = true) => ({ schemaVersion: 1, primaryHostId,
    peers: withPeer ? { "host-b": { host: "peer.example.invalid", user: "fixture", knownHosts: join(root, "missing-known-hosts"),
      fingerprint: `SHA256:${"A".repeat(43)}`, nodeExecutable: "/fixture/node", cliEntrypoint: "/fixture/cli.js" } } : {} });
  const controller = new AbortController();
  let service: Promise<DaemonRuntimeState> | undefined;
  t.after(async () => { controller.abort(); await service; });
  const start = () => service = runDaemonService(paths, { signal: controller.signal, installSignalHandlers: true,
    debounceMs: 10, heartbeatMs: 60_000, safetyIntervalMs: 600_000 });
  // Bounded event-driven test observation. Never leave a resident test daemon
  // or a polling process behind when assertions fail.
  const until = (predicate: (s: DaemonRuntimeState) => boolean | Promise<boolean>): Promise<DaemonRuntimeState> => new Promise((accept, reject) => {
    let finished = false;
    let latest: DaemonRuntimeState | null = null;
    const close = () => { finished = true; watcher.close(); clearTimeout(timer); };
    const check = async () => {
      try {
        const s = await loadDaemonRuntimeIfPresent(paths);
        latest = s;
        if (!finished && s && await predicate(s) && !finished) { close(); accept(s); }
      } catch (error) { if (!finished) { close(); reject(error); } }
    };
    const watcher = watch(paths.stateDirectory, () => { void check(); });
    // Allow the production five-second metadata backstop plus one local pass.
    const timer = setTimeout(() => { close(); reject(new Error(`Daemon fixture did not reach ${predicate.toString()}: ${JSON.stringify(latest)}`)); }, 8_000);
    void check();
  });
  return { paths, workflowFile, workflow, start, until, controller };
}

test("primary-only Guardian monitoring runs and polls with no local sync configuration", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await writeJsonAtomic(f.workflowFile, f.workflow());
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const service = f.start();
  const first = await f.until(s => s.completedPasses >= 1);
  assert.equal(first.mode, "guardian-monitor");
  assert.equal(first.lastError, null);
  assert.equal((await daemonStatus(f.paths)).service.runtime?.mode, "guardian-monitor");
  const attention = join(f.paths.stateDirectory, "upstream-sync-attention.json");
  assert.deepEqual(JSON.parse(await readFile(attention, "utf8")), {});
  const before = await stat(attention);
  t.mock.timers.tick(35_000);
  const second = await f.until(s => s.completedPasses > first.completedPasses && s.lastTrigger === "sync-poll");
  const after = await stat(attention);
  assert.ok(after.ino !== before.ino || after.mtimeMs !== before.mtimeMs, "existing attention recorder ran again on timer");
  assert.equal(second.lastError, null);
  f.controller.abort();
  assert.equal((await service).lifecycle, "stopped");
  assert.equal((await daemonStatus(f.paths)).service.lockPresent, false);
});

test("workflow creation is watched; explicit reload handles subsequent edits without relying on filesystem timing", { timeout: 15_000 }, async t => {
  const f = await fixture(t), service = f.start();
  // Watch the first creation normally. Repeated atomic replacements may be
  // coalesced by macOS, so exercise the supported reload signal for subsequent
  // edits rather than pretending a sleep makes fs.watch delivery deterministic.
  // The separate timer test still exercises periodic safety monitoring.
  const editWorkflow = async (value: unknown, reload = true) => {
    await writeJsonAtomic(f.workflowFile, value);
    if (reload) process.emit("SIGHUP");
  };
  const initial = await f.until(s => s.completedPasses >= 1);
  assert.equal(initial.mode, "local-only");
  await editWorkflow(f.workflow(), false);
  const monitor = await f.until(s => s.completedPasses > initial.completedPasses && s.mode === "guardian-monitor");
  assert.equal(monitor.lastError, null);
  const attention = join(f.paths.stateDirectory, "upstream-sync-attention.json");
  const first = await stat(attention);
  // Config changes invalidate the old attention deadline, without a daemon restart.
  await editWorkflow(f.workflow());
  await f.until(s => s.completedPasses > monitor.completedPasses);
  const refreshed = await stat(attention);
  assert.ok(refreshed.ino !== first.ino || refreshed.mtimeMs !== first.mtimeMs);
  await editWorkflow(f.workflow("host-b"));
  const secondary = await f.until(s => s.mode === "local-only" && s.completedPasses > monitor.completedPasses);
  await editWorkflow(f.workflow("host-a", false));
  const paused = await f.until(s => s.mode === "local-only" && s.completedPasses > secondary.completedPasses);
  const stoppedMonitoring = await stat(attention);
  assert.equal(stoppedMonitoring.ino, refreshed.ino);
  const request = await wakeDaemon(f.paths);
  // Filesystem hints and explicit reloads can coalesce; lastTrigger is a
  // diagnostic, not an acknowledgement of a particular queued request.
  const woke = await f.until(s => s.lastPassStartedAt !== null && Date.parse(s.lastPassStartedAt) >= Date.parse(request.requestedAt) &&
    s.lastPassCompletedAt !== null && s.completedPasses > paused.completedPasses);
  assert.equal(woke.mode, "local-only");
  f.controller.abort(); await service;
});


test("explicit wake queued behind a running pass survives a later coalesced reload", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await writeJsonAtomic(join(f.paths.stateDirectory, "upstream-sync.json"), {
    schemaVersion: 1, hostId: "host-a", intervalSeconds: 900,
    repositories: [{ canonicalRemote: "github.com/example/disabled", branch: "main", enabled: false, applyCleanFastForward: true }],
  });
  const service = f.start();
  await f.until(s => s.completedPasses >= 1);
  const statusPath = join(f.paths.stateDirectory, "upstream-sync-status.json");
  const before = JSON.parse(await readFile(statusPath, "utf8"));
  process.emit("SIGHUP"); // starts an observer pass; not a forced sync
  process.emit("SIGUSR1"); // queues a forced sync behind it
  process.emit("SIGHUP"); // replaces the trigger label, not the queued authority
  await f.until(async () => {
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    return current.startedAt !== before.startedAt && current.completedAt !== null;
  }); // one or more passes may coalesce; assert the forced transport, not their count
  const after = JSON.parse(await readFile(statusPath, "utf8"));
  assert.notEqual(after.startedAt, before.startedAt);
  assert.ok(after.completedAt);
  assert.equal(after.repositories[0].apply.state, "blocked-disabled");
  f.controller.abort(); await service;
});
