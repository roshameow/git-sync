import assert from "node:assert/strict";
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { hasRetainedApplyIntent } from "../src/sync-apply-intents.js";

const options = { timeout: 20_000 };
const namespaces = ["direct", "upstream"] as const;
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sync-apply-intents-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: join(root, "app") });
  // No Git repositories, config, inventory or registry are created or consulted.
  const repository = join(root, "absent-checkout");
  const upstream = join(paths.stateDirectory, "upstream-sync");
  const file = (namespace: typeof namespaces[number], key = "a".repeat(64)) => namespace === "direct"
    ? join(paths.stateDirectory, `direct-sync-apply-${key}.json`) : join(upstream, `apply-${key}.json`);
  const intent = (repo = repository) => ({ version: 1, repository: repo, repositoryId: "1:2",
    gitDir: join(repo, ".git"), gitDirId: "1:3", commonDir: join(repo, ".git"),
    store: join(root, "absent-store.git"), branch: "main", head: "1".repeat(40), target: "2".repeat(40) });
  const setup = async () => { await mkdir(upstream, { recursive: true, mode: 0o700 }); };
  const check = () => hasRetainedApplyIntent(paths, repository);
  return { root, paths, repository, upstream, file, intent, setup, check };
}

// Durable offline regression evidence: neither mode/config deletion nor a new
// remote-derived filename grants permission to ignore retained checkout intent.
// Snapshot bytes and metadata (excluding read atime) to detect accidental repair.
async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const file = join(root, name), st = await lstat(file);
    result.push([name, st.mode, st.uid, st.ino, st.nlink, st.mtimeMs, st.ctimeMs,
      st.isSymbolicLink() ? await readlink(file) : st.isDirectory() ? await snapshot(file) : await readFile(file)]);
  }
  return result;
}
async function preserved(root: string, check: () => Promise<boolean>, expected: boolean) {
  const before = await snapshot(root);
  assert.equal(await check(), expected);
  assert.equal(await check(), expected, "rechecking never clears recovery evidence");
  assert.deepEqual(await snapshot(root), before);
}

test("missing namespaces are false without creating any state", options, async t => {
  const f = await fixture(t);
  await preserved(f.root, f.check, false);
  await mkdir(f.paths.stateDirectory, { recursive: true, mode: 0o700 });
  await preserved(f.root, f.check, false);
  await f.setup();
  await preserved(f.root, f.check, false);
});

for (const namespace of namespaces) {
  test(`${namespace}: retained intent blocks with all configs absent and arbitrary old remote hash`, options, async t => {
    const f = await fixture(t); await f.setup();
    await writeFile(f.file(namespace, "0123456789abcdef".repeat(4)), `  ${JSON.stringify(f.intent())}\n`, { mode: 0o600 });
    await preserved(f.root, f.check, true);
  });

  test(`${namespace}: valid other-checkout intent does not block; all matching names are scanned`, options, async t => {
    const f = await fixture(t); await f.setup();
    await writeFile(f.file(namespace), JSON.stringify(f.intent(`${f.repository}-other`)), { mode: 0o600 });
    await preserved(f.root, f.check, false);
    await writeFile(f.file(namespace, "b".repeat(64)), JSON.stringify(f.intent()), { mode: 0o600 });
    await preserved(f.root, f.check, true);
  });

  test(`${namespace}: malformed or ambiguous JSON fails closed even when it claims another checkout`, options, async t => {
    const f = await fixture(t); await f.setup();
    const other = f.intent(`${f.repository}-other`);
    const invalid: (string | Buffer)[] = ["", "{", "null", "[]", "42", "{}", JSON.stringify({ repository: other.repository }),
      `\uFEFF${JSON.stringify(other)}`,
      ...[{ version: 2 }, { repository: null }, { repository: "relative" }, { repository: `${f.repository}/../alias` },
        { repository: `${f.repository}/` }, { repositoryId: "" }, { gitDir: false }, { commonDir: "/x/../y" },
        { store: "relative" }, { branch: "" }, { branch: "a..b" }, { branch: "a.lock/b" }, { branch: "a\\b" },
        { branch: "a[b" }, { head: "bad" }, { target: "a".repeat(41) }, { extra: true }]
        .map(change => JSON.stringify({ ...other, ...change })),
      JSON.stringify(other).replace('"version":1', '"version":1,"version":1'),
      JSON.stringify(other).replace('"repository":', `"repository":${JSON.stringify(f.repository)},"repository":`),
      JSON.stringify(other).replace('"repository":', `"repo\\u0073itory":${JSON.stringify(f.repository)},"repository":`),
      Buffer.concat([Buffer.from(JSON.stringify(other).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    ];
    for (const bytes of invalid) {
      await writeFile(f.file(namespace), bytes, { mode: 0o600 });
      await preserved(f.root, f.check, true);
    }
  });

  test(`${namespace}: symlink, hardlink, directory, nonprivate and oversized files fail closed`, options, async t => {
    const f = await fixture(t); await f.setup();
    const file = f.file(namespace), target = join(f.root, "target");
    const text = JSON.stringify(f.intent(`${f.repository}-other`));
    await writeFile(target, text, { mode: 0o600 });
    await symlink(target, file); await preserved(f.root, f.check, true); await rm(file);
    await symlink(join(f.root, "missing"), file); await preserved(f.root, f.check, true); await rm(file);
    await link(target, file); await preserved(f.root, f.check, true); await rm(file);
    await mkdir(file, { mode: 0o700 }); await preserved(f.root, f.check, true); await rm(file, { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
    for (const mode of [0o644, 0o400, 0o000, 0o4600]) {
      await chmod(file, mode);
      const before = await lstat(file);
      assert.equal(await f.check(), true);
      assert.equal((await lstat(file)).mode, before.mode);
      await chmod(file, 0o600);
      assert.equal(await readFile(file, "utf8"), text);
    }
    await writeFile(file, text.padEnd(16_384, " "));
    await preserved(f.root, f.check, false);
    await writeFile(file, text.padEnd(16_385, " "));
    await preserved(f.root, f.check, true);
  });
}

test("both namespaces coexist: other checkout is allowed but either mode can retain this checkout", options, async t => {
  const f = await fixture(t); await f.setup();
  for (const namespace of namespaces)
    await writeFile(f.file(namespace), JSON.stringify(f.intent(`${f.repository}-other`)), { mode: 0o600 });
  await preserved(f.root, f.check, false);
  for (const namespace of namespaces) {
    await writeFile(f.file(namespace), JSON.stringify(f.intent()));
    await preserved(f.root, f.check, true);
    await writeFile(f.file(namespace), JSON.stringify(f.intent(`${f.repository}-other`)));
  }
});

test("only exact known filenames are inspected; no config reads or recursive store traversal", options, async t => {
  const f = await fixture(t); await f.setup();
  for (const directory of [f.paths.stateDirectory, f.upstream]) {
    for (const name of ["direct-sync.json", "upstream-sync.json", "apply-short.json", "direct-sync-apply-short.json",
      `apply-${"g".repeat(64)}.json`, `direct-sync-apply-${"a".repeat(64)}.json.backup`])
      await writeFile(join(directory, name), "not JSON", { mode: 0o644 });
    const nested = join(directory, "store.git"); await mkdir(nested);
    await writeFile(join(nested, `apply-${"a".repeat(64)}.json`), "not JSON");
  }
  await preserved(f.root, f.check, false);
});

test("unsafe namespace roots fail closed without adoption or repair", options, async t => {
  for (const namespace of ["state", "upstream"] as const) {
    const f = await fixture(t); await f.setup();
    const directory = namespace === "state" ? f.paths.stateDirectory : f.upstream;
    await chmod(directory, 0o755); await preserved(f.root, f.check, true); await chmod(directory, 0o700);
    await rm(directory, { recursive: true });
    const target = join(f.root, "external"); await mkdir(target, { mode: 0o700 });
    await symlink(target, directory); await preserved(f.root, f.check, true); await rm(directory);
    await symlink(join(f.root, "missing"), directory); await preserved(f.root, f.check, true); await rm(directory);
    await writeFile(directory, "not a directory", { mode: 0o600 }); await preserved(f.root, f.check, true);
  }
});

test("wrong owners fail closed (when chown is available)", { ...options, skip: process.getuid?.() !== 0 }, async t => {
  const f = await fixture(t); await f.setup();
  for (const namespace of namespaces) {
    const file = f.file(namespace);
    await writeFile(file, JSON.stringify(f.intent(`${f.repository}-other`)), { mode: 0o600 });
    await chown(file, 1, 1); await preserved(f.root, f.check, true); await rm(file);
  }
  await chown(f.upstream, 1, 1); await preserved(f.root, f.check, true);
});

test("directory enumeration is bounded and exhaustion fails closed", options, async t => {
  for (const namespace of namespaces) {
    const f = await fixture(t); await f.setup();
    const directory = namespace === "direct" ? f.paths.stateDirectory : f.upstream;
    for (let start = 0; start < 4097; start += 64)
      await Promise.all(Array.from({ length: Math.min(64, 4097 - start) }, (_, n) =>
        writeFile(join(directory, `unrelated-${start + n}`), "", { mode: 0o600 })));
    await preserved(f.root, f.check, true);
  }
});
