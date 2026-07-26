/**
 * Local-only usage telemetry.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE CONTAINS NO NETWORK CODE, BY DESIGN.                           │
 * │ Events are appended to a JSONL file on this machine and never leave it.  │
 * │ A test greps the shipped source for network primitives so the guarantee  │
 * │ is enforced rather than promised.                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why it exists: the design decisions in this package rest on measurements
 * taken against synthetic corpora. Real events answer questions those cannot —
 * how often the stale-anchor guard actually fires, what the real skip-reason
 * mix is, and what tag overhead costs across a real codebase.
 *
 * Telemetry must never break the plugin: every entry point swallows its own
 * errors and degrades to a no-op.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

export const TELEMETRY_SCHEMA = 1;

export interface TelemetryConfig {
	enabled: boolean;
	/** Override the sink path. */
	path: string | null;
	/** Record a short path hash instead of the relative path. */
	redactPaths: boolean;
	/** Rotate once the sink exceeds this many bytes. */
	maxBytes: number;
}

export const DEFAULT_TELEMETRY: TelemetryConfig = {
	enabled: true,
	path: null,
	redactPaths: false,
	maxBytes: 5_000_000,
};

export type HashlineEvent =
	| {
			kind: "read.tagged";
			ext: string;
			path?: string;
			bytes: number;
			lines: number;
			/** Characters the tag line added. */
			overheadChars: number;
			/** What per-line hashing would have cost instead, for comparison. */
			perLineWouldCost: number;
			ms: number;
	  }
	| { kind: "read.skipped"; reason: string; ext: string; path?: string }
	| {
			kind: "patch.applied";
			sections: number;
			edits: number;
			ms: number;
			paths?: string[];
	  }
	/** The safety net firing. The metric that justifies the whole design. */
	| { kind: "patch.stale"; ext: string; path?: string }
	| { kind: "patch.error"; reason: "parse" | "io" | "other"; message: string };

export interface TelemetryRecord {
	v: number;
	ts: string;
	pkg: "hashline";
	session: string;
	event: HashlineEvent;
}

function defaultSinkPath(): string {
	const base =
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(base, "opencode-omp", "hashline.jsonl");
}

/** Stable short hash for correlating repeat reads without recording structure. */
export function hashPath(p: string): string {
	let h = 2166136261;
	for (let i = 0; i < p.length; i++) {
		h ^= p.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export class Telemetry {
	private buffer: TelemetryRecord[] = [];
	private readonly sink: string;
	private flushing = false;

	constructor(
		private readonly cfg: TelemetryConfig,
		private readonly session: string,
	) {
		this.sink = cfg.path ?? defaultSinkPath();
		if (cfg.enabled) {
			// Best-effort flush on exit; never registered when disabled.
			process.once("exit", () => this.flush());
			process.once("beforeExit", () => this.flush());
		}
	}

	get sinkPath(): string {
		return this.sink;
	}

	/** Record an event. Never throws. */
	record(event: HashlineEvent): void {
		if (!this.cfg.enabled) return;
		try {
			const redacted = this.redact(event);
			this.buffer.push({
				v: TELEMETRY_SCHEMA,
				ts: new Date().toISOString(),
				pkg: "hashline",
				session: this.session,
				event: redacted,
			});
			if (this.buffer.length >= 25) this.flush();
		} catch {
			/* telemetry must never break the plugin */
		}
	}

	private redact(event: HashlineEvent): HashlineEvent {
		if (!this.cfg.redactPaths) return event;
		const e = { ...event } as Record<string, unknown>;
		if (typeof e.path === "string") e.path = hashPath(e.path);
		if (Array.isArray(e.paths)) e.paths = (e.paths as string[]).map(hashPath);
		return e as HashlineEvent;
	}

	/** Append buffered events. Never throws. */
	flush(): void {
		if (!this.cfg.enabled || this.flushing || this.buffer.length === 0) return;
		this.flushing = true;
		const pending = this.buffer;
		this.buffer = [];
		try {
			mkdirSync(dirname(this.sink), { recursive: true });
			this.rotateIfNeeded();
			appendFileSync(
				this.sink,
				`${pending.map((r) => JSON.stringify(r)).join("\n")}\n`,
				"utf8",
			);
		} catch {
			/* dropping telemetry is always preferable to failing a read */
		} finally {
			this.flushing = false;
		}
	}

	private rotateIfNeeded(): void {
		try {
			if (statSync(this.sink).size > this.cfg.maxBytes) {
				renameSync(this.sink, `${this.sink}.1`);
			}
		} catch {
			/* sink absent or unrotatable — nothing to do */
		}
	}
}

/** Extension of a path, without the dot; "none" when there is no extension. */
export function extOf(p: string): string {
	return extname(p).replace(/^\./, "") || "none";
}

/**
 * What per-line hashing would have added, for direct comparison against this
 * package's single tag line. Mirrors the `#HL NNN:hash|` prefix the broken
 * package emitted.
 */
export function perLineOverhead(lines: number, hashLen = 3): number {
	const digits = String(lines).length;
	return lines * ("#HL ".length + digits + 1 + hashLen + 1);
}

export function sanitizeTelemetry(raw: unknown): Partial<TelemetryConfig> {
	if (raw === false) return { enabled: false };
	if (raw === true) return { enabled: true };
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<TelemetryConfig> = {};
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (typeof r.redactPaths === "boolean") out.redactPaths = r.redactPaths;
	if (typeof r.path === "string" && r.path) out.path = r.path;
	else if (r.path === null) out.path = null;
	if (typeof r.maxBytes === "number" && r.maxBytes > 0) {
		out.maxBytes = Math.floor(r.maxBytes);
	}
	return out;
}
