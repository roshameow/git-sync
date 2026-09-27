import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { directGit, receiveCommittedBranch } from "../src/direct-sync.js";

const execFileAsync = promisify(execFile);
const branch = "feature/local-sync";
const deadline = { timeoutMs: 10_000 };
const testOptions = { timeout: 30_000 };

// Independent real-Git oracle: no inherited Git configuration, hooks, or network.
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-C", cwd,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
    },
  })).stdout;
}

async function initWorktree(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await git(path, "init", "--quiet", "--template=", "--object-format=sha1", `--initial-branch=${branch}`);
  await git(path, "config", "user.name", "Direct Sync Test");
  await git(path, "config", "user.email", "direct-sync@example.invalid");
  await git(path, "config", "commit.gpgSign", "false");
  await git(path, "config", "core.autocrlf", "false");
}

async function commit(source: string, content: string): Promise<string> {
  await writeFile(join(source, "tracked.bin"), content);
  await git(source, "add", "tracked.bin");
  await git(source, "commit", "--quiet", "-m", content.trim());
  return (await git(source, "rev-parse", "HEAD")).trim();
}

async function fixture(context: TestContext) {
  // Canonicalize macOS /var -> /private/var before passing the private store parent.
  const root = await realpath(await mkdtemp(join(tmpdir(), "git-sync-direct-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const source = join(root, "source");
  const parent = join(root, "app");
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal((await stat(parent)).uid, process.getuid!());
  await initWorktree(source);
  const first = await commit(source, "first committed bytes\n");
  const store = join(parent, "history.git");
  const input = { store, source, branch, ...deadline };
  return { root, source, parent, store, first, input };
}

function receivedRef(oid: string): string {
  return `refs/received/${createHash("sha256").update(branch).digest("hex")}/${oid}`;
}

async function assertReceived(store: string, oids: readonly string[]): Promise<void> {
  const refs = await git(store, "for-each-ref", "--format=%(refname) %(objectname)");
  assert.deepEqual(refs.trim().split("\n").sort(),
    oids.map(oid => `${receivedRef(oid)} ${oid}`).sort());
  for (const oid of oids) {
    assert.equal((await git(store, "rev-parse", "--verify", receivedRef(oid))).trim(), oid);
    assert.equal((await git(store, "cat-file", "-t", oid)).trim(), "commit");
  }
}

async function rawSnapshot(source: string) {
  const paths = ["tracked.bin", "untracked.bin", ".git/index"];
  const files = await Promise.all(paths.map(async path => {
    const bytes = await readFile(join(source, path));
    return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  return {
    files,
    head: await readFile(join(source, ".git/HEAD")),
    oid: await git(source, "rev-parse", "HEAD"),
    refs: await git(source, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: await git(source, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  };
}

test("directGit returns real stdout and rejects Git failures and invalid deadlines", testOptions, async context => {
  const { source, first } = await fixture(context);
  assert.equal(await directGit(source, ["rev-parse", "HEAD"], deadline), `${first}\n`);
  await assert.rejects(directGit(source, ["rev-parse", "--verify", "refs/heads/missing"], deadline),
    /Direct sync Git failed/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(directGit(source, ["rev-parse", "HEAD"], { signal: controller.signal }), /cancelled/);
  for (const timeoutMs of [0, -1, 1.5, 300_001, Number.NaN]) {
    await assert.rejects(directGit(source, ["rev-parse", "HEAD"], { timeoutMs }), /Invalid Git deadline/);
  }
});

test("initial receive stores the exact committed tip under its immutable received identity", testOptions, async context => {
  const { source, store, first, input } = await fixture(context);
  const result = await receiveCommittedBranch(input);
  assert.equal(result.branch, branch);
  assert.equal(result.oid, first);
  assert.equal(result.receivedRef, receivedRef(first));
  assert.equal(result.changed, true);
  assert.equal(result.worktreeUpdated, false);
  assert.equal(new Date(result.completedAt).toISOString(), result.completedAt);
  assert.equal((await git(store, "rev-parse", "--is-bare-repository")).trim(), "true");
  assert.equal((await git(store, "rev-parse", "--show-object-format")).trim(), "sha1");
  assert.equal((await stat(store)).mode & 0o777, 0o700);
  assert.equal(await git(store, "show", `${result.receivedRef}:tracked.bin`),
    await git(source, "show", `${first}:tracked.bin`));
  await assertReceived(store, [first]);
  await assert.rejects(readFile(join(store, "FETCH_HEAD")), { code: "ENOENT" });
});

test("repeating an unchanged branch reports changed:false without adding or moving refs", testOptions, async context => {
  const { store, first, input } = await fixture(context);
  const initial = await receiveCommittedBranch(input);
  const repeated = await receiveCommittedBranch(input);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.oid, initial.oid);
  assert.equal(repeated.receivedRef, initial.receivedRef);
  assert.equal(repeated.worktreeUpdated, false);
  await assertReceived(store, [first]);
});

test("a new commit reports changed:true and retains the previous received ref and history", testOptions, async context => {
  const { source, store, first, input } = await fixture(context);
  await receiveCommittedBranch(input);
  const second = await commit(source, "second committed bytes\n");
  const result = await receiveCommittedBranch(input);
  assert.equal(result.changed, true);
  assert.equal(result.oid, second);
  assert.equal(result.receivedRef, receivedRef(second));
  await assertReceived(store, [first, second]);
  assert.equal(await git(store, "rev-list", result.receivedRef), `${second}\n${first}\n`);
  assert.equal(await git(store, "show", `${receivedRef(first)}:tracked.bin`), "first committed bytes\n");
});

test("source reset and divergence preserve both previously received tips and their histories", testOptions, async context => {
  const { source, store, first, input } = await fixture(context);
  await receiveCommittedBranch(input);
  const second = await commit(source, "old line of history\n");
  await receiveCommittedBranch(input);

  await git(source, "reset", "--hard", first);
  const reset = await receiveCommittedBranch(input);
  assert.equal(reset.oid, first);
  assert.equal(reset.changed, false);
  await assertReceived(store, [first, second]);

  const divergent = await commit(source, "divergent line of history\n");
  assert.notEqual(divergent, second);
  assert.equal(await git(source, "rev-list", "HEAD"), `${divergent}\n${first}\n`);
  const result = await receiveCommittedBranch(input);
  assert.equal(result.oid, divergent);
  assert.equal(result.changed, true);
  await assertReceived(store, [first, second, divergent]);
  assert.equal(await git(store, "rev-list", receivedRef(second)), `${second}\n${first}\n`);
  assert.equal(await git(store, "rev-list", receivedRef(divergent)), `${divergent}\n${first}\n`);
  assert.equal(await git(store, "show", `${receivedRef(second)}:tracked.bin`), "old line of history\n");
  assert.equal(await git(store, "show", `${receivedRef(first)}:tracked.bin`), "first committed bytes\n");
});

test("dirty tracked/untracked files and raw index bytes and SHA-256 remain unchanged", testOptions, async context => {
  const { source, store, first, input } = await fixture(context);
  await writeFile(join(source, "tracked.bin"), Buffer.from([0, 255, 13, 10, 65]));
  await git(source, "add", "tracked.bin");
  await writeFile(join(source, "tracked.bin"), Buffer.from([0, 254, 13, 10, 66, 128]));
  await writeFile(join(source, "untracked.bin"), Buffer.from([255, 0, 13, 10, 127, 129]));
  const before = await rawSnapshot(source);
  assert.equal(before.status, "MM tracked.bin\0?? untracked.bin\0");

  assert.equal((await receiveCommittedBranch(input)).changed, true);
  assert.deepEqual(await rawSnapshot(source), before);
  assert.equal((await receiveCommittedBranch(input)).changed, false);
  assert.deepEqual(await rawSnapshot(source), before);
  await assertReceived(store, [first]);
  assert.equal(await git(store, "show", `${receivedRef(first)}:tracked.bin`), "first committed bytes\n");
  assert.equal(await git(store, "ls-tree", "--name-only", first), "tracked.bin\n");
});

test("an interrupted exact publication lock is reported and preserved without deleting old refs", testOptions, async context => {
  const { source, store, first, input } = await fixture(context);
  await receiveCommittedBranch(input);
  const second = await commit(source, "second tip awaiting local ref\n");
  const lock = join(store, `${receivedRef(second)}.lock`);
  await writeFile(lock, "interrupted writer evidence\n", { mode: 0o600, flag: "wx" });
  await assert.rejects(receiveCommittedBranch(input), /preserve exact lock for explicit recovery/);
  assert.equal(await readFile(lock, "utf8"), "interrupted writer evidence\n");
  await assertReceived(store, [first]);
});

test("invalid or missing branch and missing source failures preserve all received refs", testOptions, async context => {
  const { root, source, store, first, input } = await fixture(context);
  await receiveCommittedBranch(input);
  const second = await commit(source, "second committed bytes\n");
  await receiveCommittedBranch(input);
  for (const invalid of [
    { ...input, branch: "-invalid" },
    { ...input, branch: "bad..branch" },
    { ...input, branch: "missing" },
    { ...input, source: join(root, "missing-source") },
  ]) {
    await assert.rejects(receiveCommittedBranch(invalid), /Invalid direct sync input|Direct sync Git failed|Source branch missing/);
    await assertReceived(store, [first, second]);
    assert.equal(await git(store, "rev-list", receivedRef(second)), `${second}\n${first}\n`);
  }
  assert.equal((await receiveCommittedBranch(input)).changed, false);
});

test("refuses to adopt an existing worktree or nonempty directory without changing their contents", testOptions, async context => {
  const { parent, input } = await fixture(context);
  const worktree = join(parent, "existing-worktree");
  await initWorktree(worktree);
  await commit(worktree, "existing user history\n");
  await writeFile(join(worktree, "untracked.bin"), Buffer.from([0, 255, 42]));
  const before = await rawSnapshot(worktree);
  const config = await readFile(join(worktree, ".git/config"));
  await assert.rejects(receiveCommittedBranch({ ...input, store: worktree }), /Refuse to adopt existing repository/);
  assert.deepEqual(await rawSnapshot(worktree), before);
  assert.deepEqual(await readFile(join(worktree, ".git/config")), config);
  await assert.rejects(readFile(join(worktree, "direct-sync-store-v1")), { code: "ENOENT" });
  assert.equal((await git(worktree, "rev-parse", "--is-bare-repository")).trim(), "false");

  const directory = join(parent, "existing-directory");
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from([0, 255, 10, 128]);
  await writeFile(join(directory, "keep.bin"), bytes);
  await assert.rejects(receiveCommittedBranch({ ...input, store: directory }), /Refuse to adopt existing repository/);
  assert.deepEqual(await readdir(directory), ["keep.bin"]);
  assert.deepEqual(await readFile(join(directory, "keep.bin")), bytes);
});
