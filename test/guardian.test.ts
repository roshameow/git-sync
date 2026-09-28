import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { resolveAppPaths } from "../src/config.js";
import {
  configureGuardianRouting,
  dispatchGuardianIncidents,
  guardianCandidates,
  guardianStatus,
} from "../src/guardian.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { acknowledgeIncident, listIncidents, recordIncident } from "../src/incidents.js";
import { saveWorkflowFixture, workflowFixture, workflowFixturePath } from "./guardian-workflow-fixture.js";
import { pathExists, writeJsonAtomic } from "../src/storage.js";

test("primary Guardian routing dispatches exact-session idempotent incident events through a pinned fake sender", async (context) => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-guardian-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: resolve(sandbox, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  await saveWorkflowFixture(paths, "host-a");

  await writeJsonAtomic(paths.sessionsFile, {
    schemaVersion: 1,
    projectedAt: new Date().toISOString(),
    sessions: {
      "host-a:session-guardian-01": {
        hostId: "host-a",
        sessionId: "session-guardian-01",
        repositoryPath: "/safe/guardian/cwd",
        sessionFile: "/safe/session.jsonl",
        status: "active",
        startedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString(),
        lastEventId: "event-1",
      },
    },
  });
  assert.deepEqual(await guardianCandidates(paths), [{
    sessionId: "session-guardian-01",
    repositoryPath: "/safe/guardian/cwd",
    lastEventAt: (JSON.parse(await readFile(paths.sessionsFile, "utf8")) as { sessions: Record<string, { lastEventAt: string }> }).sessions["host-a:session-guardian-01"]?.lastEventAt,
  }]);

  const sender = resolve(sandbox, "notify-agent");
  const senderLog = resolve(sandbox, "sender.log");
  const capturedEvent = resolve(sandbox, "captured-event.json");
  await writeFile(sender, `#!/usr/bin/env python3
import json, pathlib, sys
with open(${JSON.stringify(senderLog)}, "a") as f: f.write(" ".join(sys.argv[1:]) + "\\n")
assert sys.argv[1:3] == ["send", "--event-file"]
pathlib.Path(${JSON.stringify(capturedEvent)}).write_bytes(pathlib.Path(sys.argv[3]).read_bytes())
print(json.dumps({"ok": True}))
`, { mode: 0o700 });
  await chmod(sender, 0o700);

  const routing = await configureGuardianRouting(paths, "session-guardian-01", sender);
  assert.equal(routing.hostId, "host-a");
  assert.equal(routing.generation, 1);
  assert.equal(routing.targetSessionId, "session-guardian-01");
  assert.equal(routing.itemKey, "git-sync:guardian:host-a");

  const incident = await recordIncident(paths, {
    incidentType: "daemon.pass.failed",
    severity: "yellow",
    reasonCode: "local-pass-failed",
    summary: "The local observer pass failed closed; inspect daemon status and local state",
  });
  const first = await dispatchGuardianIncidents(paths);
  assert.deepEqual(first, {
    configured: true,
    attempted: 1,
    dispatched: 1,
    alreadyDispatched: 0,
    failed: 0,
  });
  const event = JSON.parse(await readFile(capturedEvent, "utf8")) as {
    eventId: string;
    itemKey: string;
    target: { sessionId: string };
    payload: { incidentId: string; authoritativeCommand: string };
  };
  assert.equal(event.eventId, `git-sync:${incident.incidentId}:g1`);
  assert.equal(event.itemKey, "git-sync:guardian:host-a");
  assert.deepEqual(event.target, { sessionId: "session-guardian-01" });
  assert.equal(event.payload.incidentId, incident.incidentId);
  assert.equal(event.payload.authoritativeCommand, `git-sync incidents show ${incident.incidentId}`);

  const second = await dispatchGuardianIncidents(paths);
  assert.equal(second.attempted, 0);
  assert.equal(second.alreadyDispatched, 1);
  assert.equal((await readFile(senderLog, "utf8")).trim().split("\n").length, 1);
  const status = await guardianStatus(paths);
  assert.equal(status.configured, true);
  assert.equal(status.ready, true);
  assert.equal(status.primaryIdentityValid, true);
  assert.equal(status.senderIntegrityValid, true);
  assert.equal(status.targetSessionActive, true);
  assert.equal(status.openIncidents, 1);
  assert.equal(status.dispatchedIncidents, 1);

  const sessionState = JSON.parse(await readFile(paths.sessionsFile, "utf8")) as {
    sessions: Record<string, Record<string, unknown>>;
  };
  const secondSessionTime = new Date().toISOString();
  sessionState.sessions["host-a:session-guardian-02"] = {
    hostId: "host-a",
    sessionId: "session-guardian-02",
    repositoryPath: "/safe/guardian/cwd",
    sessionFile: "/safe/session-02.jsonl",
    status: "active",
    startedAt: secondSessionTime,
    lastEventAt: secondSessionTime,
    lastEventId: "event-2",
  };
  await writeJsonAtomic(paths.sessionsFile, sessionState);
  const routingTwo = await configureGuardianRouting(paths, "session-guardian-02", sender);
  assert.equal(routingTwo.generation, 2);
  const rerouted = await dispatchGuardianIncidents(paths);
  assert.equal(rerouted.dispatched, 1);
  const reroutedEvent = JSON.parse(await readFile(capturedEvent, "utf8")) as {
    eventId: string;
    target: { sessionId: string };
  };
  assert.equal(reroutedEvent.eventId, `git-sync:${incident.incidentId}:g2`);
  assert.deepEqual(reroutedEvent.target, { sessionId: "session-guardian-02" });
  assert.equal((await readFile(senderLog, "utf8")).trim().split("\n").length, 2);

  const acknowledgement = await acknowledgeIncident(paths, incident.incidentId);
  assert.equal((await listIncidents(paths, false)).length, 0);
  assert.equal((await listIncidents(paths, true)).length, 1);
  const acknowledgementPath = resolve(paths.incidentAcknowledgementDirectory, `${incident.incidentId}.json`);
  await writeFile(acknowledgementPath, "{}\n");
  await assert.rejects(listIncidents(paths, false), /Invalid or unsupported state schema/);
  await writeFile(acknowledgementPath, `${JSON.stringify(acknowledgement)}\n`);

  const next = await recordIncident(paths, {
    incidentType: "registry.admission.rejected",
    severity: "red",
    reasonCode: "invalid-signature",
    summary: "Registry admission rejected a signature or signing key",
  });
  await writeFile(routing.senderScript, "#!/usr/bin/env python3\npass\n", { mode: 0o700 });
  await assert.rejects(dispatchGuardianIncidents(paths), /hash changed/);
  const degradedStatus = await guardianStatus(paths);
  assert.equal(degradedStatus.ready, false);
  assert.equal(degradedStatus.senderIntegrityValid, false);
  assert.equal(await pathExists(resolve(paths.guardianDispatchDirectory, `${next.incidentId}-g2.json`)), false);
});

test("real Python sender executes pinned bytes; exit zero without acknowledgement is not delivery", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "git-sync-guardian-python-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: resolve(root, "app") });
  await saveHostIdentity(paths, createHostIdentity("primary"));
  await saveWorkflowFixture(paths, "primary");
  const now = new Date().toISOString();
  await writeJsonAtomic(paths.sessionsFile, { schemaVersion: 1, projectedAt: now, sessions: {
    "primary:python-guardian": { hostId: "primary", sessionId: "python-guardian", repositoryPath: root,
      sessionFile: resolve(root, "session.jsonl"), status: "active", startedAt: now, lastEventAt: now, lastEventId: "start" },
  } });
  const empty = resolve(root, "empty.py");
  await writeFile(empty, "#!/usr/bin/env python3\npass\n", { mode: 0o700 });
  await configureGuardianRouting(paths, "python-guardian", empty);
  const incident = await recordIncident(paths, { incidentType: "sync.attention", severity: "yellow", reasonCode: "blocked-dirty", summary: "Inspect both hosts" });
  assert.equal((await dispatchGuardianIncidents(paths)).failed, 1);
  assert.equal(await pathExists(resolve(paths.guardianDispatchDirectory, `${incident.incidentId}-g1.json`)), false);
  const sender = resolve(root, "sender.py"), captured = resolve(root, "captured.json");
  await writeFile(sender, `#!/usr/bin/env python3\nimport json, sys\nassert sys.argv[1:3] == ["send", "--event-file"]\nwith open(sys.argv[3]) as f: event = json.load(f)\nwith open(${JSON.stringify(captured)}, "w") as f: json.dump(event, f)\nprint(json.dumps({"ok": True}))\n`, { mode: 0o700 });
  await configureGuardianRouting(paths, "python-guardian", sender);
  assert.equal((await dispatchGuardianIncidents(paths)).dispatched, 1);
  assert.equal(JSON.parse(await readFile(captured, "utf8")).target.sessionId, "python-guardian");
  assert.equal((await dispatchGuardianIncidents(paths)).alreadyDispatched, 1);
});

test("secondary host cannot configure Guardian routing", async (context) => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-guardian-secondary-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: resolve(sandbox, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-b"));
  await saveWorkflowFixture(paths, "host-a");
  const sender = resolve(sandbox, "sender");
  await writeFile(sender, "#!/usr/bin/env python3\npass\n", { mode: 0o700 });
  await mkdir(resolve(sandbox, "unused"));
  await assert.rejects(
    configureGuardianRouting(paths, "session-guardian-01", sender),
    /fixed primary host/,
  );
});

test("optional incident filter excludes old incidents before dispatch cap and validates attention event retries", async context => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-guardian-filter-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: resolve(sandbox, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  await saveWorkflowFixture(paths, "host-a");
  const now = new Date().toISOString();
  await writeJsonAtomic(paths.sessionsFile, { schemaVersion: 1, projectedAt: now, sessions: { target: {
    hostId: "host-a", sessionId: "guardian-target", repositoryPath: sandbox, sessionFile: null,
    status: "active", startedAt: now, lastEventAt: now, lastEventId: "one",
  } } });
  const sender = resolve(sandbox, "sender"), marker = resolve(sandbox, "attempted"), captured = resolve(sandbox, "event");
  await writeFile(sender, `#!/usr/bin/env python3
import json, pathlib, sys
marker = pathlib.Path(${JSON.stringify(marker)})
if not marker.exists():
    marker.touch()
    sys.exit(1)
pathlib.Path(${JSON.stringify(captured)}).write_bytes(pathlib.Path(sys.argv[3]).read_bytes())
print(json.dumps({"ok": True}))
`, { mode: 0o700 });
  await configureGuardianRouting(paths, "guardian-target", sender);
  for (let n = 0; n < 101; n++) await recordIncident(paths, {
    incidentType: "daemon.pass.failed", severity: "yellow", reasonCode: "old-pass", summary: "old incident",
  }, new Date("2026-01-01"));
  const attention = await recordIncident(paths, {
    incidentType: "sync.attention", severity: "yellow", reasonCode: "blocked-diverged", summary: "inspect attention",
  }, new Date("2026-01-02"));
  const filter = { incidentTypes: ["sync.attention"] as const };
  const first = await dispatchGuardianIncidents(paths, new Date(), filter);
  assert.equal(first.attempted, 1); assert.equal(first.failed, 1);
  const second = await dispatchGuardianIncidents(paths, new Date(), filter);
  assert.equal(second.dispatched, 1);
  const event = JSON.parse(await readFile(captured, "utf8"));
  assert.equal(event.eventType, "sync.attention");
  assert.equal(event.payload.incidentId, attention.incidentId);
  assert.equal((await dispatchGuardianIncidents(paths, new Date(), filter)).alreadyDispatched, 1);
  assert.equal((await listIncidents(paths)).length, 102);
});

test("workflow Python controls pinned-byte execution, sender permissions fail closed, role changes degrade readiness", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "guardian-python-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: resolve(root, "app") });
  await saveHostIdentity(paths, createHostIdentity("host-a"));
  const workflow = workflowFixture();
  workflow.executables.python = resolve(root, "absent python");
  await writeJsonAtomic(workflowFixturePath(paths), workflow);
  const now = new Date().toISOString();
  await writeJsonAtomic(paths.sessionsFile, { schemaVersion: 1, projectedAt: now, sessions: { target: {
    hostId: "host-a", sessionId: "fixture-target", repositoryPath: root, sessionFile: null,
    status: "active", startedAt: now, lastEventAt: now, lastEventId: "fixture",
  } } });
  const sender = resolve(root, "sender.py"), alias = resolve(root, "sender-alias");
  await writeFile(sender, '#!/this/shebang/must/not/run\nprint(\'{"ok":true}\')\n', { mode: 0o700 });
  await chmod(sender, 0o722);
  await assert.rejects(configureGuardianRouting(paths, "fixture-target", sender), /owner-controlled/);
  await chmod(sender, 0o700); await symlink(sender, alias);
  await assert.rejects(configureGuardianRouting(paths, "fixture-target", alias));
  const config = await configureGuardianRouting(paths, "fixture-target", sender);
  await recordIncident(paths, { incidentType: "sync.attention", severity: "yellow", reasonCode: "fixture", summary: "fixture" });
  await assert.rejects(dispatchGuardianIncidents(paths), /Could not execute Guardian sender/);
  workflow.executables.python = "/usr/bin/python3";
  await writeJsonAtomic(workflowFixturePath(paths), workflow);
  assert.equal((await dispatchGuardianIncidents(paths)).dispatched, 1);
  await chmod(config.senderScript, 0o722);
  assert.equal((await guardianStatus(paths)).senderIntegrityValid, false);
  await chmod(config.senderScript, 0o700);
  await saveWorkflowFixture(paths, "host-b");
  const status = await guardianStatus(paths);
  assert.equal(status.ready, false); assert.equal(status.primaryIdentityValid, false);
});
