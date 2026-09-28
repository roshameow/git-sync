import assert from "node:assert/strict";
import type { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadWorkflowConfig } from "../src/workflow-config.js";
import { resolveAppPaths } from "../src/config.js";
import type { DirectSyncRepositoryStatus } from "../src/direct-sync-service.js";
import { createHostIdentity, loadHostIdentity, saveHostIdentity } from "../src/host.js";
import { acknowledgeIncident, listIncidents } from "../src/incidents.js";
import { workflowFixture, saveWorkflowFixture, quotedPeerCommand } from "./guardian-workflow-fixture.js";
import { pathExists, writeJsonAtomic } from "../src/storage.js";
import { __upstreamAttentionForTests as adapter, recordUpstreamSyncAttention } from "../src/upstream-sync-attention.js";
import type { UpstreamSyncConfig, UpstreamSyncStatus } from "../src/upstream-sync-service.js";

const primaryId = "host-a", peerId = "host-b";
const remote = "github.com/example/peer-only-project", oid = "a".repeat(40), head = "b".repeat(40);
const epoch = Date.UTC(2026, 9, 1);
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const config = (hostId = peerId): UpstreamSyncConfig => ({ schemaVersion: 1, hostId, intervalSeconds: 30,
  repositories: [{ canonicalRemote: remote, branch: "main", enabled: true, applyCleanFastForward: true }] });
function pass(n: number, apply: DirectSyncRepositoryStatus["apply"]["state"] = "blocked-dirty", hostId = peerId): UpstreamSyncStatus {
  return { mode: "upstream", hostId, startedAt: at(n), completedAt: at(n), repositories: [{
    canonicalRemote: remote, branch: "main", state: apply === "error" ? "error" : "blocked",
    transfer: { state: "received" }, apply: { state: apply }, received: {
      branch: "main", oid, receivedRef: "refs/upstream/fixture", changed: true, completedAt: at(n), worktreeUpdated: false,
    },
  }] };
}
type Deps = Parameters<typeof adapter.record>[2];
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "upstream-attention-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  await saveHostIdentity(paths, createHostIdentity(primaryId));
  const primary = { primaryHostId: primaryId, configuredHostId: primaryId, requiredHostIds: [primaryId, peerId] };
  let response: unknown = { config: config(), status: null };
  const calls: { file: string; args: string[]; options: Parameters<Deps["run"]>[2] }[] = [];
  const deps: Deps = { workflow: async () => workflowFixture(primaryId, peerId), identity: loadHostIdentity, primary: async () => primary,
    config: async () => null, status: async () => { throw new Error("Explicit local status must not read disk"); },
    peer: async (p, id) => { assert.equal(p, paths); assert.equal(id, peerId); return { executable: "/usr/bin/ssh", args: ["-T", "fixture@peer.example.invalid"] }; },
    run: async (file, args, options) => { calls.push({ file, args, options }); return JSON.stringify(response); },
    now: () => epoch + 100_000 };
  const run = (status: UpstreamSyncStatus | null = null) => adapter.record(paths, status, deps);
  return { paths, root, deps, calls, primary, run, response: (v: unknown) => { response = v; },
    peerPass: (n: number, apply: DirectSyncRepositoryStatus["apply"]["state"] = "blocked-dirty") => {
      response = { config: config(), status: pass(n, apply) };
    }, state: join(paths.stateDirectory, "upstream-sync-attention.json") };
}

// Reusable offline method: replace every identity/config/transport boundary,
// but exercise real owner-private state and the existing incident journal.
test("Peer-only generic selection creates one primary incident without primary inventory/registry/checkout", async t => {
  const f = await fixture(t);
  f.peerPass(1, "blocked-diverged");
  assert.deepEqual(await f.run(), { created: 1 });
  assert.equal(await pathExists(f.paths.registryFile), false);
  const original = (await listIncidents(f.paths))[0]!.incident;
  assert.equal(original.hostId, primaryId);
  assert.equal(original.incidentType, "sync.attention");
  assert.match(original.summary, /peerGithub host=host-b/);
  assert.ok(original.summary.includes(remote));
  assert.match(original.summary, /branch=main reason=blocked-diverged HEAD=unknown/);
  assert.ok(original.summary.includes(oid));
  assert.match(original.summary, /Run sync upstream status on host-b/);
  assert.equal((await stat(f.state)).mode & 0o777, 0o600);
  assert.deepEqual(await f.run(), { created: 0 });
  await acknowledgeIncident(f.paths, original.incidentId);
  f.peerPass(2, "blocked-diverged");
  assert.deepEqual(await f.run(), { created: 0 });
  assert.equal((await listIncidents(f.paths)).length, 0);
  assert.deepEqual((await listIncidents(f.paths, true))[0]!.incident, original);
  f.peerPass(3, "needs-recovery");
  assert.deepEqual(await f.run(), { created: 1 });
});

test("peer query is exactly installed CLI over verified transport, with bounded deadline/output and clean environment", async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.file, "/usr/bin/ssh");
  assert.deepEqual(call.args, ["-T", "fixture@peer.example.invalid", quotedPeerCommand(["sync", "upstream", "status"])]);
  assert.equal(call.options.cwd, "/");
  assert.equal(call.options.timeout, 25_000);
  assert.equal(call.options.maxBuffer, 256 * 1024);
  assert.equal(call.options.killSignal, "SIGKILL");
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(call.options.env.GIT_SYNC_HOME, undefined);
  assert.equal(call.options.env.PATH, "/usr/bin:/bin");
});

test("secondary/missing or mismatched primary identity exits before config, transport or state", async t => {
  const f = await fixture(t);
  f.deps.config = async () => { throw new Error("must not inspect"); };
  f.deps.workflow = async () => { throw new Error("must not connect"); };
  await saveHostIdentity(f.paths, createHostIdentity(peerId));
  assert.deepEqual(await f.run(pass(1, "needs-recovery")), { created: 0 });
  await saveHostIdentity(f.paths, createHostIdentity(primaryId));
  f.deps.primary = async () => ({ ...f.primary, configuredHostId: peerId });
  assert.deepEqual(await f.run(), { created: 0 });
  f.deps.primary = async () => null;
  assert.deepEqual(await f.run(), { created: 0 });
  assert.equal(await pathExists(f.state), false);
  assert.equal(f.calls.length, 0);
});

for (const apply of ["blocked-dirty", "error", "blocked-branch", "blocked-identity", "blocked-transfer"] as const) {
  test(`${apply}: three distinct completed passes; replay, restart, body/OID churn and acknowledgement stay deduplicated`, async t => {
    const f = await fixture(t);
    const observe = (n: number) => {
      const s = pass(n, apply);
      s.repositories[0]!.apply.error = `secret-${n}`;
      Object.assign(s.repositories[0]!.received!, { oid: n % 2 ? oid : head });
      f.response({ config: config(), status: s });
    };
    observe(1); assert.equal((await f.run()).created, 0);
    const firstState = await readFile(f.state, "utf8");
    assert.equal((await f.run()).created, 0);
    assert.equal(await readFile(f.state, "utf8"), firstState);
    const incomplete = { ...pass(2, apply), completedAt: null };
    f.response({ config: config(), status: incomplete });
    assert.equal((await f.run()).created, 0);
    observe(2); assert.equal((await f.run()).created, 0);
    observe(1); assert.equal((await f.run()).created, 0);
    observe(3); assert.equal((await f.run()).created, 1);
    const original = (await listIncidents(f.paths))[0]!.incident;
    assert.doesNotMatch(original.summary, /secret/);
    assert.match(original.summary, /dirty alone is not a merge-conflict claim/);
    await acknowledgeIncident(f.paths, original.incidentId);
    // New dependency object = no in-memory dedupe carried across invocation.
    observe(4); assert.equal((await adapter.record(f.paths, null, { ...f.deps })).created, 0);
    assert.deepEqual((await listIncidents(f.paths, true))[0]!.incident, original);
    f.peerPass(5, "up-to-date"); await f.run();
    for (let n = 6; n <= 8; n++) { observe(n); await f.run(); }
    assert.equal((await listIncidents(f.paths, true)).length, 2);
  });
}

test("rewritten completion, changed same-pass reason, overlapping or older passes never increment", async t => {
  const f = await fixture(t);
  f.peerPass(1); await f.run();
  f.response({ config: config(), status: { ...pass(1), completedAt: at(2) } }); await f.run();
  f.peerPass(1, "needs-recovery"); assert.equal((await f.run()).created, 0);
  f.response({ config: config(), status: { ...pass(2), completedAt: at(4) } }); await f.run();
  f.response({ config: config(), status: { ...pass(3), completedAt: at(5) } }); await f.run();
  assert.equal((await listIncidents(f.paths)).length, 0);
  f.peerPass(5); assert.equal((await f.run()).created, 1);
});

test("local and peer counters are independent even for the same GitHub branch", async t => {
  const f = await fixture(t);
  f.deps.config = async () => config(primaryId);
  f.peerPass(1); await f.run(pass(1, "blocked-dirty", primaryId));
  f.peerPass(2); await f.run(pass(1, "blocked-dirty", primaryId));
  f.peerPass(3); assert.equal((await f.run(pass(2, "blocked-dirty", primaryId))).created, 1);
  assert.equal((await f.run(pass(3, "blocked-dirty", primaryId))).created, 1);
  const incidents = await listIncidents(f.paths);
  assert.equal(incidents.length, 2);
  assert.ok(incidents.some(i => i.incident.summary.includes("localupstream host=host-a")));
  assert.ok(incidents.some(i => i.incident.summary.includes("peerGithub host=host-b")));
  assert.equal(Object.keys(JSON.parse(await readFile(f.state, "utf8"))).length, 2);
});

test("success, pull-only local-ahead and fresh known equal-tip dirty are quiet; unknown HEAD remains actionable", async t => {
  const f = await fixture(t);
  let nextPass = 1;
  for (const state of ["up-to-date", "fast-forwarded", "local-ahead", "not-requested"] as const) {
    for (let i = 0; i < 4; i++) {
      const s = pass(nextPass++, state);
      s.repositories[0]!.state = state === "not-requested" ? "received-not-applied" : "applied";
      const c = config(); c.repositories[0]!.applyCleanFastForward = false;
      f.response({ config: c, status: s }); assert.equal((await f.run()).created, 0);
    }
  }
  for (let n = 17; n <= 20; n++) {
    const s = pass(n);
    Object.assign(s.repositories[0]!, { localHead: oid });
    f.response({ config: config(), status: s });
    assert.equal((await f.run()).created, 0);
  }
  for (let n = 21; n <= 23; n++) { f.peerPass(n); await f.run(); }
  assert.equal((await listIncidents(f.paths)).length, 1);
  assert.match((await listIncidents(f.paths))[0]!.incident.summary, /HEAD=unknown/);
  for (let n = 24; n <= 26; n++) {
    const s = pass(n); Object.assign(s.repositories[0]!, { localHead: oid });
    s.repositories[0]!.transfer = { state: "error", error: "secret token" };
    f.response({ config: config(), status: s }); await f.run();
  }
  assert.equal((await listIncidents(f.paths)).length, 2);
  assert.equal((await listIncidents(f.paths))[1]!.incident.reasonCode, "repeated-error");
});

for (const apply of ["blocked-disabled", "blocked-cancelled"] as const) {
  test(`${apply} stays quiet with enabled config and blocked transfer; clears prior prolonged episode`, async t => {
    const f = await fixture(t);
    for (let n = 1; n <= 2; n++) { f.peerPass(n); await f.run(); }
    for (let n = 3; n <= 7; n++) {
      const s = pass(n, apply);
      s.repositories[0]!.transfer = { state: n === 7 ? "error" : "blocked", error: "old transfer error" };
      const c = config(); assert.equal(c.repositories[0]!.enabled, true);
      f.response({ config: c, status: s });
      assert.equal((await f.run()).created, 0);
    }
    const state = Object.values(JSON.parse(await readFile(f.state, "utf8"))) as { count: number; reason: string }[];
    assert.equal(state[0]!.count, 0); assert.equal(state[0]!.reason, "quiet");
    // Re-enabling/resuming starts a fresh three-pass episode, not pass three of
    // the condition from before the intentional stop.
    for (let n = 8; n <= 10; n++) {
      f.peerPass(n); assert.equal((await f.run()).created, n === 10 ? 1 : 0);
    }
    assert.equal((await listIncidents(f.paths)).length, 1);
  });
}

test("explicit null HEAD and legacy dirty results cannot borrow cached HEAD evidence", async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 3; n++) {
    const s = pass(n, "local-ahead");
    s.repositories[0]!.transfer = { state: "error" };
    s.repositories[0]!.apply.result = { status: "local-ahead", head: oid, oid };
    Object.assign(s.repositories[0]!, { localHead: null });
    f.response({ config: config(), status: s }); await f.run();
  }
  assert.match((await listIncidents(f.paths))[0]!.incident.summary, /HEAD=unknown/);
  for (let n = 4; n <= 6; n++) {
    const s = pass(n);
    // A valid-looking HEAD hidden in a legacy dirty result is not HEAD evidence.
    Object.assign(s.repositories[0]!.apply, { result: { status: "blocked-dirty", head: oid } });
    f.response({ config: config(), status: s }); await f.run();
  }
  const incidents = await listIncidents(f.paths);
  assert.equal(incidents.length, 2);
  assert.match(incidents[1]!.incident.summary, /reason=blocked-dirty HEAD=unknown/);
});

test("only enabled configured remote AND branch qualify; missing local status still monitors peer", async t => {
  const f = await fixture(t);
  const disabled = config(); disabled.repositories[0]!.enabled = false;
  f.response({ config: disabled, status: pass(1, "needs-recovery") }); assert.equal((await f.run()).created, 0);
  const unselected = pass(2, "needs-recovery"); unselected.repositories[0]!.canonicalRemote = "github.com/other/unselected";
  f.response({ config: config(), status: unselected }); assert.equal((await f.run()).created, 0);
  const otherBranch = config(); otherBranch.repositories[0]!.branch = "dev";
  f.response({ config: otherBranch, status: pass(3, "needs-recovery") }); assert.equal((await f.run()).created, 0);
  f.response({ config: null, status: pass(4, "needs-recovery") }); assert.equal((await f.run()).created, 0);
  f.peerPass(5, "needs-recovery"); assert.equal((await f.run()).created, 1);
});

test("branch changes have independent keys; disabled selection clears the old episode", async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 2; n++) { f.peerPass(n); await f.run(); }
  const c = config(), s = pass(3);
  c.repositories[0]!.branch = "dev"; s.repositories[0]!.branch = "dev"; Object.assign(s.repositories[0]!.received!, { branch: "dev" });
  f.response({ config: c, status: s }); assert.equal((await f.run()).created, 0);
  c.repositories[0]!.enabled = false;
  f.response({ config: c, status: { ...s, startedAt: at(4), completedAt: at(4) } }); await f.run();
  assert.deepEqual(JSON.parse(await readFile(f.state, "utf8")), {});
});

test("stale/future/incomplete responses never advance counters; 900-second intervals scale freshness", async t => {
  const f = await fixture(t);
  f.deps.now = () => epoch + 1_000_000;
  for (const n of [1, 2, 3, 1006]) {
    f.peerPass(n); assert.equal((await f.run()).created, 0);
  }
  assert.deepEqual(JSON.parse(await readFile(f.state, "utf8")), {});
  const c = config(); c.intervalSeconds = 900;
  for (let n = 1; n <= 3; n++) { f.response({ config: c, status: pass(n) }); await f.run(); }
  assert.equal((await listIncidents(f.paths)).length, 1);
  // Exactly five seconds ahead is diagnostic clock skew, not a future alarm.
  f.response({ config: config(), status: pass(1005, "needs-recovery") });
  assert.equal((await f.run()).created, 1);
});

test("offline/timeout/invalid peer never blocks local incidents or creates an unavailable alarm", async t => {
  const f = await fixture(t);
  f.deps.config = async () => config(primaryId);
  f.deps.run = async () => { throw new Error("SSH secret diagnostic timeout"); };
  assert.deepEqual(await f.run(pass(1, "needs-recovery", primaryId)), { created: 1, peerUnavailable: true });
  for (let n = 2; n <= 5; n++) assert.deepEqual(await f.run(pass(n, "needs-recovery", primaryId)), { created: 0, peerUnavailable: true });
  assert.equal((await listIncidents(f.paths)).length, 1);
  assert.doesNotMatch(await readFile(f.state, "utf8"), /SSH|secret|timeout/);
  f.deps.workflow = async () => workflowFixture(primaryId, primaryId);
  f.deps.peer = async () => { throw new Error("must not verify wrong host"); };
  assert.deepEqual(await f.run(), { created: 0, peerUnavailable: true });
});

test("strict peer projection rejects malformed/oversized evidence and never forwards arbitrary fields", async t => {
  const f = await fixture(t);
  const good = () => ({ config: config(), status: pass(1, "blocked-diverged") });
  const mutations: ((v: ReturnType<typeof good>) => unknown)[] = [
    v => ({ ...v, status: { ...v.status, hostId: primaryId } }),
    v => ({ ...v, config: { ...v.config, hostId: primaryId } }),
    v => ({ ...v, status: { ...v.status, mode: "direct-peer" } }),
    v => ({ ...v, status: { ...v.status, startedAt: at(2) } }),
    v => ({ ...v, status: { ...v.status, repositories: [v.status.repositories[0], v.status.repositories[0]] } }),
    v => { Object.assign(v.status.repositories[0]!.received!, { oid: "secret\ncommand" }); return v; },
    v => { v.config.repositories[0]!.canonicalRemote = "https://user:password@github.com/owner/repo"; return v; },
    v => { v.config.repositories[0]!.branch = "main;touch /tmp/not-allowed"; return v; },
    v => ({ ...v, config: { ...v.config, repositories: Array(257).fill(v.config.repositories[0]) } }),
    v => { Object.assign(v.status.repositories[0]!, { apply: { state: "arbitrary secret" } }); return v; },
    v => { Object.assign(v.status.repositories[0]!, { localHead: "invalid" }); return v; },
    v => { Object.assign(v.status.repositories[0]!, { localHead: `${oid}\n` }); return v; },
    v => { v.config.repositories[0]!.canonicalRemote += "\n"; return v; },
    v => { v.config.repositories[0]!.branch += "\n"; return v; },
    v => ({ ...v, status: { ...v.status, completedAt: "not a date" } }),
  ];
  for (const mutate of mutations) {
    f.response(mutate(good()));
    assert.deepEqual(await f.run(), { created: 0, peerUnavailable: true });
  }
  const originalRun = f.deps.run;
  for (const text of ["not JSON", " ".repeat(512 * 1024 + 1)]) {
    f.deps.run = async () => text;
    assert.deepEqual(await f.run(), { created: 0, peerUnavailable: true });
  }
  f.deps.run = originalRun;
  const v = good();
  Object.assign(v.config, { secret: "config secret", command: "arbitrary command" });
  Object.assign(v.status.repositories[0]!, { peerHostId: "untrusted-host", localHead: head, path: "/secret/local/checkout" });
  v.status.repositories[0]!.apply.error = "secret error";
  f.response({ ...v, credentials: "extra secret" });
  assert.equal((await f.run()).created, 1);
  const persisted = await readFile(f.state, "utf8");
  assert.doesNotMatch(persisted, /secret|untrusted-host|arbitrary|checkout|credentials/);
  assert.ok((await listIncidents(f.paths))[0]!.incident.summary.includes(`HEAD=${head}`));
});

test("reserved journal payload survives a crash, OID churn and later replay without conflicting with original", async t => {
  const f = await fixture(t);
  f.peerPass(1, "blocked-diverged"); await f.run();
  const original = (await listIncidents(f.paths))[0]!.incident;
  await rm(join(f.paths.incidentDirectory, `${original.incidentId}.json`));
  const s = pass(2, "blocked-diverged"); Object.assign(s.repositories[0]!.received!, { oid: head });
  f.response({ config: config(), status: s });
  assert.equal((await f.run()).created, 1);
  assert.deepEqual((await listIncidents(f.paths))[0]!.incident, original);
  assert.equal((await f.run()).created, 0);
});

test("owner-private state rejects symlinks, hardlinks, public files, oversize and malformed counters", async t => {
  const f = await fixture(t);
  await f.run();
  const target = join(f.root, "target"); await writeFile(target, "{}", { mode: 0o600 });
  await rm(f.state); await symlink(target, f.state); await assert.rejects(f.run()); await rm(f.state);
  await link(target, f.state); await assert.rejects(f.run()); await rm(f.state);
  await writeFile(f.state, "{}", { mode: 0o600 }); await chmod(f.state, 0o644); await assert.rejects(f.run());
  await chmod(f.state, 0o600); await writeFile(f.state, " ".repeat(1024 * 1024 + 1)); await assert.rejects(f.run());
  await writeFile(f.state, JSON.stringify({ arbitrary: { count: 999 } })); await assert.rejects(f.run());
  assert.equal(await readFile(target, "utf8"), "{}");
});

test("production local config/status disk contract and incomplete local pass work without peer transport", async t => {
  const f = await fixture(t);
  await writeJsonAtomic(join(f.paths.stateDirectory, "upstream-sync.json"), config(primaryId));
  await writeJsonAtomic(join(f.paths.stateDirectory, "upstream-sync-status.json"), pass(1, "needs-recovery", primaryId));
  // No workflow config: primary defaults to own host and peers is empty.
  // This prevents any real transport lookup or SSH attempt.
  // Fresh timestamps avoid depending on the fixture's deterministic clock.
  const s = pass(1, "needs-recovery", primaryId); s.startedAt = s.completedAt = new Date().toISOString();
  delete s.repositories[0]!.received;
  await writeJsonAtomic(join(f.paths.stateDirectory, "upstream-sync-status.json"), s);
  assert.deepEqual(await recordUpstreamSyncAttention(f.paths), { created: 1, peerUnavailable: true });
  assert.deepEqual(await recordUpstreamSyncAttention(f.paths, { ...s, completedAt: null }), { created: 0, peerUnavailable: true });
});

test("maximum length valid identities and SHA256 OIDs fit the existing 500-character journal bound", async t => {
  const f = await fixture(t), id = "Host_" + "a".repeat(123), c = config(id), s = pass(1, "needs-recovery", id);
  await saveHostIdentity(f.paths, createHostIdentity(id));
  f.deps.primary = async () => ({ ...f.primary, primaryHostId: id, configuredHostId: id, requiredHostIds: [id, peerId] });
  f.deps.config = async () => c;
  const longRemote = `github.com/${"a".repeat(39)}/${"b".repeat(100)}`, longBranch = "c".repeat(200);
  Object.assign(c.repositories[0]!, { canonicalRemote: longRemote, branch: longBranch });
  Object.assign(s.repositories[0]!, { canonicalRemote: longRemote, branch: longBranch, localHead: "b".repeat(64) });
  Object.assign(s.repositories[0]!.received!, { branch: longBranch, oid: "a".repeat(64) });
  assert.equal((await f.run(s)).created, 1);
  const summary = (await listIncidents(f.paths))[0]!.incident.summary;
  assert.ok(summary.length <= 500);
  assert.ok(summary.includes("..."));
});

test("read-only upstream inspection works on secondary, projects cached evidence, and never writes journals/state", async t => {
  const f = await fixture(t);
  await saveHostIdentity(f.paths, createHostIdentity(peerId));
  f.deps.primary = async () => { throw new Error("Inspection must not load primary role or signed registry"); };
  f.deps.config = async () => config(peerId);
  f.deps.status = async () => pass(1, "blocked-dirty", peerId);
  f.deps.workflow = async () => workflowFixture(primaryId, primaryId);
  f.deps.peer = async () => ({ executable: "/usr/bin/ssh", args: ["fixture@peer.example.invalid"] });
  f.response({ config: config(primaryId), status: pass(2, "blocked-diverged", primaryId), secret: "discard this" });
  const result = await adapter.inspect(f.paths, f.deps);
  assert.equal(result.cached, true); assert.equal(result.cachedOnly, true); assert.equal(result.live, false); assert.equal(result.observedAt, at(100));
  assert.equal(result.local.hostId, peerId); assert.equal(result.peer.hostId, primaryId);
  assert.equal(result.local.available, true); assert.equal(result.peer.available, true);
  assert.equal(result.local.fresh, true); assert.equal(result.peer.fresh, true);
  for (const source of [result.local, result.peer]) {
    assert.equal(source.cached, true); assert.equal(source.cachedOnly, true); assert.equal(source.live, false);
    assert.equal(Object.hasOwn(source, "currentFresh"), false);
  }
  assert.equal(result.local.status!.rows[0]!.apply, "blocked-dirty");
  assert.equal(result.peer.status!.rows[0]!.apply, "blocked-diverged");
  assert.doesNotMatch(JSON.stringify(result), /discard this|receivedRef|peerPath/);
  assert.equal(await pathExists(f.state), false);
  assert.equal(await pathExists(f.paths.incidentDirectory), false);
  assert.equal(f.calls.length, 1);
});

test("read-only inspection isolates unavailable sources, reports stale cache, and sanitizes failures", async t => {
  const f = await fixture(t);
  f.deps.config = async () => { throw new Error("secret local path"); };
  f.peerPass(1);
  f.deps.now = () => epoch + 1_000_000;
  const result = await adapter.inspect(f.paths, f.deps);
  assert.equal(result.local.available, false);
  assert.equal(result.peer.available, true); assert.equal(result.peer.fresh, false);
  assert.equal(result.peer.status!.completedAt, at(1));
  assert.doesNotMatch(JSON.stringify(result), /secret local path/);
  f.deps.config = async () => null; f.deps.status = async () => null;
  f.deps.run = async () => { throw new Error("SSH credentials"); };
  const offline = await adapter.inspect(f.paths, f.deps);
  assert.equal(offline.local.available, true); assert.equal(offline.local.fresh, false);
  assert.equal(offline.peer.available, false);
  assert.equal(offline.peer.config, null); assert.equal(offline.peer.status, null);
  assert.doesNotMatch(JSON.stringify(offline), /SSH credentials/);
  assert.equal(await pathExists(f.state), false);
});

test("generic trusted primary host and legal dot/underscore-initial GitHub names are accepted", async t => {
  const f = await fixture(t), id = "Build_host.42";
  await saveHostIdentity(f.paths, createHostIdentity(id));
  f.deps.primary = async () => ({ ...f.primary, primaryHostId: id, configuredHostId: id, requiredHostIds: [id, peerId] });
  const c = config(id), s = pass(1, "needs-recovery", id);
  c.repositories = [".github", "_repo"].map(name => ({ canonicalRemote: `github.com/example/${name}`, branch: "main",
    enabled: true, applyCleanFastForward: true }));
  s.repositories = c.repositories.map(r => ({ ...pass(1, "needs-recovery", id).repositories[0]!, canonicalRemote: r.canonicalRemote }));
  f.deps.config = async () => c;
  assert.deepEqual(await f.run(s), { created: 2 });
  assert.deepEqual(await f.run(s), { created: 0 });
  f.deps.status = async () => s;
  const view = await adapter.inspect(f.paths, f.deps);
  assert.equal(view.local.available, true); assert.equal(view.local.hostId, id);
  assert.equal(view.local.config!.repositories.length, 2);
  assert.equal(view.local.status!.rows.length, 2);
});

test("abort during peer verification prevents spawn; in-flight cancellation returns only after transport completion", async t => {
  const f = await fixture(t), controller = new AbortController();
  f.deps.peer = async () => {
    controller.abort();
    return { executable: "/usr/bin/ssh", args: [] };
  };
  assert.deepEqual(await adapter.record(f.paths, null, f.deps, { signal: controller.signal }), { created: 0, peerUnavailable: true });
  assert.equal(f.calls.length, 0);
  const active = new AbortController();
  f.deps.peer = async () => ({ executable: "/usr/bin/ssh", args: [] });
  let started!: () => void, reaped!: () => void;
  const spawn = new Promise<void>(resolve => { started = resolve; });
  const close = new Promise<void>(resolve => { reaped = resolve; });
  f.deps.run = async (_file, _args, options) => {
    assert.equal(options.signal, active.signal);
    started(); await close;
    throw new Error("cancelled transport");
  };
  let settled = false;
  const task = adapter.record(f.paths, null, f.deps, { signal: active.signal }).then(r => { settled = true; return r; });
  await spawn; active.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  reaped();
  assert.deepEqual(await task, { created: 0, peerUnavailable: true });
  assert.equal(await pathExists(f.state), false);
});

test("fixed execution wrapper waits for close after an early abort callback, not for its 25-second deadline", async t => {
  const f = await fixture(t), controller = new AbortController();
  const child = new EventEmitter();
  let started!: () => void;
  const spawn = new Promise<void>(resolve => { started = resolve; });
  // Node may invoke execFile's abort callback before close; reproduce that
  // ordering without starting any child, SSH transport, watcher, or live repo.
  const execute = ((_file: string, _args: string[], options: Parameters<Deps["run"]>[2],
    callback: (error: Error | null, stdout: string) => void) => {
    options.signal!.addEventListener("abort", () => callback(new Error("AbortError"), "secret partial output"), { once: true });
    started(); return child;
  }) as unknown as typeof execFile;
  f.deps.run = adapter.closeRunner(execute);
  let settled = false;
  const task = adapter.record(f.paths, null, f.deps, { signal: controller.signal }).then(r => { settled = true; return r; });
  await spawn; controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(await task, { created: 0, peerUnavailable: true });
  assert.equal(await pathExists(f.state), false);
});

test("aborted scheduler pass neither connects nor creates attention state", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await adapter.record(f.paths, null, f.deps, { signal: controller.signal }), { created: 0 });
  assert.equal(f.calls.length, 0);
  assert.equal(await pathExists(f.state), false);
});

test("pure upstream peer is available and alerts central Guardian with workflow peers but zero direct enrollment", async t => {
  const f = await fixture(t);
  await saveWorkflowFixture(f.paths, primaryId, peerId);
  f.deps.workflow = loadWorkflowConfig;
  f.deps.status = async () => null;
  f.peerPass(1, "blocked-diverged");
  const directFile = join(f.paths.stateDirectory, "direct-sync.json");
  assert.equal(await pathExists(directFile), false);
  assert.equal(await pathExists(f.paths.registryRemoteConfigFile), false);
  const view = await adapter.inspect(f.paths, f.deps);
  assert.equal(view.local.available, true); assert.equal(view.local.config, null);
  assert.equal(view.peer.available, true); assert.equal(view.peer.hostId, peerId);
  assert.equal(view.peer.status?.rows[0]?.canonicalRemote, remote);
  assert.equal(view.peer.cachedOnly, true); assert.equal(view.peer.live, false);
  assert.equal(await pathExists(f.state), false); // inspection never reserves or journals
  assert.deepEqual(await f.run(), { created: 1 });
  assert.equal((await listIncidents(f.paths))[0]!.incident.reasonCode, "blocked-diverged");
  assert.deepEqual(await f.run(), { created: 0 });
  assert.equal(await pathExists(directFile), false); // no fabricated enrollment
  assert.equal(await pathExists(join(f.paths.stateDirectory, "upstream-sync.json")), false);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) assert.equal(call.args.at(-1), quotedPeerCommand(["sync", "upstream", "status"]));
});

test("zero, multiple, self or nonmember workflow peers never select an arbitrary transport", async t => {
  const f = await fixture(t), good = workflowFixture(primaryId, peerId);
  let verified = 0;
  f.deps.peer = async () => { verified++; throw new Error("must not verify ambiguous membership"); };
  for (const peers of [{}, { ...good.peers, extra: good.peers[peerId]! },
    { [primaryId]: good.peers[peerId]! }, { outsider: good.peers[peerId]! }]) {
    f.deps.workflow = async () => ({ ...good, peers });
    assert.deepEqual(await f.run(), { created: 0, peerUnavailable: true });
  }
  assert.equal(verified, 0); assert.equal(f.calls.length, 0);
});
