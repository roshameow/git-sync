import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { prepareGuardianMergePreview as preview } from "../src/guardian-merge-preview.js";

const exec = promisify(execFile), options = { timeout: 30_000 };
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/dev/null", XDG_CONFIG_HOME: "/dev/null", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Preview Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Preview Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z" },
  })).stdout;
}
async function commit(repository: string, path: string, content: string): Promise<string> {
  await writeFile(join(repository, path), content);
  await git(repository, "add", "--", path);
  await git(repository, "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
  return (await git(repository, "rev-parse", "HEAD")).trim();
}
async function fixture(t: TestContext, conflict = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guardian-preview-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "work"), receivedStore = join(root, "received.git"), outputParent = join(root, "proposals");
  for (const path of [repository, receivedStore, outputParent]) await mkdir(path, { mode: 0o700 });
  await git(repository, "init", "--template=", "--object-format=sha1", "--initial-branch=main");
  const name = conflict ? "odd\tname\n.txt" : "shared.txt";
  const base = await commit(repository, name, "base\n");
  await git(repository, "checkout", "-qb", "peer");
  const peerOid = await commit(repository, conflict ? name : "peer.txt", "peer\n");
  await git(receivedStore, "init", "--bare", "--template=", "--object-format=sha1");
  await git(receivedStore, "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", repository, peerOid);
  await git(receivedStore, "update-ref", `refs/received/test/${peerOid}`, peerOid);
  await writeFile(join(receivedStore, "direct-sync-store-v1"), "git-sync direct committed history store v1\n", { mode: 0o600 });
  await git(repository, "checkout", "-q", "main");
  const localOid = await commit(repository, conflict ? name : "local.txt", "local\n");
  return { root, repository, receivedStore, outputParent, localOid, peerOid, base, name };
}
// Byte/mode snapshot includes HEAD, index, refs, reflogs, config, worktree and objects.
async function snapshot(root: string): Promise<unknown> {
  const rows: unknown[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name), st = await lstat(full);
      rows.push([full.slice(root.length), st.mode, st.isFile() ? createHash("sha256").update(await readFile(full)).digest("hex") : null]);
      if (st.isDirectory()) await visit(full);
    }
  }
  await visit(root);
  return rows;
}

test("divergent clean proposal is deterministic, private and retains objects without source mutation", options, async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "local.txt"), "staged\n");
  await git(f.repository, "add", "local.txt");
  await writeFile(join(f.repository, "local.txt"), "unstaged\n");
  await writeFile(join(f.repository, "untracked"), "not part of merge\n");
  const before = await snapshot(f.repository), received = await snapshot(f.receivedStore);
  const p = await preview(f), again = await preview(f);
  assert.equal(p.status, "clean");
  assert.equal(p.treeOid, again.treeOid);
  assert.notEqual(p.storePath, again.storePath);
  assert.deepEqual(p.conflictPaths, []);
  assert.equal(p.approved, false); assert.equal(p.applied, false);
  assert.equal(await git(p.storePath, "show", `${p.treeOid}:local.txt`), "local\n");
  assert.equal(await git(p.storePath, "show", `${p.treeOid}:peer.txt`), "peer\n");
  assert.equal(await git(p.storePath, "for-each-ref"), "");
  await assert.rejects(readFile(join(p.storePath, "FETCH_HEAD")), { code: "ENOENT" });
  assert.equal((await lstat(p.storePath)).mode & 0o777, 0o700);
  const file = join(p.storePath, "proposal.json"), st = await lstat(file);
  assert.equal(st.mode & 0o777, 0o600); assert.equal(st.uid, process.getuid!());
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), p);
  await git(p.storePath, "fsck", "--full", p.localOid, p.peerOid, p.treeOid!);
  assert.deepEqual(await snapshot(f.repository), before);
  assert.deepEqual(await snapshot(f.receivedStore), received);
});

test("conflict exit 1 preserves exact unusual paths and conflict tree, not source drivers/hooks", options, async t => {
  const f = await fixture(t, true), trap = join(f.root, "executed");
  await git(f.repository, "config", "merge.trap.driver", `touch '${trap}'`);
  await git(f.repository, "config", "core.fsmonitor", `touch '${trap}'`);
  // Verified fixture pitfall: init --template= does not create info/ or hooks/.
  await mkdir(join(f.repository, ".git/info"), { recursive: true });
  await mkdir(join(f.repository, ".git/hooks"), { recursive: true });
  await writeFile(join(f.repository, ".git/info/attributes"), "*.txt merge=trap\n");
  await writeFile(join(f.repository, ".git/hooks/pre-merge-commit"), `#!/bin/sh\ntouch '${trap}'\n`, { mode: 0o700 });
  const before = await snapshot(f.repository);
  const p = await preview(f);
  assert.equal(p.status, "conflicted");
  assert.deepEqual(p.conflictPaths, [f.name]);
  const content = await git(p.storePath, "show", `${p.treeOid}:${f.name}`);
  assert.match(content, /<<<<<<< /); assert.match(content, /local/); assert.match(content, /peer/);
  assert.deepEqual(JSON.parse(await readFile(join(p.storePath, "proposal.json"), "utf8")), p);
  assert.deepEqual(await snapshot(f.repository), before);
  await assert.rejects(readFile(trap), { code: "ENOENT" });

  // Git paths are bytes: refuse lossy UTF-8 rather than publishing wrong names.
  const raw = await fixture(t);
  // APFS refuses these worktree filenames (EILSEQ); construct valid Git objects.
  const object = async (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
    const oid = createHash("sha1").update(bytes).digest("hex");
    const dir = join(raw.repository, ".git/objects", oid.slice(0, 2));
    await mkdir(dir, { recursive: true });
    try { await writeFile(join(dir, oid.slice(2)), deflateSync(bytes), { flag: "wx", mode: 0o444 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return oid;
  };
  const rawCommit = async (content: string, parent?: string) => {
    const blob = await object("blob", Buffer.from(content));
    const tree = await object("tree", Buffer.concat([Buffer.from("100644 "), Buffer.from([0x80, 0]), Buffer.from(blob, "hex")]));
    return (await git(raw.repository, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "raw path")).trim();
  };
  const base = await rawCommit("base\n"), peerOid = await rawCommit("peer\n", base);
  await git(raw.receivedStore, "fetch", "--no-write-fetch-head", "--no-tags", "--no-auto-gc", raw.repository, peerOid);
  const localOid = await rawCommit("local\n", base);
  await git(raw.repository, "update-ref", "HEAD", localOid);
  await assert.rejects(preview({ ...raw, localOid, peerOid }), /lossless UTF-8/);
  for (const entry of await readdir(raw.outputParent))
    await assert.rejects(readFile(join(raw.outputParent, entry, "proposal.json")), { code: "ENOENT" });
});

test("same and both ancestry directions return no merge tree", options, async t => {
  const f = await fixture(t);
  for (const [localOid, peerOid, status] of [[f.base, f.base, "same"], [f.base, f.peerOid, "peer-ahead"], [f.localOid, f.base, "local-ahead"]]) {
    await git(f.repository, "checkout", "--detach", localOid!);
    const p = await preview({ ...f, localOid: localOid!, peerOid: peerOid! });
    assert.equal(p.status, status); assert.equal(p.treeOid, null); assert.deepEqual(p.conflictPaths, []);
    assert.equal(p.approved, false); assert.equal(p.applied, false);
    assert.equal(await git(p.storePath, "for-each-ref"), "");
  }
});

test("changed local HEAD, invalid/noncommit tips and incomplete history are refused", options, async t => {
  const f = await fixture(t);
  await assert.rejects(preview({ ...f, localOid: f.base }), /Source changed/);
  await assert.rejects(preview({ ...f, peerOid: "HEAD" }), /exact SHA-1/);
  await assert.rejects(preview({ ...f, peerOid: "0".repeat(40) }), /failed/);
  const tree = (await git(f.receivedStore, "rev-parse", `${f.peerOid}^{tree}`)).trim();
  await assert.rejects(preview({ ...f, peerOid: tree }), /actual commit/);
  await writeFile(join(f.receivedStore, "shallow"), `${f.peerOid}\n`);
  await assert.rejects(preview(f), /Incomplete/);
  await rm(join(f.receivedStore, "shallow"));
  // Remove a reachable blob: complete commits alone do not establish a full graph.
  const blob = (await git(f.repository, "rev-parse", `${f.localOid}:local.txt`)).trim();
  await rm(join(f.repository, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(preview(f), /failed/);
  for (const entry of await readdir(f.outputParent))
    await assert.rejects(readFile(join(f.outputParent, entry, "proposal.json")), { code: "ENOENT" });
});

test("symlinks, nonprivate/noncanonical outputs and overlaps including unrelated Git roots are refused", options, async t => {
  const f = await fixture(t);
  for (const key of ["repository", "receivedStore", "outputParent"] as const) {
    const link = join(f.root, `link-${key}`); await symlink(f[key], link);
    await assert.rejects(preview({ ...f, [key]: link }), /symlink/);
  }
  await assert.rejects(preview({ ...f, outputParent: `${f.outputParent}/../proposals` }), /Noncanonical/);
  await chmod(f.outputParent, 0o755);
  await assert.rejects(preview(f), /private/);
  await chmod(f.outputParent, 0o700);
  const nested = join(f.repository, "preview"); await mkdir(nested, { mode: 0o700 });
  for (const outputParent of [nested, f.repository, f.receivedStore, f.root])
    await assert.rejects(preview({ ...f, outputParent }), /overlap/);
  const other = join(f.root, "other"), outputParent = join(other, "private");
  await mkdir(other); await git(other, "init", "--template="); await mkdir(outputParent, { mode: 0o700 });
  await assert.rejects(preview({ ...f, outputParent }), /outside Git roots/);
  assert.deepEqual(await readdir(f.outputParent), []);
});
