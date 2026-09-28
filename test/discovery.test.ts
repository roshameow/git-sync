import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createConfig } from "../src/config.js";
import { discoverRepositories } from "../src/discovery.js";
import { createHostIdentity } from "../src/host.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initRepository(path: string, remote?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "--quiet");
  await git(path, "config", "user.email", "test@example.invalid");
  await git(path, "config", "user.name", "Test User");
  if (remote !== undefined) await git(path, "remote", "add", "origin", remote);
}

test("discovery scans multiple roots, excludes directories, and detects linked worktrees", async (context) => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "git-sync-discovery-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const rootA = resolve(sandbox, "root-a");
  const rootB = resolve(sandbox, "root-b");
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });

  const repoA = resolve(rootA, "repo-a");
  await initRepository(repoA, "git@github.com:Acme/One.git");

  const excluded = resolve(rootA, "skip", "secret");
  await initRepository(excluded, "https://github.com/Acme/Secret.git");

  const main = resolve(rootB, "main");
  const linked = resolve(rootB, "linked");
  await initRepository(main, "https://github.com/Acme/Worktrees.git");
  await writeFile(resolve(main, "tracked.txt"), "initial\n");
  await git(main, "add", "tracked.txt");
  await git(main, "commit", "--quiet", "-m", "initial");
  await git(main, "worktree", "add", "--quiet", "-b", "linked-test", linked);

  const fake = resolve(rootB, "not-a-repo");
  await mkdir(fake);
  await writeFile(resolve(fake, ".git"), "not a gitdir file\n");

  const fakeBin = resolve(sandbox, "fake-bin");
  const sentinel = resolve(sandbox, "fake-git-invoked");
  await mkdir(fakeBin);
  const fakeGit = resolve(fakeBin, "git");
  await writeFile(fakeGit, `#!/bin/sh\nprintf 'invoked\\n' >> '${sentinel}'\nexit 91\n`);
  await chmod(fakeGit, 0o755);
  const index = resolve(main, ".git", "index");
  const beforeIndex = await readFile(index);
  const beforeIndexStat = await stat(index);
  const linkedMarker = resolve(linked, ".git");
  const beforeMarker = await readFile(linkedMarker);
  const beforeMarkerStat = await stat(linkedMarker);

  const config = createConfig([rootA, rootB], ["skip"]);
  const host = createHostIdentity("host-a", new Date("2025-01-01T00:00:00Z"), "test-host");
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  let inventory: Awaited<ReturnType<typeof discoverRepositories>>;
  try {
    inventory = await discoverRepositories(config, host, new Date("2025-01-02T00:00:00Z"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  assert.deepEqual(await readFile(index), beforeIndex);
  const afterIndexStat = await stat(index);
  assert.equal(afterIndexStat.dev, beforeIndexStat.dev);
  assert.equal(afterIndexStat.ino, beforeIndexStat.ino);
  assert.deepEqual(await readFile(linkedMarker), beforeMarker);
  const afterMarkerStat = await stat(linkedMarker);
  assert.equal(afterMarkerStat.dev, beforeMarkerStat.dev);
  assert.equal(afterMarkerStat.ino, beforeMarkerStat.ino);
  const [canonicalRepoA, canonicalLinked, canonicalMain, canonicalExcluded] = await Promise.all([
    realpath(repoA),
    realpath(linked),
    realpath(main),
    realpath(excluded),
  ]);

  assert.equal(inventory.hostId, "host-a");
  assert.deepEqual(
    inventory.repositories.map((repository) => repository.path).sort(),
    [canonicalRepoA, canonicalLinked, canonicalMain].sort(),
  );
  assert.equal(
    inventory.repositories.some((repository) => repository.path === canonicalExcluded),
    false,
  );

  const directoryRepository = inventory.repositories.find(
    (repository) => repository.path === canonicalRepoA,
  );
  assert.equal(directoryRepository?.gitMarker, "directory");
  assert.equal(directoryRepository?.worktree, false);
  assert.equal(directoryRepository?.canonicalRemote, "github.com/acme/one");

  const linkedRepository = inventory.repositories.find(
    (repository) => repository.path === canonicalLinked,
  );
  assert.equal(linkedRepository?.gitMarker, "file");
  assert.equal(linkedRepository?.worktree, true);
  assert.equal(linkedRepository?.canonicalRemote, "github.com/acme/worktrees");
});
