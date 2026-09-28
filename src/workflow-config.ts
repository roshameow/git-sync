import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { AppPaths } from "./config.js";
import { loadHostIdentity } from "./host.js";

export interface WorkflowPeer {
  host: string;
  user: string;
  knownHosts: string;
  fingerprint: string;
  nodeExecutable: string;
  cliEntrypoint: string;
}
export interface WorkflowConfig {
  schemaVersion: 1;
  primaryHostId: string;
  /** The two-host workflow supports zero or one configured peer per host. */
  peers: Record<string, WorkflowPeer>;
  executables: { githubCli: string; python: string };
}
const defaults = { githubCli: "/usr/bin/gh", python: "/usr/bin/python3" };
export const isWorkflowHostId = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export const isWorkflowPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 1 && value.length <= 4096 && isAbsolute(value) &&
  !/[\x00-\x1f\x7f]/.test(value) && normalize(value) === value && !value.endsWith("/");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function validHost(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length <= 253 && value.split(".").every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
function parse(value: unknown): WorkflowConfig {
  if (!object(value) || !fields(value, ["schemaVersion", "primaryHostId", "peers", "executables"]) ||
    value.schemaVersion !== 1 || !isWorkflowHostId(value.primaryHostId) || !object(value.peers) ||
    Object.keys(value.peers).length > 1) throw new Error("Invalid workflow config");
  for (const [id, peer] of Object.entries(value.peers)) {
    if (!isWorkflowHostId(id) || !object(peer) || !fields(peer,
      ["host", "user", "knownHosts", "fingerprint", "nodeExecutable", "cliEntrypoint"]) ||
      !validHost(peer.host) || typeof peer.user !== "string" || peer.user.trim() !== peer.user || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(peer.user) ||
      !isWorkflowPath(peer.knownHosts) || /%|\$\{/.test(peer.knownHosts) ||
      !isWorkflowPath(peer.nodeExecutable) || !isWorkflowPath(peer.cliEntrypoint) ||
      typeof peer.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(peer.fingerprint) ||
      Buffer.from(peer.fingerprint.slice(7), "base64").toString("base64").replace(/=+$/, "") !== peer.fingerprint.slice(7))
      throw new Error("Invalid workflow peer");
  }
  const executables = value.executables === undefined ? {} : value.executables;
  if (!object(executables) || !fields(executables, ["githubCli", "python"]) ||
    Object.values(executables).some(path => !isWorkflowPath(path))) throw new Error("Invalid workflow executables");
  return { schemaVersion: 1, primaryHostId: value.primaryHostId, peers: value.peers as Record<string, WorkflowPeer>,
    executables: { ...defaults, ...executables } };
}
const identity = (st: Stats) => [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(":");
/** No-follow, bounded descriptor read; absence alone enables defaults. */
export async function loadWorkflowConfig(paths: AppPaths): Promise<WorkflowConfig> {
  const file = join(dirname(paths.configFile), "workflow.json"), max = 2 * 1024 * 1024;
  const check = (st: Stats) => {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o600 || st.size > max) throw new Error("Unsafe workflow config file");
  };
  let before: Stats;
  try { before = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: 1, primaryHostId: (await loadHostIdentity(paths)).id, peers: {}, executables: { ...defaults } };
  }
  check(before);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await fd.stat(); check(initial);
    if (identity(initial) !== identity(before)) throw new Error("Workflow config changed during open");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > max) throw new Error("Workflow config exceeds size bound");
    const after = await fd.stat(), named = await lstat(file); check(after); check(named);
    if (identity(initial) !== identity(after) || identity(after) !== identity(named)) throw new Error("Workflow config changed during read");
    return parse(JSON.parse(buffer.subarray(0, size).toString("utf8")));
  } finally { await fd.close(); }
}
export async function workflowPeer(paths: AppPaths, peerHostId: string): Promise<WorkflowPeer> {
  const config = await loadWorkflowConfig(paths);
  if (!isWorkflowHostId(peerHostId) || !Object.hasOwn(config.peers, peerHostId)) throw new Error("Workflow peer is not configured");
  return config.peers[peerHostId]!;
}
