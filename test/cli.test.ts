import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { inventoryPath } from "../src/inventory.js";
import { writeJsonAtomic } from "../src/storage.js";

// Run emitted tests from current .test.ts sources or a clean dist directory:
// tsc does not remove old emitted tests when their source files are deleted.
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const options = { timeout: 30_000 };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sync-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), first = join(root, "first"), second = join(root, "second");
  await Promise.all([home, first, second].map(p => mkdir(p, { mode: 0o700 })));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_SYNC_HOME: join(root, "app"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const run = (...args: string[]) => execute(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const json = async (...args: string[]) => JSON.parse((await run(...args)).stdout);
  const git = async (cwd: string, ...args: string[]) => (await execute("/usr/bin/git", ["-C", cwd,
    "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args], {
    cwd: root, env, encoding: "utf8", timeout: 10_000,
  })).stdout;
  const repo = async (path: string, name: string) => {
    await mkdir(path, { recursive: true });
    await git(path, "init", "--quiet", "--template=", "--initial-branch=main");
    await git(path, "config", "user.name", "Fixture");
    await git(path, "config", "user.email", "fixture@example.invalid");
    await git(path, "remote", "add", "origin", `https://github.com/example/${name}.git`);
    await writeFile(join(path, "tracked"), "committed\n");
    await git(path, "add", "tracked");
    await git(path, "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
    await writeFile(join(path, "tracked"), "dirty\n");
    await writeFile(join(path, "untracked"), "preserve\n");
  };
  return { root, home, first, second, paths, run, json, repo, git };
}

// Reusable read-only oracle: source content, index, refs, config and metadata
// remain unchanged (atime is intentionally excluded because inspection reads).
async function snapshot(root: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), s = await stat(path);
      rows.push([path, s.mode, s.size, s.mtimeMs, s.ctimeMs, s.ino,
        s.isFile() ? (await readFile(path)).toString("base64") : null]);
      if (s.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return rows;
}

test("discover adds roots, preserves exclusions/registry and all source bytes and metadata", options, async t => {
  const f = await fixture(t);
  const a = join(f.first, "alpha"), b = join(f.second, "beta"), excluded = join(f.second, "skip", "hidden");
  await f.repo(a, "alpha"); await f.repo(b, "beta"); await f.repo(excluded, "hidden");
  await f.json("init", "--root", f.first, "--exclude", "skip", "--host-id", "host-a");
  await f.json("repo", "enable", a);
  const registry = await readFile(f.paths.registryFile), identity = await readFile(f.paths.hostFile);
  const before = [await snapshot(f.first), await snapshot(f.second)];
  const inventory = await f.json("discover", "--root", f.second, "--root", f.first);
  assert.deepEqual(inventory.repositories.map((r: { path: string }) => r.path).sort(), [a, b].sort());
  assert.deepEqual(JSON.parse(await readFile(f.paths.configFile, "utf8")), {
    schemaVersion: 1, roots: [f.first, f.second].sort(), excludedDirectories: ["skip"],
  });
  assert.deepEqual(await readFile(f.paths.registryFile), registry);
  assert.deepEqual(await readFile(f.paths.hostFile), identity);
  assert.equal((await f.json("discover")).repositories.length, 2);
  assert.deepEqual([await snapshot(f.first), await snapshot(f.second)], before);
  assert.equal((await f.json("registry", "status")).repositories["github.com/example/alpha"].mode, "enabled");
  await f.json("repo", "disable", b);
  assert.equal((await f.json("registry", "status")).repositories["github.com/example/beta"].mode, "disabled");
});

test("failed discovery and invalid options cannot replace existing config, inventory, identity or registry", options, async t => {
  const f = await fixture(t);
  await f.json("init", "--root", f.first, "--host-id", "host-a");
  await f.json("discover");
  const files = [f.paths.configFile, f.paths.hostFile, f.paths.registryFile, inventoryPath(f.paths, "host-a")];
  const before = await Promise.all(files.map(p => readFile(p)));
  for (const args of [["discover", "--root", f.second, "--root", join(f.root, "missing")],
    ["discover", "--root"], ["discover", "--exclude", "other"], ["init", "--force"],
    ["init", "--root", f.second]]) {
    await assert.rejects(f.run(...args));
    assert.deepEqual(await Promise.all(files.map(p => readFile(p))), before);
  }
});

test("public CLI loads real modules, exposes current commands and rejects retired commands", options, async t => {
  const f = await fixture(t);
  const help = (await f.run("--help")).stdout;
  assert.match(help, /guardian register SESSION_ID --rmux-target TARGET/);
  assert.doesNotMatch(help, /registry remote|registry key|inbox|reconcile|--force/);
  await f.json("init", "--root", f.first, "--host-id", "host-a");
  await f.json("discover");
  assert.deepEqual(await f.json("sync", "upstream", "status"), { config: null, status: null });
  assert.equal((await f.json("sync", "status")).config, null);
  assert.equal((await f.json("guardian", "status")).configured, false);
  await f.json("daemon", "once");
  await f.json("daemon", "status");
  await f.json("doctor", "daemon-lock");
  await f.json("incidents", "list");
  await f.json("provenance", "show");
  for (const args of [["once"], ["run"], ["inbox", "remote", "status"], ["reconcile"],
    ["registry", "remote", "status"], ["registry", "key", "init"], ["repo", "identity", "status"],
    ["guardian", "register", "short-id"], ["sync", "once"]]) await assert.rejects(f.run(...args));
});

test("guardian register CLI attaches to an existing normal session without modifying its transcript", options, async t => {
  const f = await fixture(t);
  await f.json("init", "--root", f.first, "--host-id", "host-a");
  const id = "11111111-2222-4333-8444-555555555555";
  const runtime = join(f.home, ".pi", "agent", "runtime"), sessionFile = join(f.home, "session.jsonl");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id, cwd: f.root }) + "\n" +
    JSON.stringify({ type: "message", content: "unchanged fixture transcript" }) + "\n", { mode: 0o600 });
  await writeJsonAtomic(join(runtime, `${process.pid}.jsonl`), {
    type: "pi_runtime", pid: process.pid, sessionPath: sessionFile, cwd: f.root,
  });
  const before = await snapshot(f.home);
  const result = await f.json("guardian", "register", id, "--rmux-target", "existing:1.0");
  assert.equal(result.sessionId, id);
  assert.equal(result.profile, "standard-pi");
  assert.equal(result.rmuxTarget, "existing:1.0");
  assert.equal((await f.json("guardian", "status")).running, true);
  assert.deepEqual(await snapshot(f.home), before);
});


test("canonical repo enable/disable/ignore changes the real entry, never a cwd-derived file URL", options, async t => {
  const f = await fixture(t), repository = join(f.first, "selected"), remote = "github.com/example/selected";
  await f.repo(repository, "selected");
  await f.json("init", "--root", f.first, "--host-id", "host-a");
  await f.json("discover");
  const before = await snapshot(repository);
  for (const [action, mode] of [["enable", "enabled"], ["disable", "disabled"], ["ignore", "ignored"], ["enable", "enabled"]]) {
    const updated = await f.json("repo", action!, remote);
    assert.equal(updated.canonicalRemote, remote);
    assert.equal(updated.mode, mode);
    const registry = await f.json("registry", "status");
    assert.deepEqual(Object.keys(registry.repositories), [remote]);
    assert.equal(registry.repositories[remote].mode, mode);
  }
  assert.deepEqual(await snapshot(repository), before);
});
