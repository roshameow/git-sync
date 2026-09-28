import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeRemote } from "../src/remote.js";

test("canonical remote normalization equates common transport forms", () => {
  const expected = "github.com/owner/project";
  assert.equal(normalizeRemote("https://github.com/Owner/Project.git"), expected);
  assert.equal(normalizeRemote("https://token@example.invalid@github.com/Owner/Project.git/"), expected);
  assert.equal(normalizeRemote("ssh://git@github.com/Owner/Project.git"), expected);
  assert.equal(normalizeRemote("ssh://git@github.com:22/Owner/Project.git"), expected);
  assert.equal(normalizeRemote("git@github.com:Owner/Project.git"), expected);
  assert.equal(normalizeRemote("git://github.com/Owner/Project.git"), expected);
});

test("normalization preserves non-default ports and canonicalizes local paths", async (context) => {
  assert.equal(normalizeRemote("ssh://git@Example.COM:2222/team/repo.git"), "example.com:2222/team/repo");

  const directory = await mkdtemp(resolve(tmpdir(), "git-sync-remote-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(normalizeRemote("../repo.git", resolve(directory, "child")), `file://${directory}/repo.git`);
});

test("invalid remotes are rejected", () => {
  assert.throws(() => normalizeRemote("  "), /cannot be empty/);
  assert.throws(() => normalizeRemote("https://github.com"), /no repository path/);
});
