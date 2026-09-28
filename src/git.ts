import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitRef {
  readonly name: string;
  readonly oid: string;
}

export function gitReadEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowedKeys = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "USER"];
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (environment[key] !== undefined) sanitized[key] = environment[key];
  }
  return {
    ...sanitized,
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function runGitRead(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("/usr/bin/git", [
      "-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args,
    ], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: gitReadEnvironment(),
    });
    return result.stdout;
  } catch (error: unknown) {
    throw new Error(`Read-only Git command failed in ${cwd}: git ${args.join(" ")}`, {
      cause: error,
    });
  }
}

export async function tryRunGitRead(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGitRead(cwd, args);
  } catch {
    return null;
  }
}

/** List refs using NUL field separators. Git ref names cannot contain LF or NUL. */
export async function listRefs(cwd: string, prefixes: readonly string[]): Promise<GitRef[]> {
  const output = await runGitRead(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00",
    ...prefixes,
  ]);
  if (output === "") return [];
  const tokens = output.split("\0");
  const refs: GitRef[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    let name = tokens[index] ?? "";
    if (name.startsWith("\n")) name = name.slice(1);
    const oid = tokens[index + 1] ?? "";
    if (name === "" && oid === "") continue;
    if (!name.startsWith("refs/") || name.includes("\n") || !OID_PATTERN.test(oid)) {
      throw new Error(`Git returned an invalid ref record for ${cwd}`);
    }
    refs.push({ name, oid });
  }
  if (refs.length > 20_000) throw new Error(`Too many refs in repository: ${cwd}`);
  return refs.sort((left, right) => left.name.localeCompare(right.name));
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  validateOid(ancestor);
  validateOid(descendant);
  try {
    await runGitRead(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (isExitCode(cause, 1)) return false;
    throw error;
  }
}

export async function listCommitsBetween(
  cwd: string,
  previous: string | null,
  next: string,
  excludedTips: readonly string[] = [],
): Promise<string[]> {
  validateOid(next);
  if (previous !== null) validateOid(previous);
  for (const oid of excludedTips) validateOid(oid);
  const args = ["rev-list", "--reverse", "--max-count=10001", next];
  if (previous !== null) args.push(`^${previous}`);
  for (const oid of excludedTips) args.push(`^${oid}`);
  const output = (await runGitRead(cwd, args)).trim();
  const commits = output === "" ? [] : output.split("\n");
  if (commits.length > 10_000) throw new Error(`Too many new commits in one refs scan: ${cwd}`);
  if (!commits.every((oid) => OID_PATTERN.test(oid))) {
    throw new Error(`Git returned an invalid commit OID for ${cwd}`);
  }
  return commits;
}

export async function isReachableFromRemote(cwd: string, oid: string): Promise<boolean> {
  validateOid(oid);
  const output = await runGitRead(cwd, [
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    "--contains",
    oid,
    "refs/remotes",
  ]);
  return output.trim() !== "";
}

export async function requireCommit(cwd: string, oid: string): Promise<string> {
  validateOid(oid);
  const output = (await runGitRead(cwd, ["rev-parse", "--verify", `${oid}^{commit}`])).trim();
  if (!OID_PATTERN.test(output) || output !== oid) {
    throw new Error(`OID is not the exact commit requested: ${oid}`);
  }
  return output;
}

export function validateOid(oid: string): void {
  if (!OID_PATTERN.test(oid)) {
    throw new Error("Commit OID must be exactly 40 or 64 lowercase hexadecimal characters");
  }
}

function isExitCode(value: unknown, code: number): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
