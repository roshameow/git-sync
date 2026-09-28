import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppPaths } from "./config.js";
import { loadHostIdentity } from "./host.js";
import { pathExists, readJson, writeJsonAtomic } from "./storage.js";
import type { IncidentAcknowledgement, IncidentRecord, IncidentSeverity } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const INCIDENT_ID_PATTERN = /^inc-[0-9a-f-]{36}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;
const MAX_INCIDENTS = 10_000;
const MAX_INCIDENT_BYTES = 64 * 1024;

export async function recordIncident(
  paths: AppPaths,
  input: {
    /** Reserved by a locked producer before journal creation, for crash-safe retry. */
    readonly incidentId?: string;
    readonly incidentType: IncidentRecord["incidentType"];
    readonly severity: IncidentSeverity;
    readonly reasonCode: string;
    readonly summary: string;
  },
  now: Date = new Date(),
): Promise<IncidentRecord> {
  if (!REASON_CODE_PATTERN.test(input.reasonCode)) throw new Error("Invalid incident reason code");
  if (input.summary.length === 0 || input.summary.length > 500 || /[\r\n\0]/.test(input.summary)) {
    throw new Error("Invalid incident summary");
  }
  const identity = await loadHostIdentity(paths);
  if (input.incidentId !== undefined) {
    requireIncidentId(input.incidentId);
    if (await pathExists(resolve(paths.incidentDirectory, `${input.incidentId}.json`))) {
      const original = await getIncident(paths, input.incidentId);
      if (original.hostId !== identity.id || original.incidentType !== input.incidentType ||
          original.reasonCode !== input.reasonCode || original.severity !== input.severity || original.summary !== input.summary)
        throw new Error("Reserved incident identity conflicts with journal");
      return original;
    }
  }
  const incident: IncidentRecord = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: input.incidentId ?? `inc-${randomUUID()}`,
    incidentType: input.incidentType,
    severity: input.severity,
    occurredAt: now.toISOString(),
    hostId: identity.id,
    reasonCode: input.reasonCode,
    summary: input.summary,
  };
  await mkdir(paths.incidentDirectory, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(resolve(paths.incidentDirectory, `${incident.incidentId}.json`), incident);
  return incident;
}

export async function listIncidents(
  paths: AppPaths,
  includeAcknowledged = false,
): Promise<Array<{ readonly incident: IncidentRecord; readonly acknowledged: boolean }>> {
  if (!(await pathExists(paths.incidentDirectory))) return [];
  const names = (await readdir(paths.incidentDirectory)).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_INCIDENTS) throw new Error("Incident journal exceeds its bounded file limit");
  const output: Array<{ incident: IncidentRecord; acknowledged: boolean }> = [];
  for (const name of names) {
    const path = resolve(paths.incidentDirectory, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_INCIDENT_BYTES) {
      throw new Error(`Unsafe incident journal entry: ${name}`);
    }
    const incident = await readJson(path, isIncidentRecord);
    if (name !== `${incident.incidentId}.json`) throw new Error("Incident filename does not match incidentId");
    const acknowledgement = acknowledgementPath(paths, incident.incidentId);
    let acknowledged = false;
    if (await pathExists(acknowledgement)) {
      const value = await readJson(acknowledgement, isIncidentAcknowledgement);
      if (value.incidentId !== incident.incidentId || value.hostId !== incident.hostId) {
        throw new Error(`Incident acknowledgement conflicts with incident ${incident.incidentId}`);
      }
      acknowledged = true;
    }
    if (includeAcknowledged || !acknowledged) output.push({ incident, acknowledged });
  }
  return output.sort((left, right) =>
    left.incident.occurredAt.localeCompare(right.incident.occurredAt) ||
    left.incident.incidentId.localeCompare(right.incident.incidentId));
}

export async function getIncident(paths: AppPaths, incidentId: string): Promise<IncidentRecord> {
  requireIncidentId(incidentId);
  const path = resolve(paths.incidentDirectory, `${incidentId}.json`);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_INCIDENT_BYTES) {
    throw new Error("Unsafe incident journal entry");
  }
  const incident = await readJson(path, isIncidentRecord);
  if (incident.incidentId !== incidentId) throw new Error("Incident filename does not match incidentId");
  return incident;
}

export async function acknowledgeIncident(
  paths: AppPaths,
  incidentId: string,
  now: Date = new Date(),
): Promise<IncidentAcknowledgement> {
  const incident = await getIncident(paths, incidentId);
  const path = acknowledgementPath(paths, incidentId);
  if (await pathExists(path)) return readJson(path, isIncidentAcknowledgement);
  const acknowledgement: IncidentAcknowledgement = {
    schemaVersion: SCHEMA_VERSION,
    incidentId,
    acknowledgedAt: now.toISOString(),
    hostId: incident.hostId,
  };
  await mkdir(paths.incidentAcknowledgementDirectory, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, acknowledgement);
  return acknowledgement;
}

export function classifyAdmissionFailure(error: unknown): { reasonCode: string; summary: string; severity: IncidentSeverity } {
  const message = error instanceof Error ? error.message : "";
  if (/signature|signing key/i.test(message)) {
    return { reasonCode: "invalid-signature", summary: "Registry admission rejected a signature or signing key", severity: "red" };
  }
  if (/rollback|fork|equivocation|non-contiguous/i.test(message)) {
    return { reasonCode: "rollback-or-fork", summary: "Registry admission detected rollback, fork, or discontinuous history", severity: "red" };
  }
  if (/stale|future/i.test(message)) {
    return { reasonCode: "stale-host-state", summary: "Registry admission rejected stale or future-dated host state", severity: "yellow" };
  }
  if (/missing|unexpected|incomplete/i.test(message)) {
    return { reasonCode: "incomplete-snapshot", summary: "Registry admission rejected an incomplete or unexpected snapshot", severity: "yellow" };
  }
  return { reasonCode: "policy-rejected", summary: "Registry admission failed closed; inspect the local registry status", severity: "yellow" };
}

function acknowledgementPath(paths: AppPaths, incidentId: string): string {
  requireIncidentId(incidentId);
  return resolve(paths.incidentAcknowledgementDirectory, `${incidentId}.json`);
}

function requireIncidentId(value: string): void {
  if (!INCIDENT_ID_PATTERN.test(value)) throw new Error("Invalid incident id");
}

function isIncidentRecord(value: unknown): value is IncidentRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "incidentId", "incidentType", "severity", "occurredAt", "hostId", "reasonCode", "summary",
  ])) return false;
  return value.schemaVersion === 1 && typeof value.incidentId === "string" && INCIDENT_ID_PATTERN.test(value.incidentId) &&
    (value.incidentType === "daemon.pass.failed" || value.incidentType === "registry.admission.rejected" || value.incidentType === "sync.attention") &&
    (value.severity === "yellow" || value.severity === "red") && isDateString(value.occurredAt) &&
    typeof value.hostId === "string" && value.hostId.length > 0 && value.hostId.length <= 128 &&
    typeof value.reasonCode === "string" && REASON_CODE_PATTERN.test(value.reasonCode) &&
    typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 500 && !/[\r\n\0]/.test(value.summary);
}

function isIncidentAcknowledgement(value: unknown): value is IncidentAcknowledgement {
  return isRecord(value) && hasExactKeys(value, ["schemaVersion", "incidentId", "acknowledgedAt", "hostId"]) &&
    value.schemaVersion === 1 && typeof value.incidentId === "string" && INCIDENT_ID_PATTERN.test(value.incidentId) &&
    isDateString(value.acknowledgedAt) && typeof value.hostId === "string" && value.hostId.length > 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
