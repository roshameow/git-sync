import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type Repo = { id: string; localPath: string; peerPath: string; branch: string };
type HostKey = { wire: string } | { knownHosts: string; fingerprint: string };
export type Config = { peer: { host: string; user: string; hostKey: HostKey }; repos: Repo[];
  stateDirectory: string; pollSeconds: number; applyCleanFastForward: boolean };
export const defaultConfigPath = () => join(homedir(), ".config/git-sync/config.json");
const fail = (): never => { throw new Error("Invalid configuration"); };
const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail();
  return v as Record<string, unknown>;
};
const text = (v: unknown, re: RegExp): string => typeof v === "string" && v.length <= 4096 && re.test(v) ? v : fail();
export const pathValue = (v: unknown): string => {
  const p = text(v, /^[^\x00-\x1f\x7f]+$/);
  return isAbsolute(p) && resolve(p) === p && p !== "/" ? p : fail();
};
export async function privateText(path: string): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o600 || st.size > 65_536) throw new Error("Expected owned 0600 regular file");
    return await fd.readFile("utf8");
  } finally { await fd.close(); }
}
export function wireFingerprint(wire: string): string {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(wire);
  if (!match) fail();
  const bytes = Buffer.from(match![1]!, "base64");
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32 || bytes.toString("base64") !== match![1]) fail();
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}
export function parseConfig(value: unknown): Config {
  const c = object(value, ["peer", "repos", "stateDirectory", "pollSeconds", "applyCleanFastForward"]);
  const p = object(c.peer, ["host", "user", "hostKey"]);
  const host = text(p.host, /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/).toLowerCase();
  if (host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail();
  const user = text(p.user, /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
  const k = object(p.hostKey, ["wire", "knownHosts", "fingerprint"]);
  let hostKey: HostKey;
  if (Object.keys(k).length === 1 && typeof k.wire === "string") {
    wireFingerprint(k.wire); hostKey = { wire: k.wire };
  } else if (Object.keys(k).length === 2 && k.wire === undefined) {
    hostKey = { knownHosts: pathValue(k.knownHosts), fingerprint: text(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/) };
  } else return fail();
  if (!Array.isArray(c.repos) || !c.repos.length || c.repos.length > 100) fail();
  const repos = (c.repos as unknown[]).map(v => {
    const r = object(v, ["id", "localPath", "peerPath", "branch"]);
    const branch = text(r.branch, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
    if (branch.includes("..") || branch.includes("//") || branch.split("/").some(s => !s || s.startsWith(".") || s.endsWith(".") || s.endsWith(".lock"))) fail();
    return { id: text(r.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), localPath: pathValue(r.localPath), peerPath: pathValue(r.peerPath), branch };
  });
  if (new Set(repos.map(r => r.id)).size !== repos.length || new Set(repos.map(r => r.localPath)).size !== repos.length) fail();
  const pollSeconds = c.pollSeconds === undefined ? 60 : c.pollSeconds;
  if (typeof pollSeconds !== "number" || !Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 900) fail();
  const applyCleanFastForward = c.applyCleanFastForward === undefined ? false : c.applyCleanFastForward;
  if (typeof applyCleanFastForward !== "boolean") fail();
  const stateDirectory = pathValue(c.stateDirectory === undefined ? join(homedir(), ".local/state/git-sync") : c.stateDirectory);
  if (/%|\$\{/.test(stateDirectory)) fail();
  return { peer: { host, user, hostKey }, repos, pollSeconds: pollSeconds as number,
    applyCleanFastForward: applyCleanFastForward as boolean, stateDirectory };
}
export const loadConfig = async (path = defaultConfigPath()): Promise<Config> => parseConfig(JSON.parse(await privateText(path)));
export async function pinnedWire(c: Config): Promise<string> {
  const k = c.peer.hostKey;
  if ("wire" in k) return k.wire;
  // Deliberately narrow: one exact, unhashed host entry; no wildcard/CA/alias trust expansion.
  const matches = (await privateText(k.knownHosts)).split(/\r?\n/).map(l => l.trim().split(/\s+/))
    .filter(parts => parts[0] === c.peer.host);
  if (matches.length !== 1) throw new Error("Expected one exact host entry in knownHosts");
  const wire = `${matches[0]![1]} ${matches[0]![2]}`;
  if (wireFingerprint(wire) !== k.fingerprint) throw new Error("Host key fingerprint mismatch");
  return wire;
}
export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
export function sshCommand(knownHosts: string): string {
  // OpenSSH expands ${ENV} and %-tokens after shell parsing: keep the pin literal.
  if (/%|\$\{/.test(knownHosts)) throw new Error("State path cannot contain SSH filename expansions");
  const file = pathValue(knownHosts).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return ["/usr/bin/ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile="${file}"`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"].map(quote).join(" ");
}
