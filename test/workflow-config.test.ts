import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { createHostIdentity, saveHostIdentity } from "../src/host.js";
import { writeJsonAtomic } from "../src/storage.js";
import { loadWorkflowConfig, workflowPeer, type WorkflowConfig } from "../src/workflow-config.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workflow-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: root });
  await saveHostIdentity(paths, createHostIdentity("office-73"));
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const key = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), der.subarray(-32)]);
  const config: WorkflowConfig = { schemaVersion: 1, primaryHostId: "office-73", peers: {
    "field-91": { host: "Field.Example.test", user: "team-user", knownHosts: join(root, "known hosts"),
      fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`,
      nodeExecutable: "/opt/runtime with spaces/node", cliEntrypoint: "/opt/sync tool/cli.js" },
  }, executables: { githubCli: "/opt/tools/gh", python: "/opt/tools/python3" } };
  const file = join(root, "workflow.json");
  const save = (value: unknown = config) => writeJsonAtomic(file, value);
  return { root, paths, file, config, save };
}
const options = { timeout: 15_000 };
test("absent workflow uses local host and portable executable defaults, without creating configuration", options, async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadWorkflowConfig(f.paths), { schemaVersion: 1, primaryHostId: "office-73", peers: {},
    executables: { githubCli: "/usr/bin/gh", python: "/usr/bin/python3" } });
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  await assert.rejects(workflowPeer(f.paths, "field-91"), /not configured/);
});
test("explicit arbitrary endpoints are preserved and optional executables default individually", options, async t => {
  const f = await fixture(t); await f.save();
  assert.deepEqual(await loadWorkflowConfig(f.paths), f.config);
  assert.deepEqual(await workflowPeer(f.paths, "field-91"), f.config.peers["field-91"]);
  await f.save({ ...f.config, executables: undefined });
  assert.deepEqual((await loadWorkflowConfig(f.paths)).executables, { githubCli: "/usr/bin/gh", python: "/usr/bin/python3" });
  await f.save({ ...f.config, executables: { python: "/opt/custom/python" } });
  assert.deepEqual((await loadWorkflowConfig(f.paths)).executables, { githubCli: "/usr/bin/gh", python: "/opt/custom/python" });
});
test("workflow validates schema, safe identifiers, endpoint fields and executable paths", options, async t => {
  const f = await fixture(t), peer = f.config.peers["field-91"]!;
  const invalid: unknown[] = [null, [], {}, { ...f.config, schemaVersion: 2 }, { ...f.config, primaryHostId: "../host" }, { ...f.config, primaryHostId: "host\n" },
    { ...f.config, peers: [] }, { ...f.config, peers: { "bad/id": peer } }, { ...f.config, command: "exec anything" },
    ...[null, [], { python: "python3" }, { githubCli: "~/bin/gh" }, { python: "/bin/../python" },
      { python: "/bin/python\n" }, { command: "/bin/sh" }].map(executables => ({ ...f.config, executables }))];
  for (const change of [{ host: "host\n" }, { user: "user\n" }, { host: "-option" }, { host: "user@host" }, { host: "host:22" }, { host: "host/path" },
    { host: "host name" }, { host: "a..b" }, { user: "-user" }, { user: "a;id" }, { user: "a b" },
    { fingerprint: "SHA256:invalid" }, { knownHosts: "relative" }, { knownHosts: "/tmp/%h" }, { knownHosts: "/tmp/${HOME}" },
    { nodeExecutable: "node" }, { cliEntrypoint: "~/cli.js" }, { port: 2222 }, { proxyCommand: "/bin/sh" }])
    invalid.push({ ...f.config, peers: { "field-91": { ...peer, ...change } } });
  for (const value of invalid) { await f.save(value); await assert.rejects(loadWorkflowConfig(f.paths), /Invalid workflow/); }
});
test("workflow accepts zero or one peer, rejects multiple peers, and never resolves inherited peer properties", options, async t => {
  const f = await fixture(t), peer = f.config.peers["field-91"]!;
  for (const count of [0, 1, 2, 100]) {
    await f.save({ ...f.config, peers: Object.fromEntries(Array.from({ length: count }, (_, n) => [`host-${n}`, peer])) });
    if (count > 1) await assert.rejects(loadWorkflowConfig(f.paths), /Invalid workflow/);
    else assert.equal(Object.keys((await loadWorkflowConfig(f.paths)).peers).length, count);
  }
  await f.save();
  await assert.rejects(workflowPeer(f.paths, "constructor"), /not configured/);
  await assert.rejects(workflowPeer(f.paths, "../host"), /not configured/);
});
test("workflow reads only bounded owned single-link regular 0600 files, never follows links or opens FIFOs", options, async t => {
  const f = await fixture(t); await f.save();
  for (const mode of [0o644, 0o620, 0o700]) {
    await chmod(f.file, mode); await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/);
  }
  await chmod(f.file, 0o600);
  const alias = join(f.root, "alias"); await link(f.file, alias);
  await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/); await rm(alias);
  await rm(f.file); await writeJsonAtomic(alias, f.config); await symlink(alias, f.file);
  await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/); await rm(f.file);
  await symlink(join(f.root, "missing"), f.file);
  await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/); await rm(f.file);
  await mkdir(f.file); await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/); await rm(f.file, { recursive: true });
  await promisify(execFile)("/usr/bin/mkfifo", [f.file], { timeout: 2000 });
  await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/); await rm(f.file);
  await writeFile(f.file, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(loadWorkflowConfig(f.paths), /Unsafe/);
  await f.save(); await writeFile(f.file, "{broken json");
  await assert.rejects(loadWorkflowConfig(f.paths), SyntaxError);
});
// Verified offline method: generate real ed25519 public-key blobs and derived
// fingerprints; fixture config never reads the operator's files or contacts SSH.
// Pitfall: a dangling symlink is unsafe configuration, not an absent config.
