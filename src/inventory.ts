import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppPaths } from "./config.js";
import type { HostInventory } from "./types.js";
import { pathExists, readJson, writeJsonAtomic } from "./storage.js";
import { isHostInventory } from "./validation.js";

export function inventoryPath(paths: AppPaths, hostId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hostId)) {
    throw new Error(`Unsafe host id for inventory filename: ${hostId}`);
  }
  return resolve(paths.inventoryDirectory, `${hostId}.json`);
}

export async function saveInventory(paths: AppPaths, inventory: HostInventory): Promise<void> {
  await writeJsonAtomic(inventoryPath(paths, inventory.hostId), inventory);
}

export async function loadInventories(paths: AppPaths): Promise<HostInventory[]> {
  let files: string[];
  try {
    files = await readdir(paths.inventoryDirectory);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const inventories: HostInventory[] = [];
  const seenHostIds = new Set<string>();
  for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
    const inventory = await readJson(resolve(paths.inventoryDirectory, file), isHostInventory);
    if (file !== `${inventory.hostId}.json`) {
      throw new Error(`Inventory filename does not match host id: ${file}`);
    }
    if (seenHostIds.has(inventory.hostId)) {
      throw new Error(`Duplicate inventory for host id: ${inventory.hostId}`);
    }
    seenHostIds.add(inventory.hostId);
    inventories.push(inventory);
  }
  return inventories.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

/** Local observer paths must not depend on another host's cached inventory. */
export async function loadHostInventory(paths: AppPaths, hostId: string): Promise<HostInventory | null> {
  const file = inventoryPath(paths, hostId);
  if (!await pathExists(file)) return null;
  const inventory = await readJson(file, isHostInventory);
  if (inventory.hostId !== hostId) throw new Error("Inventory filename does not match host id");
  return inventory;
}
