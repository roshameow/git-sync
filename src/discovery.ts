import { execFile } from "node:child_process";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AppConfig, GitMarkerKind, HostIdentity, HostInventory, RepositoryRecord } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { normalizeRemote } from "./remote.js";
import { gitReadEnvironment } from "./git.js";
import { isNodeError } from "./storage.js";

const execFileAsync = promisify(execFile);

interface Marker {
  readonly kind: GitMarkerKind;
}

export async function discoverRepositories(
  config: AppConfig,
  identity: HostIdentity,
  now: Date = new Date(),
): Promise<HostInventory> {
  const repositories: RepositoryRecord[] = [];
  const visitedDirectories = new Set<string>();
  const discoveredRepositories = new Set<string>();
  const exclusions = await canonicalizeExclusions(config.excludedDirectories);

  for (const configuredRoot of config.roots) {
    const root = await requireDirectory(configuredRoot);
    await walk(root, true);
  }

  repositories.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    hostId: identity.id,
    generatedAt: now.toISOString(),
    roots: [...config.roots],
    repositories,
  };

  async function walk(directory: string, explicitRoot: boolean): Promise<void> {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch (error: unknown) {
      if (!explicitRoot && isSkippableTraversalError(error)) return;
      throw error;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    if (!explicitRoot && isExcluded(canonicalDirectory, exclusions)) return;

    let marker: Marker | null;
    try {
      marker = await inspectGitMarker(canonicalDirectory);
    } catch (error: unknown) {
      if (!explicitRoot && isSkippableTraversalError(error)) return;
      throw error;
    }
    if (marker !== null && !discoveredRepositories.has(canonicalDirectory)) {
      repositories.push(await inspectRepository(canonicalDirectory, marker));
      discoveredRepositories.add(canonicalDirectory);
    }

    let directoryHandle: Awaited<ReturnType<typeof opendir>>;
    try {
      directoryHandle = await opendir(canonicalDirectory);
    } catch (error: unknown) {
      if (!explicitRoot && isSkippableTraversalError(error)) return;
      throw error;
    }
    for await (const entry of directoryHandle) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const child = resolve(canonicalDirectory, entry.name);
      if (isExcluded(child, exclusions)) continue;
      await walk(child, false);
    }
  }
}

async function requireDirectory(path: string): Promise<string> {
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Discovery root does not exist: ${path}`);
    }
    throw error;
  }
  if (!details.isDirectory()) throw new Error(`Discovery root is not a directory: ${path}`);
  return realpath(path);
}

async function canonicalizeExclusions(exclusions: readonly string[]): Promise<string[]> {
  return Promise.all(
    exclusions.map(async (exclusion) => {
      if (!isAbsolute(exclusion)) return exclusion;
      try {
        return await realpath(exclusion);
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") return resolve(exclusion);
        throw error;
      }
    }),
  );
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((exclusion) => {
    if (isAbsolute(exclusion)) {
      const absolute = resolve(exclusion);
      const relativePath = relative(absolute, path);
      return (
        relativePath === "" ||
        (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
      );
    }
    return basename(path) === exclusion;
  });
}

function isSkippableTraversalError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
  );
}

async function inspectGitMarker(repositoryPath: string): Promise<Marker | null> {
  const markerPath = resolve(repositoryPath, ".git");
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(markerPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  if (details.isDirectory()) return { kind: "directory" };
  if (!details.isFile()) return null;

  const contents = await readFile(markerPath, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(contents);
  const target = match?.[1];
  if (target === undefined) return null;
  const gitDirectory = isAbsolute(target) ? target : resolve(dirname(markerPath), target);
  try {
    if ((await stat(gitDirectory)).isDirectory()) return { kind: "file" };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  return null;
}

export async function inspectRepositoryPath(repositoryPath: string): Promise<RepositoryRecord> {
  const path = await realpath(repositoryPath);
  const marker = await inspectGitMarker(path);
  if (marker === null) throw new Error(`Path is not a Git worktree: ${repositoryPath}`);
  return inspectRepository(path, marker);
}

async function inspectRepository(path: string, marker: Marker): Promise<RepositoryRecord> {
  await runGit(path, ["rev-parse", "--show-toplevel"]);
  const remote = await selectRemote(path);
  const worktree = marker.kind === "file" ? await isLinkedWorktree(path) : false;
  return {
    path,
    gitMarker: marker.kind,
    worktree,
    remoteName: remote?.name ?? null,
    canonicalRemote: remote === null ? null : normalizeRemote(remote.url, path),
  };
}

async function selectRemote(path: string): Promise<{ name: string; url: string } | null> {
  const origin = await tryRunGit(path, ["config", "--get", "remote.origin.url"]);
  if (origin !== null && origin !== "") return { name: "origin", url: origin };

  const output = await tryRunGit(path, ["remote"]);
  const remotes = (output ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .sort((left, right) => left.localeCompare(right));
  const first = remotes[0];
  if (first === undefined) return null;
  const url = await runGit(path, ["config", "--get", `remote.${first}.url`]);
  return { name: first, url };
}

async function isLinkedWorktree(path: string): Promise<boolean> {
  const gitDirectory = await tryRunGit(path, ["rev-parse", "--absolute-git-dir"]);
  const commonDirectory = await tryRunGit(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return gitDirectory !== null && commonDirectory !== null && resolve(gitDirectory) !== resolve(commonDirectory);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("/usr/bin/git", [
      "-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args,
    ], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: gitReadEnvironment(),
    });
    return result.stdout.trim();
  } catch (error: unknown) {
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}`, { cause: error });
  }
}

async function tryRunGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}
