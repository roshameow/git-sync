import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import { writeJsonAtomic } from "../src/storage.js";
import { withStateMutationLock } from "../src/state-mutation.js";
import { withOwnedLocalLock } from "../src/local-lock.js";
import type { RepositoryRecord } from "../src/types.js";
import {
  __runDirectSyncOnceForTests, directSyncStatus, loadDirectSyncConfig, runDirectSyncOnce,
  __peerSshCommandForTests, verifiedPeerSshArgv, verifiedWorkflowPeerSshArgv, type DirectSyncConfig, type DirectSyncTestDependencies,
} from "../src/direct-sync-service.js";

const names = ["orchard", "catalog", "widgets", "ledger", "manual"];
const remote = (name: string) => `git.example.test/team/${name}`;
const oid = "a".repeat(40);
const options = { timeout: 15_000 };
const received = { branch: "main", oid, receivedRef: `refs/received/${"b".repeat(64)}/${oid}`,
  changed: true, completedAt: "2026-09-21T00:00:00.000Z", worktreeUpdated: false as const };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "direct-sync-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: root });
  await mkdir(paths.stateDirectory, { mode: 0o700 });
  const config: DirectSyncConfig = { schemaVersion: 1, hostId: "build-node-17", peerHostId: "travel-node-29",
    applyCleanFastForward: false, intervalSeconds: 60,
    repositories: names.map(name => ({ canonicalRemote: remote(name), branch: "main", enabled: true,
      localPath: join(root, "checkouts", name), peerPath: join(root, "peer checkouts", name) })) };
  const records: RepositoryRecord[] = names.map(name => ({
    path: join(root, "checkouts", name),
    gitMarker: "directory", worktree: false, remoteName: "origin", canonicalRemote: remote(name),
  }));
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const key = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), publicKey.subarray(-32)]);
  await writeFile(join(root, "known hosts"), `peer.example.test ssh-ed25519 ${key.toString("base64")}\n`, { mode: 0o600 });
  await writeJsonAtomic(join(root, "workflow.json"), { schemaVersion: 1, primaryHostId: config.hostId,
    peers: { [config.peerHostId]: { host: "peer.example.test", user: "operator42", knownHosts: join(root, "known hosts"),
      fingerprint: "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, ""),
      nodeExecutable: "/opt/runtime/node", cliEntrypoint: "/opt/sync/cli.js" } } });
  await saveHostIdentity(paths, createHostIdentity("build-node-17"));
  const inventory = { schemaVersion: 1 as const, hostId: "build-node-17", generatedAt: new Date().toISOString(),
    roots: [join(root, "checkouts")], repositories: records };
  await saveInventory(paths, inventory);
  let registry = createEmptyRegistry();
  for (const name of names) registry = setRepositoryMode(registry, remote(name), "enabled");
  await saveRegistry(paths, registry);
  const file = join(paths.stateDirectory, "direct-sync.json");
  const save = (value: unknown = config) => writeJsonAtomic(file, value);
  const calls: { receive: Parameters<DirectSyncTestDependencies["receive"]>[0][];
    apply: Parameters<DirectSyncTestDependencies["apply"]>[0][]; ssh: number; inspect: number } =
    { receive: [], apply: [], ssh: 0, inspect: 0 };
  const deps: DirectSyncTestDependencies = {
    ssh: async () => { calls.ssh++; return "OFFLINE TEST ADAPTER: never executed"; },
    inspect: async path => {
      calls.inspect++;
      const record = records.find(r => r.path === path);
      assert.ok(record, "only configured logical paths inspected by offline adapter");
      return { record: { ...record }, identity: `fixture-inode:${path}` };
    },
    receive: async input => { calls.receive.push(input); return { ...received, branch: input.branch }; },
    apply: async input => { calls.apply.push(input); return { status: "fast-forwarded", head: input.oid, oid: input.oid }; },
  };
  const run = () => __runDirectSyncOnceForTests(paths, deps);
  return { root, paths, config, records, inventory, registry, file, save, calls, deps, run };
}

test("peer receive is outside state lock but final apply excludes concurrent repo-mode mutations", options, async t => {
  const f = await fixture(t);
  f.config.repositories = [f.config.repositories[0]!];
  f.config.applyCleanFastForward = true;
  await f.save();
  const receive = f.deps.receive;
  f.deps.receive = async input => {
    await withStateMutationLock(f.paths, async () => undefined);
    return receive(input);
  };
  const apply = f.deps.apply;
  f.deps.apply = async input => {
    let disableRan = false;
    await assert.rejects(withStateMutationLock(f.paths, async () => { disableRan = true; }), /State mutation lock already exists/);
    assert.equal(disableRan, false);
    return apply(input);
  };
  assert.equal((await f.run())?.repositories[0]?.apply.state, "fast-forwarded");
  assert.equal(f.calls.apply.length, 1);
  await withStateMutationLock(f.paths, async () => undefined);
});

test("no configuration is an offline no-op, with no status creation", options, async t => {
  const f = await fixture(t);
  assert.equal(await loadDirectSyncConfig(f.paths), null);
  assert.equal(await runDirectSyncOnce(f.paths), null);
  assert.equal(await directSyncStatus(f.paths), null);
  assert.equal(await f.run(), null);
  assert.equal(f.calls.ssh, 0);
});

test("strict explicit config accepts arbitrary peers, interval boundaries, and disabled repositories", options, async t => {
  const f = await fixture(t);
  f.config.repositories[4] = { ...f.config.repositories[4]!, enabled: false, reason: "pending legacy publication" };
  for (const intervalSeconds of [30, 900]) {
    f.config.intervalSeconds = intervalSeconds; await f.save();
    assert.deepEqual(await loadDirectSyncConfig(f.paths), f.config);
  }
  f.config.hostId = "travel-node-29"; f.config.peerHostId = "build-node-17";
  f.config.repositories[4]!.peerPath = join(f.root, "alternate peer checkout");
  f.config.applyCleanFastForward = true; await f.save();
  assert.deepEqual(await loadDirectSyncConfig(f.paths), f.config);
});

test("invalid schema, missing opt-in, endpoints, refs, and peer mapping fail before any adapter", options, async t => {
  const f = await fixture(t);
  const invalid: unknown[] = [null, [], {}, { ...f.config, applyCleanFastForward: undefined },
    { ...f.config, applyCleanFastForward: "true" }, { ...f.config, intervalSeconds: undefined },
    ...[29, 901, 30.5, "60"].map(intervalSeconds => ({ ...f.config, intervalSeconds })),
    { ...f.config, hostId: "../invalid" }, { ...f.config, peerHostId: "-invalid" },
    { ...f.config, peerHostId: "build-node-17" }, { ...f.config, repositories: [] },
    { ...f.config, repositories: [f.config.repositories[0], f.config.repositories[0]] }];
  const selection = f.config.repositories[0]!;
  for (const peerPath of [`${selection.peerPath}/../other`, `${selection.peerPath}/`, "relative/path", "user@host:repo", "~/checkout", "/tmp/line\nbreak"])
    invalid.push({ ...f.config, repositories: [{ ...selection, peerPath }] });
  for (const localPath of [undefined, "relative", "/tmp/../checkout", "/tmp/checkout/"])
    invalid.push({ ...f.config, repositories: [{ ...selection, localPath }] });
  for (const branch of ["-main", "a..b", "main.lock", "a//b", "a/.b", "main.", "main\n"])
    invalid.push({ ...f.config, repositories: [{ ...selection, branch }] });
  invalid.push({ ...f.config, repositories: [{ ...selection, canonicalRemote: "file:///tmp/not-network" }] },
    { ...f.config, repositories: [{ ...selection, enabled: undefined }] },
    { ...f.config, repositories: [{ ...selection, enabled: false }] },
    { ...f.config, repositories: [{ ...selection, enabled: false, reason: " " }] });
  for (const value of invalid) { await f.save(value); await assert.rejects(f.run(), /Invalid direct sync/); }
  assert.deepEqual(f.calls, { receive: [], apply: [], ssh: 0, inspect: 0 });
});

test("settings require owned single-link 0600 regular bounded files", options, async t => {
  const f = await fixture(t); await f.save();
  await chmod(f.file, 0o644); await assert.rejects(loadDirectSyncConfig(f.paths), /Unsafe/);
  await chmod(f.file, 0o600);
  const alias = join(f.root, "hardlink"); await link(f.file, alias);
  await assert.rejects(loadDirectSyncConfig(f.paths), /Unsafe/); await rm(alias);
  await rm(f.file); const target = join(f.root, "target"); await writeJsonAtomic(target, f.config);
  await symlink(target, f.file); await assert.rejects(loadDirectSyncConfig(f.paths), /Unsafe/);
  await rm(f.file); await mkdir(f.file); await assert.rejects(loadDirectSyncConfig(f.paths), /Unsafe/);
  await rm(f.file, { recursive: true }); await writeFile(f.file, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(loadDirectSyncConfig(f.paths), /Unsafe/);
});

test("explicit false receives arbitrary exact histories without applying", options, async t => {
  const f = await fixture(t); await f.save();
  const status = (await f.run())!;
  assert.equal(status.mode, "direct-peer"); assert.ok(status.completedAt);
  assert.equal(status.repositories.length, 5);
  for (const row of status.repositories) {
    assert.equal(row.transfer.state, "received"); assert.equal(row.apply.state, "not-requested");
    assert.equal(row.state, "received-not-applied"); assert.equal(row.received?.oid, oid);
  }
  assert.equal(f.calls.apply.length, 0); assert.equal(f.calls.receive.length, 5);
  for (const [i, input] of f.calls.receive.entries()) {
    assert.equal(input.source, `operator42@peer.example.test:${f.config.repositories[i]!.peerPath}`);
    assert.equal(input.branch, "main"); assert.equal(input.sshCommand, "OFFLINE TEST ADAPTER: never executed");
    const key = createHash("sha256").update(`${f.config.peerHostId}:${f.config.repositories[i]!.canonicalRemote}`).digest("hex");
    assert.equal(input.store, join(f.paths.stateDirectory, "direct-sync-stores", `${key}.git`));
  }
  assert.deepEqual(await directSyncStatus(f.paths), status);
});

test("all disabled selections skip even SSH preparation", options, async t => {
  const f = await fixture(t);
  f.config.repositories = f.config.repositories.map(r => ({ ...r, enabled: false, reason: "operator disabled; pending legacy attempt" }));
  await f.save();
  // Production entry is safe here: all rows gate before inspecting any real host path.
  const status = (await runDirectSyncOnce(f.paths))!;
  assert.equal(status.repositories.length, 5);
  assert.deepEqual(status.repositories.map(r => r.apply.state), ["blocked-disabled", "blocked-disabled", "blocked-disabled",
    "blocked-disabled", "blocked-disabled"]);
  assert.ok(status.repositories.every(r => r.transfer.state === "blocked"));
});

test("true opt-in applies only freshly received exact OIDs, after persisting transfer evidence", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  const apply = f.deps.apply;
  f.deps.apply = async input => {
    const saved = (await directSyncStatus(f.paths))!.repositories.find(r => r.canonicalRemote === remote(input.repository.split("/").at(-1)!))!;
    assert.equal(saved.transfer.state, "received"); assert.equal(saved.received?.oid, input.oid);
    assert.equal(saved.apply.state, "applying"); return apply(input);
  };
  const status = (await f.run())!;
  assert.equal(f.calls.apply.length, 5);
  for (const [i, input] of f.calls.apply.entries()) {
    assert.equal(input.oid, oid); assert.equal(input.store, f.calls.receive[i]!.store);
    assert.equal(input.repository, f.records[i]!.path); assert.equal(input.branch, "main");
    assert.ok(input.intentPath.startsWith(join(f.paths.stateDirectory, "direct-sync-apply-")));
    assert.equal(status.repositories[i]!.apply.state, "fast-forwarded");
  }
});

test("blocked apply outcomes remain distinct from transport errors", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  const outcomes = ["blocked-dirty", "blocked-diverged", "blocked-branch", "needs-recovery", "blocked-dirty"] as const;
  let index = 0;
  f.deps.apply = async () => ({ status: outcomes[index++]!, reason: "offline gate" });
  const status = (await f.run())!;
  assert.deepEqual(status.repositories.map(r => r.apply.state), outcomes);
  assert.ok(status.repositories.every(r => r.state === "blocked"));
  assert.ok(status.repositories.every(r => r.transfer.state === "received"));
});

test("local enabled identity and unique configured path bindings gate before receive", options, async t => {
  const f = await fixture(t); await f.save();
  await saveHostIdentity(f.paths, createHostIdentity("travel-node-29"));
  await assert.rejects(f.run(), /host identity differs/);
  await saveHostIdentity(f.paths, createHostIdentity("build-node-17"));
  await saveRegistry(f.paths, setRepositoryMode(f.registry, remote(names[0]!), "disabled"));
  f.records[1] = { ...f.records[1]!, path: "/tmp/wrong-checkout" };
  f.inventory.repositories = [...f.records, f.records[2]!];
  await saveInventory(f.paths, f.inventory);
  const inspect = f.deps.inspect;
  f.deps.inspect = async path => {
    const value = await inspect(path);
    return { ...value, record: { ...value.record, canonicalRemote: remote("wrong-identity") } };
  };
  const status = (await f.run())!;
  assert.deepEqual(status.repositories.map(r => r.apply.state),
    ["blocked-disabled", "blocked-identity", "blocked-identity", "blocked-identity", "blocked-identity"]);
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.ssh, 0);
});

test("settings deletion, same-content replacement, and apply revocation during transfer prevent apply", options, async t => {
  for (const drift of ["delete", "replace", "revoke"] as const) {
    const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
    f.config.repositories = f.config.repositories.slice(0, 1); await f.save();
    const receive = f.deps.receive;
    f.deps.receive = async input => {
      const result = await receive(input);
      if (drift === "delete") await rm(f.file);
      else { if (drift === "revoke") f.config.applyCleanFastForward = false; await f.save(); }
      return result;
    };
    const status = (await f.run())!;
    assert.equal(status.repositories[0]!.transfer.state, "received");
    assert.equal(status.repositories[0]!.apply.state, "blocked-settings-changed");
    assert.equal(status.repositories[0]!.received?.oid, oid); assert.equal(f.calls.apply.length, 0);
  }
});

test("mode, inventory and checkout inode changes during transfer prevent apply", options, async t => {
  for (const drift of ["mode", "path", "inode"] as const) {
    const f = await fixture(t); f.config.applyCleanFastForward = true;
    f.config.repositories = f.config.repositories.slice(0, 1); await f.save();
    const receive = f.deps.receive;
    f.deps.receive = async input => {
      const result = await receive(input);
      if (drift === "mode") await saveRegistry(f.paths, setRepositoryMode(f.registry, remote(names[0]!), "ignored"));
      if (drift === "path") {
        f.records[0] = { ...f.records[0]!, path: "/tmp/replaced" }; await saveInventory(f.paths, f.inventory);
      }
      if (drift === "inode") {
        const inspect = f.deps.inspect;
        f.deps.inspect = async path => ({ ...await inspect(path), identity: "replaced-inode" });
      }
      return result;
    };
    const status = (await f.run())!;
    assert.equal(status.repositories[0]!.transfer.state, "received");
    assert.equal(status.repositories[0]!.apply.state, drift === "mode" ? "blocked-disabled" : "blocked-identity");
    assert.equal(f.calls.apply.length, 0);
  }
});

test("offline restart preserves successful received data at pass start and after every failure", options, async t => {
  const f = await fixture(t); await f.save(); await f.run();
  f.config.applyCleanFastForward = true; await f.save();
  let seen = 0;
  f.deps.receive = async () => {
    const status = (await directSyncStatus(f.paths))!;
    assert.equal(status.completedAt, null);
    assert.ok(status.repositories.every(r => r.received?.oid === oid));
    seen++; throw new Error("Peer offline");
  };
  const status = (await f.run())!;
  assert.equal(seen, 5); assert.equal(f.calls.apply.length, 0);
  for (const row of status.repositories) {
    assert.equal(row.received?.oid, oid); assert.equal(row.transfer.state, "error");
    assert.equal(row.transfer.error, "Peer offline"); assert.equal(row.apply.state, "blocked-transfer");
  }
  // Normal restart can reattempt the peer READ; no cached tip is replayed.
  await f.run(); assert.equal(seen, 10); assert.equal(f.calls.apply.length, 0);
});

test("unresolved apply intent survives restart and blocks automatic replay without blocking other repos", options, async t => {
  const f = await fixture(t); await f.save(); await f.run();
  f.config.applyCleanFastForward = true; await f.save();
  const key = createHash("sha256").update(`travel-node-29:${remote(names[0]!)}`).digest("hex");
  const intent = join(f.paths.stateDirectory, `direct-sync-apply-${key}.json`);
  // A valid retained intent identifies the checkout; opaque/malformed evidence
  // cannot be assumed to belong elsewhere after a mode/config change.
  const repository = f.records[0]!.path;
  const bytes = JSON.stringify({ version: 1, repository, repositoryId: "1:2", gitDir: join(repository, ".git"),
    gitDirId: "1:3", commonDir: join(repository, ".git"), store: join(f.root, "store.git"),
    branch: "main", head: "a".repeat(40), target: "b".repeat(40) });
  await writeFile(intent, bytes, { mode: 0o600 });
  f.calls.receive.length = 0;
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.apply.state, "needs-recovery");
  assert.equal(status.repositories[0]!.transfer.state, "blocked");
  assert.equal(status.repositories[0]!.received?.oid, oid);
  assert.equal(f.calls.receive.length, 4); assert.equal(f.calls.apply.length, 4);
  assert.equal(await readFile(intent, "utf8"), bytes);
  await writeFile(intent, "unresolved intent bytes");
  f.calls.receive.length = 0; f.calls.apply.length = 0;
  await f.run();
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.apply.length, 0);
  assert.equal(await readFile(intent, "utf8"), "unresolved intent bytes");
});

test("apply exception preserves exact received tip and later repositories continue", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  let calls = 0;
  f.deps.apply = async input => {
    calls++; if (calls === 1) throw new Error("local apply failed");
    return { status: "up-to-date", head: input.oid, oid: input.oid };
  };
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.transfer.state, "received");
  assert.equal(status.repositories[0]!.received?.oid, oid);
  assert.equal(status.repositories[0]!.apply.state, "error");
  assert.equal(status.repositories[1]!.apply.state, "up-to-date"); assert.equal(calls, 5);
});

test("SSH preparation failure is per-repository and retains prior receive evidence", options, async t => {
  const f = await fixture(t); await f.save(); await f.run();
  f.deps.ssh = async () => { throw new Error("Pinned peer unavailable"); };
  const count = f.calls.receive.length;
  const status = (await f.run())!;
  assert.ok(status.repositories.every(r => r.received?.oid === oid && r.transfer.state === "error"));
  assert.equal(f.calls.receive.length, count);
});

test("legacy status normalizes into separate transfer/apply fields and survives a failed restart", options, async t => {
  const f = await fixture(t); await f.save();
  const legacy = { mode: "direct-peer-commits", startedAt: received.completedAt, completedAt: null,
    repositories: [{ canonicalRemote: remote(names[0]!), branch: "main", state: "received-not-applied", received }] };
  await writeJsonAtomic(join(f.paths.stateDirectory, "direct-sync-status.json"), legacy);
  const before = (await directSyncStatus(f.paths))!;
  assert.equal(before.mode, "direct-peer"); assert.equal(before.repositories[0]!.transfer.state, "received");
  assert.equal(before.repositories[0]!.apply.state, "not-requested");
  f.deps.receive = async () => { throw new Error("offline"); };
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.received?.oid, oid);
  assert.equal(status.repositories[0]!.peerHostId, "travel-node-29");
});

test("same-content settings replacement during SSH preparation prevents even transfer", options, async t => {
  const f = await fixture(t); await f.save();
  f.deps.ssh = async () => { await f.save(); return "never used"; };
  const status = (await f.run())!;
  assert.equal(status.repositories[0]!.apply.state, "blocked-settings-changed");
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.apply.length, 0);
});

test("AbortSignal is forwarded to receive, and cancellation never starts a new apply", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  const controller = new AbortController();
  let calls = 0;
  f.deps.receive = async input => {
    assert.equal(input.signal, controller.signal); calls++;
    controller.abort(); return received;
  };
  const status = (await __runDirectSyncOnceForTests(f.paths, f.deps, { signal: controller.signal }))!;
  assert.equal(calls, 1); assert.equal(f.calls.apply.length, 0);
  assert.equal(status.repositories[0]!.received?.oid, oid);
  assert.equal(status.repositories[0]!.transfer.state, "received");
  assert.ok(status.repositories.every(r => r.apply.state === "blocked-cancelled"));
  const stopped = (await __runDirectSyncOnceForTests(f.paths, f.deps, { signal: controller.signal }))!;
  assert.equal(calls, 1); assert.equal(stopped.repositories[0]!.received?.oid, oid);
});

test("AbortSignal reaches apply and an interrupted apply stops later repository work", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  const controller = new AbortController();
  let applies = 0;
  f.deps.apply = async input => {
    assert.equal(input.signal, controller.signal); applies++;
    controller.abort(); return { status: "needs-recovery", reason: "Interrupted apply retains its intent" };
  };
  const status = (await __runDirectSyncOnceForTests(f.paths, f.deps, { signal: controller.signal }))!;
  assert.equal(applies, 1); assert.equal(f.calls.receive.length, 1);
  assert.equal(status.repositories[0]!.apply.state, "needs-recovery");
  assert.equal(status.repositories[0]!.transfer.state, "received");
  assert.equal(status.repositories[0]!.received?.oid, oid);
  assert.ok(status.repositories.slice(1).every(r => r.apply.state === "blocked-cancelled"));
  assert.deepEqual(await directSyncStatus(f.paths), status);
});

// Verified offline integration method: only state fixtures touch disk; peer and
// configured checkout paths are logical adapter inputs, never opened.
// Reproducible pitfalls captured above: atomic same-content config replacement
// revokes a pass, and offline/crashed retries must retain the last received OID.

test("direct peer cannot bypass retained upstream intent after configuration removal or during receive", options, async t => {
  for (const duringReceive of [false, true]) {
    const f = await fixture(t);
    f.config.repositories = [f.config.repositories[0]!];
    f.config.applyCleanFastForward = true;
    await f.save();
    const directory = join(f.paths.stateDirectory, "upstream-sync");
    await mkdir(directory, { mode: 0o700 });
    const intent = join(directory, `apply-${"c".repeat(64)}.json`), bytes = "opaque interrupted upstream intent\n";
    const create = () => writeFile(intent, bytes, { mode: 0o600 });
    if (!duringReceive) await create();
    else {
      const receive = f.deps.receive;
      f.deps.receive = async input => { const result = await receive(input); await create(); return result; };
    }
    const result = (await f.run())!.repositories[0]!;
    assert.equal(result.apply.state, "needs-recovery");
    assert.equal(f.calls.receive.length, duringReceive ? 1 : 0);
    assert.equal(f.calls.apply.length, 0);
    assert.equal(await readFile(intent, "utf8"), bytes);
    await assert.rejects(readFile(join(f.paths.stateDirectory, "upstream-sync.json")), { code: "ENOENT" });
  }
});

test("pinned SSH uses configured user/host and exact case-insensitive known_hosts with space-safe argv and Git command", options, async t => {
  const f = await fixture(t);
  const file = join(f.root, "workflow.json"), workflow = JSON.parse(await readFile(file, "utf8"));
  const peer = workflow.peers[f.config.peerHostId];
  const hosts = (await readFile(peer.knownHosts, "utf8")).replace("peer.example.test", "other.example.test,PEER.EXAMPLE.TEST");
  peer.knownHosts = join(f.root, "known hosts ' $literal");
  await writeFile(peer.knownHosts, hosts, { mode: 0o644 });
  await writeJsonAtomic(file, workflow);
  const ssh = await verifiedPeerSshArgv(f.config, f.paths);
  assert.equal(ssh.executable, "/usr/bin/ssh");
  assert.equal(ssh.args.at(-1), "operator42@peer.example.test");
  for (const option of ["StrictHostKeyChecking=yes", "ProxyCommand=none", "ProxyJump=none", "HostKeyAlgorithms=ssh-ed25519",
    "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "ClearAllForwardings=yes"])
    assert.ok(ssh.args.includes(option));
  assert.ok(ssh.args.includes(`UserKnownHostsFile="${peer.knownHosts}"`));
  assert.deepEqual(ssh.args.slice(0, 5), ["-F", "/dev/null", "-T", "-p", "22"]);
  // ssh -G expands configuration only: no connection, keyscan or pin replacement.
  const argvDump = await promisify(execFile)(ssh.executable, ["-G", ...ssh.args], { timeout: 3000 });
  assert.ok(argvDump.stdout.includes(`userknownhostsfile ${peer.knownHosts}`));
  assert.match(argvDump.stdout, /^port 22$/m);
  const command = await __peerSshCommandForTests(f.config, f.paths);
  const shellDump = await promisify(execFile)("/bin/sh", ["-c", `${command} -G "$@"`, "ssh-config", ssh.args.at(-1)!], { timeout: 3000 });
  assert.equal(shellDump.stdout, argvDump.stdout);
  assert.equal(await readFile(peer.knownHosts, "utf8"), hosts);
});

test("pin verification fails closed for mismatches, wrong hosts, ambiguous or unproven keys and unsafe files", options, async t => {
  const f = await fixture(t), file = join(f.root, "known hosts");
  const hosts = await readFile(file, "utf8");
  const otherDer = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const otherKey = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), otherDer.subarray(-32)]);
  for (const text of [hosts + hosts, hosts.replace("peer.example.test", "wrong.example.test"),
    hosts.replace("peer.example.test", "*.example.test"), hosts.replace("peer.example.test", "|1|hashed|entry"),
    `peer.example.test ssh-ed25519 ${otherKey.toString("base64")}\n`, "peer.example.test ssh-ed25519 invalid\n"])
  {
    await writeFile(file, text);
    await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /pinned SSH|fingerprint/);
  }
  await writeFile(file, hosts); await chmod(file, 0o666);
  await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/);
  await chmod(file, 0o600);
  const alias = join(f.root, "hosts-alias"); await link(file, alias);
  await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/); await rm(alias);
  await rm(file); await writeFile(alias, hosts, { mode: 0o600 }); await symlink(alias, file);
  await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/); await rm(file);
  await mkdir(file); await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/); await rm(file, { recursive: true });
  await promisify(execFile)("/usr/bin/mkfifo", [file], { timeout: 2000 });
  await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/); await rm(file);
  await writeFile(file, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(verifiedPeerSshArgv(f.config, f.paths), /Unsafe/);
});

test("only LOCAL inventory binds the configured path; unrelated corrupt peer inventories do not block", options, async t => {
  const f = await fixture(t); await f.save();
  await writeFile(join(f.paths.inventoryDirectory, `${f.config.peerHostId}.json`), "not an inventory");
  assert.ok((await f.run())!.repositories.every(row => row.transfer.state === "received"));
  await rm(join(f.paths.inventoryDirectory, `${f.config.hostId}.json`));
  const count = f.calls.receive.length;
  assert.ok((await f.run())!.repositories.every(row => row.apply.state === "blocked-identity"));
  assert.equal(f.calls.receive.length, count);
});

test("workflow revocation or endpoint changes during receive retain receipt but prevent apply", options, async t => {
  for (const drift of ["remove", "endpoint", "unsafe"] as const) {
    const f = await fixture(t); f.config.applyCleanFastForward = true;
    f.config.repositories = [f.config.repositories[0]!]; await f.save();
    const receive = f.deps.receive;
    f.deps.receive = async input => {
      const result = await receive(input), file = join(f.root, "workflow.json");
      if (drift === "remove") await rm(file);
      else if (drift === "unsafe") await chmod(file, 0o666);
      else { const workflow = JSON.parse(await readFile(file, "utf8")); workflow.peers[f.config.peerHostId].host = "elsewhere.example.test";
        await writeJsonAtomic(file, workflow); }
      return result;
    };
    const row = (await f.run())!.repositories[0]!;
    assert.equal(row.transfer.state, "received"); assert.equal(row.received?.oid, oid);
    assert.equal(row.apply.state, "blocked-settings-changed"); assert.equal(f.calls.apply.length, 0);
  }
});

test("100 generic network identities and status rows are allowed; unsafe identities and 101 rows are rejected", options, async t => {
  const f = await fixture(t), original = f.config.repositories[0]!;
  f.config.repositories = Array.from({ length: 100 }, (_, n) => ({ ...original, canonicalRemote: `forge.example.test:8443/group/subgroup/repository-${n}` }));
  await f.save(); assert.equal((await loadDirectSyncConfig(f.paths))!.repositories.length, 100);
  const status = { mode: "direct-peer", startedAt: received.completedAt, completedAt: null,
    repositories: f.config.repositories.map(r => ({ canonicalRemote: r.canonicalRemote, branch: r.branch,
      state: "received-not-applied", transfer: { state: "received" }, apply: { state: "not-requested" }, received })) };
  await writeJsonAtomic(join(f.paths.stateDirectory, "direct-sync-status.json"), status);
  assert.equal((await directSyncStatus(f.paths))!.repositories.length, 100);
  await f.save({ ...f.config, repositories: [...f.config.repositories, { ...original, canonicalRemote: remote("extra") }] });
  await assert.rejects(loadDirectSyncConfig(f.paths), /Invalid direct sync/);
  for (const canonicalRemote of ["host/repo", "https://host/group/repo", "host/group/repo.git", "Host/group/repo",
    "host/group/../repo", "host/group/%72epo", "user@host/group/repo", "host/group/repo?token=x", "host/group/repo#fragment"])
  { await f.save({ ...f.config, repositories: [{ ...original, canonicalRemote }] });
    await assert.rejects(loadDirectSyncConfig(f.paths), /Invalid direct sync/); }
});

// Verified offline method: ssh -G checks the real OpenSSH argv/config parser and
// the shell-rendered GIT_SSH_COMMAND without dialing a host. A known_hosts path
// needs both SSH-option quoting and shell quoting; splitting on spaces loses it.

test("direct pass lock rejects concurrent work before any inspection or transfer", options, async t => {
  const f = await fixture(t); await f.save();
  await withOwnedLocalLock(join(f.paths.stateDirectory, "direct-sync.lock"), "held direct pass", async () => {
    await assert.rejects(f.run(), /lock already exists/);
    assert.deepEqual(f.calls, { receive: [], apply: [], ssh: 0, inspect: 0 });
  });
  assert.ok((await f.run())!.completedAt);
});

test("an unconfigured peer never reaches SSH or transfer even with explicit apply opt-in", options, async t => {
  const f = await fixture(t); f.config.applyCleanFastForward = true; await f.save();
  await rm(join(f.root, "workflow.json"));
  const status = (await f.run())!;
  assert.ok(status.repositories.every(row => row.transfer.state === "error" && row.transfer.error === "Workflow peer is not configured"));
  assert.equal(f.calls.ssh, 0); assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.apply.length, 0);
});

test("workflow diagnostics resolve pinned SSH independently of direct repository enrollment", options, async t => {
  const f = await fixture(t);
  await rm(f.paths.inventoryDirectory, { recursive: true });
  await rm(f.paths.registryFile);
  assert.equal(await loadDirectSyncConfig(f.paths), null);
  const ssh = await verifiedWorkflowPeerSshArgv(f.paths, f.config.peerHostId);
  assert.equal(ssh.executable, "/usr/bin/ssh");
  assert.equal(ssh.args.at(-1), "operator42@peer.example.test");
  assert.deepEqual(await verifiedPeerSshArgv(f.config, f.paths), ssh);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  await assert.rejects(verifiedPeerSshArgv({ ...f.config, repositories: [] }, f.paths), /Invalid direct sync/);
  // Even an unrelated malformed direct-sync file is not diagnostic authority.
  await writeFile(f.file, "not direct-sync configuration", { mode: 0o600 });
  assert.deepEqual(await verifiedWorkflowPeerSshArgv(f.paths, f.config.peerHostId), ssh);
  await assert.rejects(verifiedWorkflowPeerSshArgv(f.paths, "unknown-peer"), /not configured/);
  await assert.rejects(verifiedWorkflowPeerSshArgv(f.paths, "../unsafe"), /not configured/);
  await writeFile(join(f.root, "known hosts"), "wrong.example.test ssh-ed25519 invalid\n");
  await assert.rejects(verifiedWorkflowPeerSshArgv(f.paths, f.config.peerHostId), /pinned SSH/);
});
// Verified diagnostic boundary: transport resolution requires workflow.json and
// its real pinned key, but no direct-sync configuration, inventory, or registry.
// Keep repository enrollment validation in the direct-sync wrapper, not shared
// transport lookup, so upstream-only hosts can still answer peer diagnostics.
