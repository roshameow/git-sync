import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./config.js";
import { loadDirectSyncConfig, directSyncStatus } from "./direct-sync-service.js";
import { loadInventories } from "./inventory.js";
import { loadRegistry } from "./registry.js";
import { loadHostIdentity } from "./host.js";
import { inspectRepositoryPath } from "./discovery.js";
import { directGit } from "./direct-sync.js";
import { withOwnedLocalLock } from "./local-lock.js";
import { prepareGuardianMergePreview } from "./guardian-merge-preview.js";

/** Explicit preview of committed histories, even if the worktree is dirty.
 * Does not import into, merge, or edit that worktree. Never approval to apply. */
export async function previewGuardianRepository(paths: AppPaths, canonicalRemote: string) {
  const config = await loadDirectSyncConfig(paths);
  if (!config || (await loadHostIdentity(paths)).id !== config.hostId) throw new Error("Direct sync identity unavailable");
  const selected = config.repositories.find(r => r.canonicalRemote === canonicalRemote && r.enabled);
  if (!selected || (await loadRegistry(paths)).repositories[canonicalRemote]?.mode !== "enabled")
    throw new Error("Repository is not explicitly enabled");
  return withOwnedLocalLock(join(paths.stateDirectory, "guardian-preview.lock"), "Guardian preview", async () => {
    const records = (await loadInventories(paths)).find(i => i.hostId === config.hostId)?.repositories
      .filter(r => r.canonicalRemote === canonicalRemote) ?? [];
    if (records.length !== 1) throw new Error("Ambiguous local checkout");
    const repository = records[0]!.path;
    if ((await inspectRepositoryPath(repository)).canonicalRemote !== canonicalRemote) throw new Error("Checkout identity changed");
    const row = (await directSyncStatus(paths))?.repositories.find(r => r.canonicalRemote === canonicalRemote && r.branch === selected.branch);
    if (!row?.received || row.transfer.state !== "received" || row.peerHostId !== config.peerHostId)
      throw new Error("No verified current peer receipt for preview");
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const receivedStore = join(paths.stateDirectory, "direct-sync-stores", hash(`${config.peerHostId}:${canonicalRemote}`) + ".git");
    const peerOid = row.received.oid;
    const receiptRef = `refs/received/${hash(selected.branch)}/${peerOid}`;
    if ((await directGit(receivedStore, ["rev-parse", "--verify", receiptRef])).trim() !== peerOid)
      throw new Error("Peer received ref differs");
    const localOid = (await directGit(repository, ["rev-parse", "--verify", "HEAD"])).trim();
    const outputParent = join(paths.stateDirectory, "guardian-proposals");
    await mkdir(outputParent, { recursive: true, mode: 0o700 });
    return prepareGuardianMergePreview({ repository, receivedStore, localOid, peerOid, outputParent });
  });
}
