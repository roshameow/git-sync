import type { AppPaths } from "./config.js";
import type {
  DesiredRegistry,
  HostInventory,
  ReconcileReport,
  ReconcileRepository,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { writeJsonAtomic } from "./storage.js";

export const MAX_INVENTORY_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_INVENTORY_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Compute state only. This function intentionally has no Git/network operations and
 * emits no actions: Phase 1 must never clone a repository or alter a worktree.
 */
export function reconcileInventories(
  inventories: readonly HostInventory[],
  registry: DesiredRegistry,
  now: Date = new Date(),
): ReconcileReport {
  const byHost = new Map<string, HostInventory>();
  for (const inventory of inventories) {
    assertFreshInventory(inventory, now);
    if (byHost.has(inventory.hostId)) throw new Error(`Duplicate inventory: ${inventory.hostId}`);
    byHost.set(inventory.hostId, inventory);
  }
  const hostIds = [...byHost.keys()].sort((left, right) => left.localeCompare(right));
  const { presence, duplicateHosts } = buildPresence(byHost);
  const allRemotes = new Set([...presence.keys(), ...Object.keys(registry.repositories)]);

  const repositories: ReconcileRepository[] = [...allRemotes]
    .sort((left, right) => left.localeCompare(right))
    .map((canonicalRemote) => {
      const entry = registry.repositories[canonicalRemote];
      const presentOn = [...(presence.get(canonicalRemote) ?? [])].sort((left, right) =>
        left.localeCompare(right),
      );
      const missingOn = hostIds.filter((hostId) => !presentOn.includes(hostId));

      if (entry === undefined) {
        return { canonicalRemote, desiredMode: null, status: "unregistered", presentOn, missingOn };
      }
      if (entry.mode === "disabled") {
        return { canonicalRemote, desiredMode: entry.mode, status: "disabled", presentOn, missingOn };
      }
      if (entry.mode === "ignored") {
        return { canonicalRemote, desiredMode: entry.mode, status: "ignored", presentOn, missingOn };
      }
      if (hostIds.length !== 2) {
        return {
          canonicalRemote,
          desiredMode: entry.mode,
          status: "waiting-for-two-hosts",
          presentOn,
          missingOn,
        };
      }
      if ((duplicateHosts.get(canonicalRemote)?.size ?? 0) > 0) {
        return {
          canonicalRemote,
          desiredMode: entry.mode,
          status: "blocked-duplicate-checkouts",
          presentOn,
          missingOn,
        };
      }
      return {
        canonicalRemote,
        desiredMode: entry.mode,
        status: presentOn.length === 2 ? "managed" : "missing-on-host",
        presentOn,
        missingOn,
      };
    });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    expectedHostCount: 2,
    hostIds,
    repositories,
    actions: [],
  };
}

export async function saveReconcileReport(paths: AppPaths, report: ReconcileReport): Promise<void> {
  await writeJsonAtomic(paths.reconcileFile, report);
}

function assertFreshInventory(inventory: HostInventory, now: Date): void {
  const generatedAt = Date.parse(inventory.generatedAt);
  if (!Number.isFinite(generatedAt)) {
    throw new Error(`Inventory for ${inventory.hostId} has an invalid generatedAt timestamp`);
  }
  const age = now.getTime() - generatedAt;
  if (age > MAX_INVENTORY_AGE_MS) {
    throw new Error(`Inventory for ${inventory.hostId} is stale`);
  }
  if (age < -MAX_INVENTORY_FUTURE_SKEW_MS) {
    throw new Error(`Inventory for ${inventory.hostId} is too far in the future`);
  }
}

function buildPresence(inventories: ReadonlyMap<string, HostInventory>): {
  presence: Map<string, Set<string>>;
  duplicateHosts: Map<string, Set<string>>;
} {
  const presence = new Map<string, Set<string>>();
  const duplicateHosts = new Map<string, Set<string>>();
  for (const [hostId, inventory] of inventories) {
    const perHostCounts = new Map<string, number>();
    for (const repository of inventory.repositories) {
      if (repository.canonicalRemote === null) continue;
      perHostCounts.set(
        repository.canonicalRemote,
        (perHostCounts.get(repository.canonicalRemote) ?? 0) + 1,
      );
      const hosts = presence.get(repository.canonicalRemote) ?? new Set<string>();
      hosts.add(hostId);
      presence.set(repository.canonicalRemote, hosts);
    }
    for (const [canonicalRemote, count] of perHostCounts) {
      if (count < 2) continue;
      const hosts = duplicateHosts.get(canonicalRemote) ?? new Set<string>();
      hosts.add(hostId);
      duplicateHosts.set(canonicalRemote, hosts);
    }
  }
  return { presence, duplicateHosts };
}
