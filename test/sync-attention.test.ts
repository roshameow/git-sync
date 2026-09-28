import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import type { DirectSyncRepositoryStatus, DirectSyncStatus } from "../src/direct-sync-service.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { acknowledgeIncident, listIncidents, recordIncident } from "../src/incidents.js";
import { saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import { saveWorkflowFixture, workflowFixturePath } from "./guardian-workflow-fixture.js";
import { pathExists, writeJsonAtomic } from "../src/storage.js";
import { recordSyncAttention } from "../src/sync-attention.js";

const remote = "github.com/example/project", target = "a".repeat(40);
const exec = promisify(execFile);
async function fixture(t: TestContext, primary = "host-b") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sync-attention-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-b"));
  await saveWorkflowFixture(paths, primary, "host-a");
  await writeJsonAtomic(join(paths.stateDirectory, "direct-sync.json"), {
    schemaVersion: 1, hostId: "host-b", peerHostId: "host-a", applyCleanFastForward: true, intervalSeconds: 30,
    repositories: [{ canonicalRemote: remote, branch: "main", enabled: true, localPath: join(root, "repo"), peerPath: "/fixture/peer/project" }],
  });
  await saveRegistry(paths, setRepositoryMode(createEmptyRegistry(), remote, "enabled"));
  const repository = join(root, "repo");
  const git = async (...args: string[]) => (await exec("/usr/bin/git", ["-C", root, ...args], {
    timeout: 10_000, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout.trim();
  await git("init", "-b", "main", repository);
  await git("-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await git("-C", repository, "remote", "add", "origin", `https://${remote}.git`);
  const head = await git("-C", repository, "rev-parse", "HEAD");
  await saveInventory(paths, { schemaVersion: 1, hostId: "host-b", generatedAt: new Date().toISOString(), roots: [root],
    repositories: [{ path: repository, gitMarker: "directory", worktree: false, remoteName: "origin", canonicalRemote: remote }] });
  return { paths, root, repository, head, git };
}
function pass(n: number, state: DirectSyncRepositoryStatus["apply"]["state"], received = target): DirectSyncStatus {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { mode: "direct-peer", startedAt: at, completedAt: at, repositories: [{
    canonicalRemote: remote, branch: "main", peerHostId: "host-a", state: state === "error" ? "error" : "blocked",
    transfer: { state: "received" }, apply: { state }, received: {
      branch: "main", oid: received, receivedRef: "refs/received/test", changed: true, completedAt: at, worktreeUpdated: false,
    },
  }] };
}

test("primary follows workflow configuration; immediate attention keeps original journal across restart and acknowledgement", async t => {
  const { paths, head } = await fixture(t);
  assert.deepEqual(await recordSyncAttention(paths, pass(1, "blocked-diverged")), { created: 1 });
  const original = (await listIncidents(paths))[0]!.incident;
  assert.equal(original.incidentType, "sync.attention");
  assert.ok(original.summary.includes(remote));
  assert.ok(original.summary.includes(head));
  assert.ok(original.summary.includes(target));
  assert.match(original.summary, /git-sync guardian inspect .* and git-sync provenance/);
  assert.ok(original.summary.length <= 500);
  assert.doesNotMatch(original.summary, /session|author|producer/i);
  await acknowledgeIncident(paths, original.incidentId);
  assert.deepEqual(await recordSyncAttention(paths, pass(2, "blocked-diverged")), { created: 0 });
  assert.deepEqual((await listIncidents(paths, true))[0]!.incident, original);
  assert.equal((await listIncidents(paths)).length, 0);
  assert.deepEqual(await recordSyncAttention(paths, pass(3, "needs-recovery")), { created: 1 });
  assert.equal((await listIncidents(paths, true)).length, 2);
});

test("secondary is quiet; absent workflow defaults to own-host primary", async t => {
  const { paths } = await fixture(t, "host-a");
  assert.deepEqual(await recordSyncAttention(paths, pass(1, "blocked-diverged")), { created: 0 });
  assert.equal(await pathExists(join(paths.stateDirectory, "sync-attention.json")), false);
  await rm(workflowFixturePath(paths));
  assert.deepEqual(await recordSyncAttention(paths, pass(2, "needs-recovery")), { created: 1 });
  assert.equal(await pathExists(join(paths.stateDirectory, "sync-attention.json")), true);
});

for (const state of ["local-ahead", "blocked-dirty", "error"] as const) {
  test(`${state}: three distinct completed passes; replay/incomplete pass and error-body churn do not count or spam`, async t => {
    const { paths } = await fixture(t);
    const first = pass(1, state);
    assert.equal((await recordSyncAttention(paths, first)).created, 0);
    assert.equal((await recordSyncAttention(paths, first)).created, 0);
    assert.equal((await recordSyncAttention(paths, { ...pass(2, state), completedAt: null })).created, 0);
    const second = pass(2, state); second.repositories[0]!.apply.error = "secret changing error body";
    assert.equal((await recordSyncAttention(paths, second)).created, 0);
    assert.equal((await recordSyncAttention(paths, first)).created, 0); // old pass cannot move counter backwards
    assert.equal((await recordSyncAttention(paths, pass(3, state))).created, 1);
    assert.equal((await recordSyncAttention(paths, pass(4, state))).created, 0);
    const incident = (await listIncidents(paths))[0]!.incident;
    assert.match(incident.summary, /not a conflict claim/);
    assert.doesNotMatch(incident.summary, /secret/);
    // Recovery closes the episode; the same problem later is a new episode.
    await recordSyncAttention(paths, pass(5, "up-to-date"));
    for (let n = 6; n <= 8; n++) await recordSyncAttention(paths, pass(n, state));
    assert.equal((await listIncidents(paths)).length, 2);
  });
}

test("ordinary dirty HEAD equal to received is quiet; configured filters are never executed", async t => {
  const { paths, root, repository, head, git } = await fixture(t);
  const marker = join(root, "filter-ran");
  await git("-C", repository, "config", "filter.probe.clean", `touch '${marker}'; cat`);
  await writeFile(join(repository, ".gitattributes"), "* filter=probe\n");
  await writeFile(join(repository, "dirty"), "uncommitted\n");
  const before = await readFile(join(repository, ".git", "HEAD"), "utf8");
  for (let n = 1; n <= 4; n++) assert.equal((await recordSyncAttention(paths, pass(n, "blocked-dirty", head))).created, 0);
  assert.equal(await pathExists(marker), false);
  assert.equal(await readFile(join(repository, ".git", "HEAD"), "utf8"), before);
  assert.equal(await readFile(join(repository, "dirty"), "utf8"), "uncommitted\n");
  // A different received tip does require a check, but still not a conflict claim.
  for (let n = 5; n <= 7; n++) await recordSyncAttention(paths, pass(n, "blocked-dirty"));
  assert.equal((await listIncidents(paths)).length, 1);
  assert.equal(await pathExists(marker), false);
});

test("changed input OID resets count; reserved ID retries journal without replacing original", async t => {
  const { paths } = await fixture(t);
  await recordSyncAttention(paths, pass(1, "local-ahead"));
  await recordSyncAttention(paths, pass(2, "local-ahead"));
  assert.equal((await recordSyncAttention(paths, pass(3, "local-ahead", "b".repeat(40)))).created, 0);
  await recordSyncAttention(paths, pass(4, "local-ahead", "b".repeat(40)));
  await recordSyncAttention(paths, pass(5, "local-ahead", "b".repeat(40)));
  const original = (await listIncidents(paths))[0]!.incident;
  await rm(join(paths.incidentDirectory, `${original.incidentId}.json`)); // simulate reserved state before journal write
  assert.equal((await recordSyncAttention(paths, pass(5, "local-ahead", "b".repeat(40)))).created, 1);
  assert.deepEqual((await listIncidents(paths))[0]!.incident, original);
  await assert.rejects(recordIncident(paths, { ...original, summary: "different payload" }), /identity conflicts/);
  const state = JSON.parse(await readFile(join(paths.stateDirectory, "sync-attention.json"), "utf8"));
  const key = createHash("sha256").update(remote).digest("hex");
  assert.deepEqual(Object.keys(state[key]).sort(), ["count", "fingerprint", "incidentId", "pass"]);
});

test("disabled registry is not inspected and unsafe attention source fails closed", async t => {
  const { paths, root } = await fixture(t);
  await saveRegistry(paths, setRepositoryMode(createEmptyRegistry(), remote, "disabled"));
  assert.equal((await recordSyncAttention(paths, pass(1, "needs-recovery"))).created, 0);
  const state = join(paths.stateDirectory, "sync-attention.json"), other = join(root, "other");
  await rm(state); await writeFile(other, "{}", { mode: 0o600 }); await symlink(other, state);
  await assert.rejects(recordSyncAttention(paths, pass(2, "needs-recovery")));
  await rm(state); await writeFile(state, " ".repeat(64 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(recordSyncAttention(paths, pass(3, "needs-recovery")), /Unsafe sync attention source/);
  assert.equal((await listIncidents(paths)).length, 0);
});

test("cached equal tip cannot hide repeated transfer errors; unknown HEAD cannot suppress dirty attention", async t => {
  const { paths, head, repository } = await fixture(t);
  for (let n = 1; n <= 3; n++) {
    const status = pass(n, "blocked-dirty", head);
    status.repositories[0]!.state = "error";
    status.repositories[0]!.transfer = { state: "error", error: `offline attempt ${n}` };
    await recordSyncAttention(paths, status);
  }
  assert.equal((await listIncidents(paths))[0]!.incident.reasonCode, "repeated-error");
  await rm(repository, { recursive: true });
  for (let n = 4; n <= 6; n++) await recordSyncAttention(paths, pass(n, "blocked-dirty", head));
  const incidents = await listIncidents(paths);
  assert.equal(incidents.length, 2);
  assert.match(incidents[1]!.incident.summary, /HEAD=unknown/);
});

test("direct attention accepts 100 generic configured rows and rejects row 101 without advancing state", async t => {
  const f = await fixture(t), file = join(f.paths.stateDirectory, "direct-sync.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.repositories = Array.from({ length: 100 }, (_, n) => ({ ...config.repositories[0], canonicalRemote: `github.com/example/project-${n}` }));
  await writeJsonAtomic(file, config);
  let registry = createEmptyRegistry();
  for (const row of config.repositories) registry = setRepositoryMode(registry, row.canonicalRemote, "enabled");
  await saveRegistry(f.paths, registry);
  const status = pass(1, "up-to-date");
  status.repositories = config.repositories.map((row: { canonicalRemote: string }) => ({ ...status.repositories[0]!, canonicalRemote: row.canonicalRemote }));
  assert.deepEqual(await recordSyncAttention(f.paths, status), { created: 0 });
  const state = join(f.paths.stateDirectory, "sync-attention.json"), bytes = await readFile(state, "utf8");
  assert.equal(Object.keys(JSON.parse(bytes)).length, 100);
  assert.deepEqual(await recordSyncAttention(f.paths, status), { created: 0 }); // round-trip bounded state
  status.repositories.push({ ...status.repositories[0]!, canonicalRemote: "github.com/example/overflow" });
  await assert.rejects(recordSyncAttention(f.paths, status), /Invalid completed/);
  assert.equal(await readFile(state, "utf8"), bytes);
});

test("maximum public remote and SHA256 identifiers fit journal summaries without losing the selector", async t => {
  const f = await fixture(t), selected = `github.com/${"a".repeat(39)}/${"b".repeat(100)}`;
  const file = join(f.paths.stateDirectory, "direct-sync.json"), config = JSON.parse(await readFile(file, "utf8"));
  config.repositories[0].canonicalRemote = selected;
  await writeJsonAtomic(file, config);
  await saveRegistry(f.paths, setRepositoryMode(createEmptyRegistry(), selected, "enabled"));
  for (let n = 1; n <= 3; n++) {
    const status = pass(n, "local-ahead", "c".repeat(64));
    status.repositories[0]!.canonicalRemote = selected;
    status.repositories[0]!.apply.result = { status: "local-ahead", head: "d".repeat(64), oid: "c".repeat(64) };
    await recordSyncAttention(f.paths, status);
  }
  const summary = (await listIncidents(f.paths))[0]!.incident.summary;
  assert.ok(summary.length <= 500); assert.ok(summary.includes(`git-sync guardian inspect ${selected}`));
  assert.match(summary, /not a conflict claim/);
});
