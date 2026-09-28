import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AppPaths } from "./config.js";
import type { HostIdentity } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { readJson, writeJsonAtomic } from "./storage.js";
import { isHostIdentity } from "./validation.js";

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createHostIdentity(
  requestedId?: string,
  now: Date = new Date(),
  systemHostname: string = hostname(),
): HostIdentity {
  const id = requestedId ?? `${sanitizeHostname(systemHostname)}-${randomUUID().slice(0, 8)}`;
  if (!HOST_ID_PATTERN.test(id)) {
    throw new Error(
      "Host id must be 1-128 characters and contain only letters, digits, dot, underscore, or hyphen",
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    hostname: systemHostname,
    createdAt: now.toISOString(),
  };
}

export async function loadHostIdentity(paths: AppPaths): Promise<HostIdentity> {
  return readJson(paths.hostFile, isHostIdentity);
}

export async function saveHostIdentity(paths: AppPaths, identity: HostIdentity): Promise<void> {
  await writeJsonAtomic(paths.hostFile, identity);
}

function sanitizeHostname(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized === "" ? "host" : sanitized.slice(0, 100);
}
