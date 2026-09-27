import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { applyReceivedFastForward } from "../src/direct-sync-apply.js";
import { receiveCommittedBranch } from "../src/direct-sync.js";

const exec = promisify(execFile);
const branch = "feature/apply";
const options = { timeout: 60_000 };
// Independent real-Git oracle, bounded and offline; does not use directGit.
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  })).stdout;
}
async function commit(repo: string, contents: string): Promise<string> {
  await writeFile(join(repo, "tracked.txt"), contents);
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", contents);
  return (await git(repo, "rev-parse", "HEAD")).trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "git-sync-apply-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app"), source = join(root, "source"), repository = join(root, "business");
  await mkdir(app, { mode: 0o700 }); await chmod(app, 0o700);
  await mkdir(source);
  await git(source, "init", "--quiet", "--template=", "--object-format=sha1", `--initial-branch=${branch}`);
  await git(source, "config", "user.name", "Apply Test");
  await git(source, "config", "user.email", "apply@example.invalid");
  await git(source, "config", "commit.gpgSign", "false");
  await writeFile(join(source, ".gitignore"), "ignored.txt\ncache/\n");
  const first = await commit(source, "first\n");
  await git(root, "clone", "--quiet", "--no-hardlinks", "--template=", source, repository);
  await git(repository, "config", "user.name", "Apply Test");
  await git(repository, "config", "user.email", "apply@example.invalid");
  await git(repository, "config", "commit.gpgSign", "false");
  const store = join(app, "received.git"), intentPath = join(app, "apply-intent.json");
  const receive = () => receiveCommittedBranch({ store, source, branch, timeoutMs: 10_000 });
  await receive();
  await writeFile(join(source, "new.txt"), "new committed file\n");
  const oid = await commit(source, "second\n");
  await receive();
  const input = { repository, store, branch, oid, intentPath };
  return { root, app, source, repository, store, intentPath, first, oid, input, receive };
}
async function absent(path: string): Promise<void> { await assert.rejects(lstat(path), { code: "ENOENT" }); }
async function snapshot(repo: string) {
  // Objects may be imported, but no ref/index/worktree/reflog/FETCH_HEAD writes
  // are allowed for non-fast-forward outcomes. Persisted regression oracle.
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (path === ".git/objects") continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
      // Snapshot symlinks themselves: never follow a worktree link outside the repository.
      else if (entry.isSymbolicLink()) files[path] = `symlink:${await readlink(join(dir, entry.name))}`;
      else files[path] = createHash("sha256").update(await readFile(join(dir, entry.name))).digest("hex");
    }
  }
  await walk(repo);
  return files;
}
async function savedIntent(f: Awaited<ReturnType<typeof fixture>>, head = f.first) {
  const gitDir = await realpath(join(f.repository, ".git"));
  const repositoryStat = await lstat(f.repository), gitStat = await lstat(gitDir);
  return { version: 1, repository: f.repository, repositoryId: `${repositoryStat.dev}:${repositoryStat.ino}`,
    gitDir, gitDirId: `${gitStat.dev}:${gitStat.ino}`, commonDir: gitDir, store: f.store, branch, head, target: f.oid };
}

test("clean descendant updates both worktree and index; import preserves FETCH_HEAD and unrelated refs; no hooks", options, async t => {
  const f = await fixture(t);
  const hooks = join(f.root, "hooks"), sentinel = join(f.root, "hook-ran");
  await mkdir(hooks);
  for (const name of ["post-merge", "post-checkout", "pre-merge-commit", "reference-transaction", "pre-auto-gc"]) {
    await writeFile(join(hooks, name), `#!/bin/sh\nprintf ran >> '${sentinel}'\n`, { mode: 0o700 });
  }
  await git(f.repository, "config", "core.hooksPath", hooks);
  await git(f.repository, "config", "core.fsmonitor", join(hooks, "post-merge"));
  await git(f.repository, "config", "merge.autostash", "true");
  await git(f.repository, "config", "merge.verifySignatures", "true");
  await git(f.repository, "config", "fetch.prune", "true");
  await git(f.repository, "config", "fetch.pruneTags", "true");
  await git(f.repository, "tag", "business-only", f.first);
  await mkdir(join(f.repository, "cache"));
  await writeFile(join(f.repository, "cache/output.txt"), "non-colliding ignored output\n");
  const fetchHead = join(f.repository, ".git/FETCH_HEAD");
  await writeFile(fetchHead, "existing fetch observation\n");
  const remoteBefore = await git(f.repository, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags");
  const beforeCancelled = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward({ ...f.input, signal: AbortSignal.abort() })).status, "needs-recovery");
  assert.deepEqual(await snapshot(f.repository), beforeCancelled);
  await absent(f.intentPath);
  assert.equal((await applyReceivedFastForward({ ...f.input, signal: new AbortController().signal })).status, "fast-forwarded");
  assert.equal((await git(f.repository, "rev-parse", "HEAD")).trim(), f.oid);
  assert.equal(await readFile(join(f.repository, "tracked.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(f.repository, "new.txt"), "utf8"), "new committed file\n");
  assert.equal(await git(f.repository, "write-tree"), await git(f.source, "rev-parse", "HEAD^{tree}"));
  assert.equal(await git(f.repository, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(await readFile(fetchHead, "utf8"), "existing fetch observation\n");
  assert.equal(await git(f.repository, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags"), remoteBefore);
  await absent(f.intentPath); await absent(sentinel);
  assert.equal(await readFile(join(f.repository, "cache/output.txt"), "utf8"), "non-colliding ignored output\n");
  assert.equal((await applyReceivedFastForward(f.input)).status, "up-to-date");
  await absent(f.intentPath); await absent(sentinel);
});

test("unrelated untracked file and nested log survive fast-forward and same-HEAD retry byte-for-byte", options, async t => {
  const f = await fixture(t);
  const contents = Buffer.from([0, 255, 13, 10, 128, 42]);
  await mkdir(join(f.repository, "logs/nested"), { recursive: true });
  for (const path of ["local.bin", "logs/nested/run.log"]) await writeFile(join(f.repository, path), contents);
  assert.equal(await git(f.repository, "ls-files", "--others", "--exclude-standard"), "local.bin\nlogs/nested/run.log\n");
  assert.equal((await applyReceivedFastForward(f.input)).status, "fast-forwarded");
  assert.equal((await git(f.repository, "rev-parse", "HEAD")).trim(), f.oid);
  assert.equal(await git(f.repository, "write-tree"), await git(f.source, "rev-parse", "HEAD^{tree}"));
  assert.equal(await readFile(join(f.repository, "tracked.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(f.repository, "new.txt"), "utf8"), "new committed file\n");
  for (const path of ["local.bin", "logs/nested/run.log"]) assert.deepEqual(await readFile(join(f.repository, path)), contents);
  await absent(f.intentPath);
  const before = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward(f.input)).status, "up-to-date");
  assert.deepEqual(await snapshot(f.repository), before);
  await absent(f.intentPath);
});

for (const kind of ["ancestor file/target directory", "directory/target file", "symlink ancestor"] as const) {
  test(`untracked ${kind} collision blocks without changing HEAD, index or files`, options, async t => {
    const f = await fixture(t);
    const outside = join(f.root, "outside");
    if (kind === "directory/target file") {
      await mkdir(join(f.repository, "new.txt"));
      await writeFile(join(f.repository, "new.txt/keep.bin"), Buffer.from([0, 255, 13, 10]));
    } else {
      await mkdir(join(f.source, "incoming"));
      await writeFile(join(f.source, "incoming/added.txt"), "remote addition\n");
      f.input.oid = await commit(f.source, "third\n"); await f.receive();
      if (kind === "ancestor file/target directory") await writeFile(join(f.repository, "incoming"), "local ancestor\n");
      else {
        await mkdir(outside);
        await writeFile(join(outside, "keep.bin"), Buffer.from([0, 255, 13, 10]));
        await symlink(outside, join(f.repository, "incoming"));
      }
    }
    const before = await snapshot(f.repository);
    const outsideBefore = kind === "symlink ancestor" ? await snapshot(outside) : undefined;
    assert.equal((await applyReceivedFastForward(f.input)).status, "blocked-dirty");
    assert.deepEqual(await snapshot(f.repository), before);
    assert.equal((await git(f.repository, "rev-parse", "HEAD")).trim(), f.first);
    if (outsideBefore) assert.deepEqual(await snapshot(outside), outsideBefore);
    await absent(f.intentPath);
  });
}

for (const [kind, target, local] of [
  ["case", "new.txt", "NEW.TXT"],
  ["Unicode normalization", "caf\u00e9.txt", "cafe\u0301.txt"],
] as const) {
  test(`untracked ${kind} alias collision preserves HEAD, index and files`, options, async t => {
    const f = await fixture(t);
    await writeFile(join(f.repository, local), "local alias must survive\n");
    // Probe real filesystem aliasing, not core.ignorecase/core.precomposeunicode.
    let alias;
    try { alias = await lstat(join(f.repository, target)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      t.skip(`Filesystem is ${kind === "case" ? "case-sensitive" : "Unicode-normalization-sensitive"}; names do not collide`);
      return;
    }
    const original = await lstat(join(f.repository, local));
    assert.equal(alias.dev, original.dev);
    assert.equal(alias.ino, original.ino);
    await writeFile(join(f.source, target), "remote alias target\n");
    f.input.oid = await commit(f.source, "third\n"); await f.receive();
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "blocked-dirty");
    assert.deepEqual(await snapshot(f.repository), before);
    assert.equal((await git(f.repository, "rev-parse", "HEAD")).trim(), f.first);
    await absent(f.intentPath);
  });
}

test("large unrelated ignored build output is not enumerated during clean fast-forward", options, async t => {
  const f = await fixture(t);
  const relative = ["cache", ...Array.from({ length: 5 }, (_, i) => "d".repeat(100) + i)].join("/");
  const directory = join(f.repository, relative);
  await mkdir(directory, { recursive: true });
  const names = Array.from({ length: 2000 }, (_, i) => "f".repeat(55) + i);
  assert.ok(names.reduce((n, name) => n + Buffer.byteLength(relative + "/" + name + "\0"), 0) > 1024 * 1024);
  for (let i = 0; i < names.length; i += 50)
    await Promise.all(names.slice(i, i + 50).map(name => writeFile(join(directory, name), "keep ignored output\n")));
  assert.equal((await applyReceivedFastForward(f.input)).status, "fast-forwarded");
  assert.equal((await readdir(directory)).length, names.length);
  assert.equal(await readFile(join(directory, names[0]!), "utf8"), "keep ignored output\n");
  await absent(f.intentPath);
});

test("tracked, staged, untracked and ignored target collisions preserve exact bytes/index", options, async t => {
  const f = await fixture(t);
  for (const kind of ["tracked", "staged", "untracked", "ignored"] as const) {
    if (kind === "tracked" || kind === "staged") {
      await writeFile(join(f.repository, "tracked.txt"), `local ${kind}\n`);
      if (kind === "staged") await git(f.repository, "add", "tracked.txt");
    } else if (kind === "untracked") await writeFile(join(f.repository, "new.txt"), "do not replace\n");
    else {
      await writeFile(join(f.source, "ignored.txt"), "remote ignored name now tracked\n");
      await git(f.source, "add", "-f", "ignored.txt");
      f.input.oid = await commit(f.source, "third\n"); await f.receive();
      await writeFile(join(f.repository, "ignored.txt"), "local ignored data\n");
    }
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "blocked-dirty", kind);
    assert.deepEqual(await snapshot(f.repository), before, kind);
    await absent(f.intentPath);
    // Test-fixture cleanup only, not an apply implementation operation.
    if (kind === "tracked" || kind === "staged") {
      await git(f.repository, "restore", "--source=HEAD", "--staged", "--worktree", "tracked.txt");
    } else await rm(join(f.repository, kind === "untracked" ? "new.txt" : "ignored.txt"));
  }
});

test("local-ahead and divergence do not write refs, index, worktree or intent", options, async t => {
  const f = await fixture(t);
  const local = await commit(f.repository, "local continuation\n");
  const before = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward({ ...f.input, oid: f.first })).status, "local-ahead");
  assert.deepEqual(await snapshot(f.repository), before);
  assert.equal((await applyReceivedFastForward(f.input)).status, "blocked-diverged");
  assert.deepEqual(await snapshot(f.repository), before);
  assert.equal((await git(f.repository, "rev-parse", "HEAD")).trim(), local);
  await absent(f.intentPath);
});

test("wrong symbolic branch and detached HEAD block without importing target", options, async t => {
  const f = await fixture(t);
  for (const args of [["switch", "-c", "other"], ["switch", "--detach", f.first]]) {
    await git(f.repository, ...args);
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "blocked-branch");
    assert.deepEqual(await snapshot(f.repository), before);
    await assert.rejects(git(f.repository, "cat-file", "-e", f.oid));
    await absent(f.intentPath);
  }
});

test("operation markers and locks are never deleted, even if apparently stale", options, async t => {
  const f = await fixture(t);
  for (const name of ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"]) {
    const path = join(f.repository, ".git", name);
    await writeFile(path, "interrupted evidence\n");
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery", name);
    assert.deepEqual(await snapshot(f.repository), before);
    await absent(f.intentPath);
    await rm(path); // Only our test-owned marker.
  }
});

test("sparse/hidden index entries and checkout filters block before status can execute a filter", options, async t => {
  const f = await fixture(t);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    await git(f.repository, "update-index", `--${flag}`, "tracked.txt");
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
    assert.deepEqual(await snapshot(f.repository), before);
    await git(f.repository, "update-index", `--no-${flag}`, "tracked.txt");
  }
  await git(f.repository, "config", "core.sparseCheckout", "true");
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  await git(f.repository, "config", "--unset", "core.sparseCheckout");
  const sentinel = join(f.root, "filter-ran");
  // --template= legitimately leaves .git/info absent.
  await mkdir(join(f.repository, ".git/info"), { recursive: true });
  await writeFile(join(f.repository, ".git/info/attributes"), "tracked.txt filter=sideeffect\n");
  for (const name of ["clean", "smudge"]) await git(f.repository, "config", `filter.sideeffect.${name}`, `touch '${sentinel}'; cat`);
  const before = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.deepEqual(await snapshot(f.repository), before);
  await absent(sentinel); await absent(f.intentPath);
});

test("target submodule gitlinks are refused without checkout", options, async t => {
  const f = await fixture(t);
  await git(f.source, "update-index", "--add", "--cacheinfo", `160000,${f.first},module`);
  await git(f.source, "commit", "--quiet", "-m", "gitlink");
  f.input.oid = (await git(f.source, "rev-parse", "HEAD")).trim(); await f.receive();
  const before = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.deepEqual(await snapshot(f.repository), before);
  await absent(f.intentPath); await absent(join(f.repository, "module"));
});

test("pre-existing ambiguous/partial/mismatched intents remain byte-identical with no import or retry", options, async t => {
  const f = await fixture(t), intent = await savedIntent(f);
  for (const contents of [JSON.stringify(intent), "{partial", JSON.stringify({ ...intent, target: f.first }),
    JSON.stringify({ ...intent, repository: f.source }), JSON.stringify({ ...intent, branch: "other" })]) {
    await writeFile(f.intentPath, contents, { mode: 0o600 });
    const before = await snapshot(f.repository);
    assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
    assert.equal(await readFile(f.intentPath, "utf8"), contents);
    assert.deepEqual(await snapshot(f.repository), before);
    await assert.rejects(git(f.repository, "cat-file", "-e", f.oid));
  }
  // A lock created by an interrupted Git must survive all read-only recovery.
  await writeFile(join(f.repository, ".git/index.lock"), "keep lock");
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.equal(await readFile(join(f.repository, ".git/index.lock"), "utf8"), "keep lock");
  await rm(join(f.repository, ".git/index.lock")); // Test-owned evidence only.
  await rm(f.intentPath);
  await exec("/usr/bin/mkfifo", [f.intentPath], { timeout: 5_000 });
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.equal((await lstat(f.intentPath)).isFIFO(), true);
  await rm(f.intentPath);
  // Abort from a real app-directory creation event, not sleeps or polling. The
  // intent writer must finish recording evidence and the next Git gate must
  // receive the aborted signal; no merge/cleanup may follow cancellation.
  const cancellation = new AbortController();
  const watcher = watch(f.app, { persistent: false }, (_event, filename) => {
    // macOS can deliver the preceding fixture unlink event after watch starts.
    if (filename?.toString() === "apply-intent.json" && existsSync(f.intentPath)) cancellation.abort();
  });
  const beforeCancelled = await snapshot(f.repository);
  try {
    assert.equal((await applyReceivedFastForward({ ...f.input, signal: cancellation.signal })).status, "needs-recovery");
  } finally { watcher.close(); }
  assert.equal(cancellation.signal.aborted, true);
  const cancelledEvidence = await readFile(f.intentPath, "utf8");
  assert.deepEqual(JSON.parse(cancelledEvidence), intent);
  assert.deepEqual(await snapshot(f.repository), beforeCancelled);
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.equal(await readFile(f.intentPath, "utf8"), cancelledEvidence);
  await rm(f.intentPath); // Explicit test-owned reconciliation, never production cleanup.
  // Reproducible real-Git I/O failure AFTER durable intent publication. An EMPTY
  // directory is insufficient (Git removes it): use a NONEMPTY reflog directory
  // to prevent HEAD publication. Git may already have
  // updated the index/worktree, so neither retry nor rollback is safe.
  const log = join(f.repository, ".git/logs/refs/heads", branch);
  await rm(log); await mkdir(log);
  await writeFile(join(log, "keep"), "nonempty obstruction\n");
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  const evidence = await readFile(f.intentPath, "utf8");
  assert.deepEqual(JSON.parse(evidence), intent);
  assert.equal((await lstat(f.intentPath)).mode & 0o777, 0o600);
  const ambiguous = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.deepEqual(await snapshot(f.repository), ambiguous);
  assert.equal(await readFile(f.intentPath, "utf8"), evidence);
});

test("completed-intent retry observes exact target+branch+clean status read-only, retaining evidence", options, async t => {
  const f = await fixture(t), intent = await savedIntent(f);
  assert.equal((await applyReceivedFastForward(f.input)).status, "fast-forwarded");
  const text = JSON.stringify(intent);
  await writeFile(f.intentPath, text, { mode: 0o600 });
  // Recovery observation does not depend on (or mutate) the received store.
  await rm(f.store, { recursive: true });
  const before = await snapshot(f.repository);
  assert.equal((await applyReceivedFastForward(f.input)).status, "up-to-date");
  assert.deepEqual(await snapshot(f.repository), before);
  assert.equal(await readFile(f.intentPath, "utf8"), text);
  await writeFile(join(f.repository, "tracked.txt"), "edited after completion\n");
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  await git(f.repository, "switch", "-c", "another");
  assert.equal((await applyReceivedFastForward(f.input)).status, "needs-recovery");
  assert.equal(await readFile(f.intentPath, "utf8"), text);
});

test("rejects non-app store, wrong receipt branch/OID, worktree/store overlap and nonprivate intent parent", options, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.repository);
  await assert.rejects(applyReceivedFastForward({ ...f.input, store: f.repository }), /mismatch/);
  await assert.rejects(applyReceivedFastForward({ ...f.input, store: f.source }));
  await assert.rejects(applyReceivedFastForward({ ...f.input, repository: f.source, intentPath: join(f.source, "intent") }));
  await assert.rejects(applyReceivedFastForward({ ...f.input, branch: "different" }));
  await assert.rejects(applyReceivedFastForward({ ...f.input, oid: "a".repeat(40) }));
  await chmod(f.app, 0o755);
  await assert.rejects(applyReceivedFastForward(f.input), /Unsafe app directory/);
  assert.deepEqual(await snapshot(f.repository), before);
  await absent(f.intentPath);
});
