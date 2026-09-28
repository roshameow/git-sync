import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { resolveAppPaths } from "../src/config.js";
import { loadInventories, saveInventory } from "../src/inventory.js";
import { createEmptyRegistry, loadRegistry, saveRegistry, setRepositoryMode } from "../src/registry.js";
import type { HostInventory } from "../src/types.js";

test("inventory and desired registry persist as complete JSON without leftover temp files", async (context) => {
  const home = await mkdtemp(resolve(tmpdir(), "git-sync-state-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: home });
  const inventory: HostInventory = {
    schemaVersion: 1,
    hostId: "host-a",
    generatedAt: "2025-01-01T00:00:00.000Z",
    roots: ["/repos"],
    repositories: [],
  };

  await saveInventory(paths, inventory);
  assert.deepEqual(await loadInventories(paths), [inventory]);

  const registry = setRepositoryMode(
    createEmptyRegistry(new Date("2025-01-01T00:00:00Z")),
    "example.com/team/repo",
    "enabled",
    new Date("2025-01-02T00:00:00Z"),
  );
  await saveRegistry(paths, registry);
  assert.deepEqual(await loadRegistry(paths), registry);

  const inventoryFiles = await readdir(paths.inventoryDirectory);
  const stateFiles = await readdir(paths.stateDirectory);
  assert.equal((await stat(paths.inventoryDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.registryFile)).mode & 0o777, 0o600);
  assert.deepEqual(inventoryFiles, ["host-a.json"]);
  assert.equal([...inventoryFiles, ...stateFiles].some((file) => file.endsWith(".tmp")), false);
});

test("inventory filename must be bound to the declared host identity", async (context) => {
  const home = await mkdtemp(resolve(tmpdir(), "git-sync-inventory-name-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveAppPaths({ GIT_SYNC_HOME: home });
  await mkdir(paths.inventoryDirectory, { recursive: true });
  await writeFile(
    resolve(paths.inventoryDirectory, "host-b.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      hostId: "host-a",
      generatedAt: "2025-01-01T00:00:00.000Z",
      roots: [],
      repositories: [],
    })}\n`,
  );

  await assert.rejects(loadInventories(paths), /filename does not match host id/);
});
