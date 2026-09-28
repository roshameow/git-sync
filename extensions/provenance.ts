import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1 as const;
const PRODUCER = "pi-git-sync-bridge";
const GIT_TIMEOUT_MS = 5_000;
const COMPAT_HOST_IDENTITY_FILES = ["host.json", "host-identity.json", "identity.json"] as const;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Oid = string;
type Trigger = "tool_execution_end" | "agent_settled" | "session_shutdown";

interface SessionState {
	hostId: string;
	repoRoot: string;
	sessionId: string;
	sessionFile: string | null;
	lastHead: Oid | null;
	baselineCapturedAt: string | null;
}

interface Evidence {
	source: "pi-extension";
	trigger: "session_start" | Trigger;
	observation: "session-lifecycle" | "git-head-transition";
	reason?: string;
	toolCallId?: string;
	toolName?: string;
	toolError?: boolean;
	baselineCapturedAt?: string | null;
}

interface BridgeEvent {
	schemaVersion: typeof SCHEMA_VERSION;
	eventId: string;
	eventType: "session.registered" | "commit.observed" | "session.unregistered";
	occurredAt: string;
	producer: typeof PRODUCER;
	hostId: string;
	sessionId: string;
	sessionFile: string | null;
	repoRoot: string;
	before: Oid | null;
	after: Oid | null;
	newCommitOids: Oid[];
	evidence: Evidence;
	confidence: "high" | "medium";
}

function gitSyncHome(): string {
	return path.resolve(process.env.GIT_SYNC_HOME || path.join(os.homedir(), ".config", "git-sync"));
}

function hostIdentityPaths(home: string): string[] {
	const stateHost = process.env.GIT_SYNC_HOME?.trim()
		? path.join(home, "state", "host.json")
		: path.join(
			path.resolve(process.env.XDG_STATE_HOME || path.join(process.env.HOME || os.homedir(), ".local", "state")),
			"git-sync",
			"host.json",
		);
	return [stateHost, ...COMPAT_HOST_IDENTITY_FILES.map((name) => path.join(home, name))];
}

function readHostId(home: string): string | null {
	for (const identityPath of hostIdentityPaths(home)) {
		try {
			const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<string, unknown>;
			const nested = identity.identity && typeof identity.identity === "object"
				? identity.identity as Record<string, unknown>
				: undefined;
			const value = identity.hostId ?? identity.id ?? nested?.hostId ?? nested?.id;
			if (typeof value === "string" && HOST_ID_PATTERN.test(value)) return value;
		} catch {
			// Missing or malformed identity files are ignored. Without a valid host
			// identity the bridge fails closed and emits no events.
		}
	}
	return null;
}

interface GitResult {
	ok: boolean;
	stdout: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			env: {
				...process.env,
				GIT_NO_LAZY_FETCH: "1",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		return { ok: true, stdout: result.stdout.trim() };
	} catch {
		return { ok: false, stdout: "" };
	}
}

async function git(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args);
	return result.ok ? result.stdout : null;
}

async function findRepoRoot(cwd: string): Promise<string | null> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return null;
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
}

interface HeadResult {
	ok: boolean;
	head: Oid | null;
}

async function readHead(repoRoot: string): Promise<HeadResult> {
	const result = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (result.ok) {
		if (!/^[0-9a-f]{40,64}$/i.test(result.stdout)) return { ok: false, head: null };
		return { ok: true, head: result.stdout.toLowerCase() };
	}

	// `rev-parse --verify HEAD` legitimately fails for an unborn repository.
	// `git status` identifies that state explicitly; a broken ref/object fails
	// instead of being mislabeled as an empty history.
	const status = await runGit(repoRoot, [
		"status",
		"--porcelain=v2",
		"--branch",
		"--untracked-files=no",
	]);
	const unborn = status.ok && /^# branch\.oid \(initial\)$/m.test(status.stdout);
	return unborn ? { ok: true, head: null } : { ok: false, head: null };
}

async function listNewCommits(
	repoRoot: string,
	before: Oid | null,
	after: Oid,
): Promise<Oid[] | null> {
	const args = before
		? ["rev-list", "--reverse", after, "--not", before]
		: ["rev-list", "--reverse", after];
	const result = await runGit(repoRoot, args);
	if (!result.ok) return null;
	if (result.stdout === "") return [];
	const commits = result.stdout
		.split("\n")
		.map((oid) => oid.trim().toLowerCase());
	return commits.every((oid) => /^[0-9a-f]{40,64}$/.test(oid)) ? commits : null;
}

function ensurePrivateDir(dir: string): void {
	try {
		const details = fs.lstatSync(dir);
		if (details.isSymbolicLink() || !details.isDirectory()) {
			throw new Error(`Unsafe bridge outbox path: ${dir}`);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	try { fs.chmodSync(dir, 0o700); } catch {}
}

function isWithin(parent: string, candidate: string): boolean {
	const relativePath = path.relative(parent, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
	);
}

function fsyncDir(dir: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(dir, "r");
		fs.fsyncSync(fd);
	} catch {
		// Directory fsync is not supported on every platform/filesystem.
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function atomicWriteEvent(event: BridgeEvent): void {
	const configuredHome = gitSyncHome();
	const configuredOutbox = path.join(configuredHome, "bridge-outbox");
	if (isWithin(event.repoRoot, configuredOutbox)) {
		throw new Error("Bridge outbox must not be inside the observed repository");
	}
	ensurePrivateDir(configuredHome);
	const home = fs.realpathSync(configuredHome);
	const outbox = path.join(home, "bridge-outbox");
	if (isWithin(event.repoRoot, outbox)) {
		throw new Error("Bridge outbox must not resolve inside the observed repository");
	}
	ensurePrivateDir(outbox);
	const stamp = event.occurredAt.replace(/[:.]/g, "-");
	const target = path.join(outbox, `${stamp}_${event.eventId}.json`);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, target);
		try { fs.chmodSync(target, 0o600); } catch {}
		fsyncDir(outbox);
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch {}
		}
		try { fs.rmSync(temporary, { force: true }); } catch {}
		throw error;
	}
}

function makeEvent(
	state: SessionState,
	eventType: BridgeEvent["eventType"],
	before: Oid | null,
	after: Oid | null,
	newCommitOids: Oid[],
	evidence: Evidence,
): BridgeEvent {
	return {
		schemaVersion: SCHEMA_VERSION,
		eventId: randomUUID(),
		eventType,
		occurredAt: new Date().toISOString(),
		producer: PRODUCER,
		hostId: state.hostId,
		sessionId: state.sessionId,
		sessionFile: state.sessionFile,
		repoRoot: state.repoRoot,
		before,
		after,
		newCommitOids,
		evidence,
		confidence: eventType === "commit.observed" ? "medium" : "high",
	};
}

export default function gitSyncBridge(pi: ExtensionAPI): void {
	let state: SessionState | null = null;
	let queue: Promise<void> = Promise.resolve();

	const enqueue = (operation: () => Promise<void> | void): Promise<void> => {
		queue = queue.then(operation, operation).catch(() => {
			// Provenance is best-effort metadata. Never break the Pi lifecycle or a
			// tool result because git or the local outbox is unavailable.
		});
		return queue;
	};

	const observeHead = async (trigger: Trigger, detail: Partial<Evidence> = {}): Promise<void> => {
		const active = state;
		if (!active) return;
		const headResult = await readHead(active.repoRoot);
		if (!headResult.ok) return;
		const after = headResult.head;
		if (after === active.lastHead) return;

		const before = active.lastHead;
		const newCommitOids = after ? await listNewCommits(active.repoRoot, before, after) : [];
		if (newCommitOids === null) return;
		atomicWriteEvent(makeEvent(active, "commit.observed", before, after, newCommitOids, {
			source: "pi-extension",
			trigger,
			observation: "git-head-transition",
			baselineCapturedAt: active.baselineCapturedAt,
			...detail,
		}));
		active.lastHead = after;
	};

	pi.on("session_start", async (event, ctx) => enqueue(async () => {
		state = null;
		const repoRoot = await findRepoRoot(ctx.cwd);
		if (!repoRoot) return;
		const hostId = readHostId(gitSyncHome());
		if (!hostId) return;

		const headResult = await readHead(repoRoot);
		if (!headResult.ok) return;
		const head = headResult.head;
		state = {
			hostId,
			repoRoot,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			lastHead: head,
			baselineCapturedAt: null,
		};
		atomicWriteEvent(makeEvent(state, "session.registered", head, head, [], {
			source: "pi-extension",
			trigger: "session_start",
			observation: "session-lifecycle",
			reason: event.reason,
		}));
	}));

	pi.on("before_agent_start", async (_event, _ctx) => enqueue(async () => {
		if (!state) return;
		const headResult = await readHead(state.repoRoot);
		if (!headResult.ok) return;
		state.lastHead = headResult.head;
		state.baselineCapturedAt = new Date().toISOString();
	}));

	pi.on("tool_execution_end", async (event, _ctx) => enqueue(() => observeHead("tool_execution_end", {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		toolError: event.isError,
	})));

	pi.on("agent_settled", async (_event, _ctx) => enqueue(() => observeHead("agent_settled")));

	pi.on("session_shutdown", async (event, _ctx) => enqueue(async () => {
		if (!state) return;
		await observeHead("session_shutdown");
		const active = state;
		atomicWriteEvent(makeEvent(active, "session.unregistered", active.lastHead, active.lastHead, [], {
			source: "pi-extension",
			trigger: "session_shutdown",
			observation: "session-lifecycle",
			reason: event.reason,
		}));
		state = null;
	}));
}
