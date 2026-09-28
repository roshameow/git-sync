import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { consumeBridgeOutbox } from "../src/bridge.js";
import { resolveAppPaths } from "../src/config.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { saveInventory } from "../src/inventory.js";
import { loadProvenance, recordExplicitProvenance } from "../src/provenance.js";
import { createEmptyRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import { scanLocalRefs } from "../src/refs.js";
import type { BridgeEvent, HostInventory, SessionRegistry } from "../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function commitFile(repositoryPath: string, name: string, contents: string): Promise<string> {
  await writeFile(resolve(repositoryPath, name), contents);
  await git(repositoryPath, "add", "--", name);
  await git(repositoryPath, "commit", "--quiet", "-m", name);
  return git(repositoryPath, "rev-parse", "HEAD");
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-provenance-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const requestedRepositoryPath = resolve(sandbox, "fixture-repository");
  const home = resolve(sandbox, "application-state");
  await mkdir(requestedRepositoryPath);
  const repositoryPath = await realpath(requestedRepositoryPath);
  await git(repositoryPath, "init", "--quiet");
  await git(repositoryPath, "config", "user.name", "Fixture User");
  await git(repositoryPath, "config", "user.email", "fixture@example.invalid");
  const initialOid = await commitFile(repositoryPath, "initial.txt", "initial\n");
  const paths = resolveAppPaths({ GIT_SYNC_HOME: home });
  const identity = createHostIdentity("host-a", new Date("2025-01-01T00:00:00.000Z"), "fixture");
  await saveHostIdentity(paths, identity);
  const canonicalRemote = "example.invalid/team/project";
  const inventory: HostInventory = {
    schemaVersion: 1,
    hostId: identity.id,
    generatedAt: "2025-01-01T00:00:00.000Z",
    roots: [repositoryPath],
    repositories: [{
      path: repositoryPath,
      gitMarker: "directory",
      worktree: false,
      remoteName: "origin",
      canonicalRemote,
    }],
  };
  await saveInventory(paths, inventory);
  await saveRegistry(
    paths,
    setRepositoryMode(
      createEmptyRegistry(new Date("2025-01-01T00:00:00.000Z")),
      canonicalRemote,
      "enabled",
      new Date("2025-01-01T00:00:00.000Z"),
    ),
  );
  return { sandbox, repositoryPath, paths, initialOid };
}

test("bridge atomically accepts, deduplicates, quarantines, and projects non-exclusive Pi attribution", async (context) => {
  const { repositoryPath, paths, initialOid } = await fixture(context);
  await mkdir(paths.bridgeOutboxDirectory, { recursive: true });
  const start: BridgeEvent = {
    schemaVersion: 1,
    eventId: "event-start",
    eventType: "session.registered",
    occurredAt: "2025-01-02T00:00:00.000Z",
    producer: "pi-git-sync-bridge",
    hostId: "host-a",
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    repoRoot: repositoryPath,
    before: initialOid,
    after: initialOid,
    newCommitOids: [],
    evidence: {
      source: "pi-extension",
      trigger: "session_start",
      observation: "session-lifecycle",
      reason: "startup",
    },
    confidence: "high",
  };
  const commit: BridgeEvent = {
    schemaVersion: 1,
    eventId: "event-commit",
    eventType: "commit.observed",
    occurredAt: "2025-01-02T00:01:00.000Z",
    producer: "pi-git-sync-bridge",
    hostId: "host-a",
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    repoRoot: repositoryPath,
    before: null,
    after: initialOid,
    newCommitOids: [initialOid],
    evidence: {
      source: "pi-extension",
      trigger: "agent_settled",
      observation: "git-head-transition",
      baselineCapturedAt: "2025-01-02T00:00:30.000Z",
    },
    confidence: "medium",
  };
  const end: BridgeEvent = {
    ...start,
    eventId: "event-end",
    eventType: "session.unregistered",
    occurredAt: "2025-01-02T00:02:00.000Z",
    evidence: {
      source: "pi-extension",
      trigger: "session_shutdown",
      observation: "session-lifecycle",
      reason: "quit",
    },
  };
  await writeFile(resolve(paths.bridgeOutboxDirectory, "01-start.json"), JSON.stringify(start));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "02-commit.json"), JSON.stringify(commit));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "03-end.json"), JSON.stringify(end));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "04-wrong-host.json"), JSON.stringify({
    ...start,
    eventId: "event-wrong-host",
    hostId: "host-b",
  }));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "05-invalid.json"), JSON.stringify({
    ...start,
    eventId: "event-invalid",
    unexpected: true,
  }));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "06-invalid-oid.json"), JSON.stringify({
    ...commit,
    eventId: "event-invalid-oid",
    after: "A".repeat(40),
    newCommitOids: ["A".repeat(40)],
  }));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "07-invalid-path.json"), JSON.stringify({
    ...commit,
    eventId: "event-invalid-path",
    repoRoot: resolve(repositoryPath, "not-a-repository"),
  }));
  await writeFile(resolve(paths.bridgeOutboxDirectory, "08-future.json"), JSON.stringify({
    ...start,
    eventId: "event-future",
    occurredAt: "2025-01-02T01:00:00.000Z",
  }));
  await writeFile(resolve(paths.bridgeOutboxDirectory, ".producer-in-progress.tmp"), "{");

  const first = await consumeBridgeOutbox(paths, new Date("2025-01-02T00:02:00.000Z"));
  assert.deepEqual(first, { claimed: 8, accepted: 3, duplicates: 0, quarantined: 5 });
  assert.equal((await readdir(paths.bridgeAcceptedDirectory)).length, 3);
  assert.equal((await readdir(paths.bridgeQuarantineDirectory)).length, 5);
  assert.equal(await readFile(resolve(paths.bridgeOutboxDirectory, ".producer-in-progress.tmp"), "utf8"), "{");

  const sessions = JSON.parse(await readFile(paths.sessionsFile, "utf8")) as SessionRegistry;
  assert.equal(sessions.sessions["host-a:session-1"]?.status, "offline");
  const provenance = await loadProvenance(paths);
  const attributions = provenance.commits[0]?.attributions ?? [];
  assert.equal(attributions.length, 1);
  assert.equal(attributions[0]?.source, "pi");
  assert.equal(attributions[0]?.evidence, "bridge-claim");
  assert.equal(attributions[0]?.nonExclusive, true);

  // Simulate a crash after accepted journal persistence but before claim deletion.
  await writeFile(resolve(paths.bridgeClaimsDirectory, "replayed-claim.json"), JSON.stringify(commit));
  const replay = await consumeBridgeOutbox(paths, new Date("2025-01-02T00:03:00.000Z"));
  assert.deepEqual(replay, { claimed: 0, accepted: 0, duplicates: 1, quarantined: 0 });
  assert.equal((await loadProvenance(paths)).commits[0]?.attributions.length, 1);
  assert.equal((await stat(paths.bridgeAcceptedDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(resolve(paths.bridgeAcceptedDirectory, "event-commit.json"))).mode & 0o777, 0o600);
});

test("refs scanning baselines first, distinguishes remote reachability, records explicit source, and leaves repo unchanged", async (context) => {
  const { repositoryPath, paths, initialOid } = await fixture(context);
  await git(repositoryPath, "update-ref", "refs/remotes/origin/main", initialOid);

  const baseline = await scanLocalRefs(paths, new Date("2025-02-01T00:00:00.000Z"));
  assert.equal(baseline.baselined, 1);
  assert.equal((await loadProvenance(paths)).commits.length, 0);

  const localOnlyOid = await commitFile(repositoryPath, "local.txt", "local\n");
  const beforeLocalScan = await treeDigest(repositoryPath);
  const localScan = await scanLocalRefs(paths, new Date("2025-02-01T00:01:00.000Z"));
  assert.equal(localScan.observedCommits, 1);
  assert.equal(localScan.createdCandidates, 1);
  assert.equal(await treeDigest(repositoryPath), beforeLocalScan);

  const remoteOid = await commitFile(repositoryPath, "remote.txt", "remote\n");
  await git(repositoryPath, "update-ref", "refs/remotes/origin/main", remoteOid);
  const beforeRemoteScan = await treeDigest(repositoryPath);
  const remoteScan = await scanLocalRefs(paths, new Date("2025-02-01T00:02:00.000Z"));
  assert.equal(remoteScan.observedCommits, 1);
  assert.equal(remoteScan.createdCandidates, 0);
  assert.equal(await treeDigest(repositoryPath), beforeRemoteScan);

  // A reset/rebase/amend is non-fast-forward. It must still observe the new
  // commit without re-attributing commits that were already in the old refs.
  await git(repositoryPath, "reset", "--hard", localOnlyOid);
  const rewrittenOid = await commitFile(repositoryPath, "rewritten.txt", "rewritten\n");
  const rewrittenScan = await scanLocalRefs(paths, new Date("2025-02-01T00:02:30.000Z"));
  assert.equal(rewrittenScan.observedCommits, 1);
  assert.equal(rewrittenScan.createdCandidates, 1);
  assert.equal((await loadProvenance(paths)).commits.some((entry) => entry.oid === rewrittenOid), true);

  await recordExplicitProvenance(
    paths,
    repositoryPath,
    localOnlyOid,
    "vscode",
    "run-42",
    new Date("2025-02-01T00:03:00.000Z"),
  );
  const provenance = await loadProvenance(paths);
  const localEntry = provenance.commits.find((entry) => entry.oid === localOnlyOid);
  assert.deepEqual(
    localEntry?.attributions.map((entry) => entry.classification).sort(),
    ["attributed", "created-candidate", "observed"],
  );
  assert.equal(localEntry?.attributions.find((entry) => entry.source === "vscode")?.runId, "run-42");
  const remoteEntry = provenance.commits.find((entry) => entry.oid === remoteOid);
  assert.deepEqual(remoteEntry?.attributions.map((entry) => entry.classification), ["observed"]);
  assert.equal(remoteEntry?.attributions[0]?.source, "remote");

  const canonicalRemote = "example.invalid/team/project";
  await saveRegistry(
    paths,
    setRepositoryMode(
      createEmptyRegistry(new Date("2025-02-01T00:04:00.000Z")),
      canonicalRemote,
      "disabled",
      new Date("2025-02-01T00:04:00.000Z"),
    ),
  );
  const ignoredOid = await commitFile(repositoryPath, "disabled.txt", "disabled\n");
  const disabledScan = await scanLocalRefs(paths, new Date("2025-02-01T00:05:00.000Z"));
  assert.equal(disabledScan.repositories, 0);
  assert.equal((await loadProvenance(paths)).commits.some((entry) => entry.oid === ignoredOid), false);
});

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  await visit(root, "");
  return hash.digest("hex");

  async function visit(path: string, relativePath: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = resolve(path, entry.name);
      const relativeChild = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${relativeChild}\0`);
      if (entry.isDirectory()) await visit(child, relativeChild);
      else hash.update(await readFile(child));
    }
  }
}
