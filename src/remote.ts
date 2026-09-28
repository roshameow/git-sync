import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Convert common Git remote syntaxes into a credential-free stable identity.
 * Network remotes become `host[:port]/path`; filesystem remotes become file URLs.
 */
export function normalizeRemote(remote: string, cwd = process.cwd()): string {
  const input = remote.trim();
  if (input === "") throw new Error("Remote cannot be empty");

  if (input.startsWith("file://")) {
    return normalizeLocalPath(fileURLToPath(new URL(input)), cwd);
  }

  if (looksLikeUrl(input)) {
    const url = new URL(input);
    if (url.protocol === "file:") return normalizeLocalPath(fileURLToPath(url), cwd);
    if (url.hostname === "") throw new Error(`Remote URL has no hostname: ${remote}`);

    const path = cleanRepositoryPath(url.pathname);
    if (path === "") throw new Error(`Remote URL has no repository path: ${remote}`);
    const host = url.hostname.toLowerCase();
    const port = normalizedPort(url.protocol, url.port);
    return `${host}${port}/${normalizePathForHost(host, path)}`;
  }

  const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(input);
  if (scp !== null && !isWindowsDrivePath(input)) {
    const host = scp[1];
    const remotePath = scp[2];
    if (host === undefined || remotePath === undefined) throw new Error(`Invalid remote: ${remote}`);
    const path = cleanRepositoryPath(remotePath);
    if (path === "") throw new Error(`Remote has no repository path: ${remote}`);
    const normalizedHost = host.toLowerCase();
    return `${normalizedHost}/${normalizePathForHost(normalizedHost, path)}`;
  }

  return normalizeLocalPath(input, cwd);
}

function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function cleanRepositoryPath(value: string): string {
  let result = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  result = result.replace(/\/{2,}/g, "/");
  if (result.toLowerCase().endsWith(".git")) result = result.slice(0, -4);
  return result.replace(/\/+$/g, "");
}

function normalizedPort(protocol: string, port: string): string {
  if (port === "") return "";
  const isDefault =
    (protocol === "ssh:" && port === "22") ||
    (protocol === "http:" && port === "80") ||
    (protocol === "https:" && port === "443") ||
    (protocol === "git:" && port === "9418");
  return isDefault ? "" : `:${port}`;
}

function normalizePathForHost(host: string, repositoryPath: string): string {
  // GitHub repository owner/name matching is case-insensitive. Preserve path
  // case for generic Git servers, where it can be significant.
  return host === "github.com" ? repositoryPath.toLowerCase() : repositoryPath;
}

function normalizeLocalPath(value: string, cwd: string): string {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return pathToFileURL(absolute).href.replace(/\/$/, "");
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}
