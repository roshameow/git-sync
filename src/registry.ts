import type { AppPaths } from "./config.js";
import type { DesiredRegistry, RegistryMode } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { pathExists, readJson, writeJsonAtomic } from "./storage.js";
import { isDesiredRegistry } from "./validation.js";

export function createEmptyRegistry(now: Date = new Date()): DesiredRegistry {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    repositories: {},
  };
}

export function setRepositoryMode(
  registry: DesiredRegistry,
  canonicalRemote: string,
  mode: RegistryMode,
  now: Date = new Date(),
): DesiredRegistry {
  if (canonicalRemote.trim() === "") throw new Error("Canonical remote cannot be empty");
  const timestamp = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: timestamp,
    repositories: {
      ...registry.repositories,
      [canonicalRemote]: {
        canonicalRemote,
        mode,
        updatedAt: timestamp,
      },
    },
  };
}

export async function loadRegistry(paths: AppPaths): Promise<DesiredRegistry> {
  if (!(await pathExists(paths.registryFile))) return createEmptyRegistry();
  return readJson(paths.registryFile, isDesiredRegistry);
}

export async function saveRegistry(paths: AppPaths, registry: DesiredRegistry): Promise<void> {
  await writeJsonAtomic(paths.registryFile, registry);
}
