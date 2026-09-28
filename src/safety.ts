import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { promisify } from "node:util";
import type { AppPaths } from "./config.js";
import { gitReadEnvironment } from "./git.js";
import { isNodeError } from "./storage.js";

const execFileAsync = promisify(execFile);

/** Refuse every application-owned directory when it resolves inside a Git worktree. */
export async function assertAppPathsOutsideGitRepositories(paths: AppPaths): Promise<void> {
  await Promise.all([
    // configFile is a file; all other values below are application-owned directories.
    assertDirectoryOutsideGitRepository(dirname(paths.configFile), paths.configFile),
    assertDirectoryOutsideGitRepository(paths.stateDirectory, paths.stateDirectory),
    assertDirectoryOutsideGitRepository(paths.inventoryDirectory, paths.inventoryDirectory),
    assertDirectoryOutsideGitRepository(paths.bridgeDirectory, paths.bridgeDirectory),
    assertDirectoryOutsideGitRepository(paths.bridgeAcceptedDirectory, paths.bridgeAcceptedDirectory),
    assertDirectoryOutsideGitRepository(paths.bridgeQuarantineDirectory, paths.bridgeQuarantineDirectory),
    assertDirectoryOutsideGitRepository(paths.bridgeOutboxDirectory, paths.bridgeOutboxDirectory),
    assertDirectoryOutsideGitRepository(paths.bridgeClaimsDirectory, paths.bridgeClaimsDirectory),
  ]);
}

async function assertDirectoryOutsideGitRepository(directory: string, displayTarget: string): Promise<void> {
  // Starting at the directory itself (not merely its parent) makes pre-existing
  // directory symlinks resolve before Git containment is checked.
  const ancestor = await nearestExistingAncestor(resolve(directory));
  let repositoryLocation: string;
  try {
    const result = await execFileAsync("/usr/bin/git", ["-C", ancestor, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...gitReadEnvironment(), LC_ALL: "C", LANG: "C" },
    });
    repositoryLocation = await realpath(result.stdout.trim());
  } catch (error: unknown) {
    if (isNotARepositoryError(error)) return;
    throw new Error(`Could not safely determine Git containment for ${displayTarget}`, { cause: error });
  }

  throw new Error(
    `git-sync config/state path must not be inside a Git repository (${repositoryLocation}): ${displayTarget}`,
  );
}

function isNotARepositoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 128 && typeof candidate.stderr === "string" &&
    candidate.stderr.includes("not a git repository");
}

async function nearestExistingAncestor(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      await lstat(current);
      return realpath(current);
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) return current;
      current = parent;
    }
  }
}
