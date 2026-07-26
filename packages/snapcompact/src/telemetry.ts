/**
 * Local-only usage telemetry.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE CONTAINS NO NETWORK CODE, BY DESIGN.                           │
 * │ Events append to a JSONL file on this machine and never leave it.        │
 * │ A test greps the shipped source for network primitives, so the guarantee │
 * │ is enforced rather than promised.                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why it exists: the density thresholds in this package were derived from
 * SYNTHETIC corpora. Only real events can show the true density distribution of
 * the payloads people actually compact — the one number that would confirm or
 * refute the gate's calibration.
 *
 * Telemetry must never break the plugin: every entry point swallows its own
 * errors and degrades to a no-op.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TELEMETRY_SCHEMA = 1;

export interface TelemetryConfig {
	enabled: boolean;
	path: string | null;
	maxBytes: number;
}

export const DEFAULT_TELEMETRY: TelemetryConfig = {
	enabled: true,
	path: null,
	maxBytes: 5_000_000,
};

export type SnapcompactEvent =
	/** The gate said yes. Records what it actually cost. */
	| {
			kind: "gate.compact";
			chars: number;
			tokens: number;
			ratio: number;
			frames: number;
			imageTokens: number;
			savingPct: number;
			forced: boolean;
	  }
	/** The gate said no. `ratio` here is the real-world density distribution. */
	| {
			kind: "gate.decline";
			reason: string;
			chars: number;
			tokens?: number;
			ratio?: number;
			projectedSavingPct?: number;
	  }
	| { kind: "render.done"; frames: number; bytes: number; ms: number }
	| { kind: "render.error"; message: string }
	| { kind: "estimate"; chars: number; ratio: number; wouldCompact: boolean };

export interface TelemetryRecord {
	v: number;
	ts: string;
	pkg: "snapcompact";
	session: string;
	event: SnapcompactEvent;
}

function defaultSinkPath(): string {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(base, "opencode-omp", "snapcompact.jsonl");
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
			process.once("exit", () => this.flush());
			process.once("beforeExit", () => this.flush());
		}
	}

	get sinkPath(): string {
		return this.sink;
	}

	/** Record an event. Never throws. */
	record(event: SnapcompactEvent): void {
		if (!this.cfg.enabled) return;
		try {
			this.buffer.push({
				v: TELEMETRY_SCHEMA,
				ts: new Date().toISOString(),
				pkg: "snapcompact",
				session: this.session,
				event,
			});
			if (this.buffer.length >= 25) this.flush();
		} catch {
			/* telemetry must never break the plugin */
		}
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
			/* dropping telemetry beats failing a render */
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
			/* sink absent or unrotatable */
		}
	}
}

export function sanitizeTelemetry(raw: unknown): Partial<TelemetryConfig> {
	if (raw === false) return { enabled: false };
	if (raw === true) return { enabled: true };
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<TelemetryConfig> = {};
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (typeof r.path === "string" && r.path) out.path = r.path;
	else if (r.path === null) out.path = null;
	if (typeof r.maxBytes === "number" && r.maxBytes > 0) {
		out.maxBytes = Math.floor(r.maxBytes);
	}
	return out;
}
