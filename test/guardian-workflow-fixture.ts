import { dirname, join } from "node:path";
import type { AppPaths } from "../src/config.js";
import { writeJsonAtomic } from "../src/storage.js";

/** Synthetic public-workflow data only. No real peers, keys, sessions or senders. */
export function workflowFixture(primaryHostId = "host-a", peerHostId = "host-b") {
  return { schemaVersion: 1 as const, primaryHostId,
    peers: { [peerHostId]: { host: "peer.example.invalid", user: "fixture", knownHosts: "/fixture/known hosts",
      fingerprint: `SHA256:${"A".repeat(43)}`, nodeExecutable: "/fixture/node bin/node",
      cliEntrypoint: "/fixture/cli's $dir/cli.js" } },
    executables: { githubCli: "/fixture/gh", python: "/usr/bin/python3" } };
}
export const workflowFixturePath = (paths: AppPaths) => join(dirname(paths.configFile), "workflow.json");
export async function saveWorkflowFixture(paths: AppPaths, primaryHostId = "host-a", peerHostId = "host-b") {
  await writeJsonAtomic(workflowFixturePath(paths), workflowFixture(primaryHostId, peerHostId));
}
export const quotedPeerCommand = (args: string[]) =>
  ["/fixture/node bin/node", "/fixture/cli's $dir/cli.js", ...args].map(s => "'" + s.replace(/'/g, "'\"'\"'") + "'").join(" ");
