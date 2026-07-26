/**
 * Local-first telemetry with an optional OpenTelemetry bridge.
 *
 * Standalone and host-agnostic: nothing here knows about any particular
 * application. Point it at a namespace and a service name and it works.
 *
 * Design in one line: instrument with OpenTelemetry semantics, let the sink
 * decide where data goes.
 *
 *   file (default) — JSONL on this machine. No network. Zero dependencies.
 *   otel (opt-in)  — through @opentelemetry/api, so the host's MeterProvider
 *                    routes to OTLP, Prometheus, or anything else.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency, imported lazily. A plugin
 * that never enables the otel sink pays nothing for it — which matters when the
 * consuming package is 400 KB and the OTel API is 2.6 MB on disk.
 *
 * Telemetry never breaks its caller: every public method swallows its own
 * errors and degrades to a no-op.
 */
import { FileSink, defaultSinkPath } from "./sink-file.ts";
import { OtelSink } from "./sink-otel.ts";
import {
	DEFAULT_TELEMETRY_CONFIG,
	TELEMETRY_SCHEMA_VERSION,
	type Attributes,
	type Measurement,
	type Sink,
	type SinkKind,
	type TelemetryConfig,
	type TelemetryRecord,
} from "./types.ts";

export interface TelemetryOptions {
	/** Package name, used as the OTel service and the JSONL filename. */
	service: string;
	serviceVersion: string;
	/**
	 * Directory namespace grouping related services under the state dir.
	 * Defaults to the service name, so a single consumer needs no config.
	 */
	namespace?: string;
	config?: Partial<TelemetryConfig>;
	/** Groups records from one host session. */
	session?: string;
}

/** Stable short hash — correlates repeated values without recording them. */
export function shortHash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

const PATHISH = /(^|[_.])(path|file|dir|paths)$/i;

export class Telemetry {
	private readonly cfg: TelemetryConfig;
	private readonly sinks: Sink[] = [];
	private readonly buffer: TelemetryRecord[] = [];
	private readonly session: string;
	private fileSink: FileSink | null = null;
	private otelSink: OtelSink | null = null;
	private closed = false;

	constructor(private readonly opts: TelemetryOptions) {
		this.cfg = { ...DEFAULT_TELEMETRY_CONFIG, ...opts.config };
		this.session =
			opts.session ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		if (!this.cfg.enabled) return;

		for (const kind of this.cfg.sinks) {
			if (kind === "file") {
				this.fileSink = new FileSink(
					this.cfg.file ?? defaultSinkPath(opts.service, opts.namespace),
					this.cfg.maxBytes,
					(e) => this.debug("file sink", e),
				);
				this.sinks.push(this.fileSink);
			} else if (kind === "otel") {
				this.otelSink = new OtelSink(opts.service, opts.serviceVersion, (e) =>
					this.debug("otel sink", e),
				);
				this.sinks.push(this.otelSink);
			}
		}

		if (this.sinks.length > 0) {
			process.once("exit", () => this.flush());
			process.once("beforeExit", () => this.flush());
		}
	}

	get enabled(): boolean {
		return this.cfg.enabled && this.sinks.length > 0;
	}

	get sinkKinds(): SinkKind[] {
		return this.sinks.map((s) => s.kind);
	}

	get filePath(): string | null {
		return this.fileSink?.filePath ?? null;
	}

	/** Monotonic count of something happening. */
	count(name: string, value = 1, attributes: Attributes = {}): void {
		this.push({ name, instrument: "counter", value, attributes });
	}

	/** A distribution — durations, sizes, ratios. */
	histogram(name: string, value: number, attributes: Attributes = {}): void {
		this.push({ name, instrument: "histogram", value, attributes });
	}

	/** Something a scalar cannot express. Payload reaches the file sink only. */
	event(name: string, payload: Record<string, unknown> = {}, attributes: Attributes = {}): void {
		this.push({ name, instrument: "event", value: 1, attributes, payload });
	}

	/** Start a timer; call the returned function to record elapsed milliseconds. */
	timer(name: string, attributes: Attributes = {}): (extra?: Attributes) => number {
		const t0 = performance.now();
		return (extra: Attributes = {}) => {
			const ms = performance.now() - t0;
			this.histogram(name, ms, { ...attributes, ...extra });
			return ms;
		};
	}

	private push(m: Measurement): void {
		if (!this.enabled || this.closed) return;
		try {
			this.buffer.push({
				...m,
				attributes: this.redact(m.attributes),
				payload: m.payload ? this.redactPayload(m.payload) : undefined,
				v: TELEMETRY_SCHEMA_VERSION,
				ts: new Date().toISOString(),
				service: this.opts.service,
				serviceVersion: this.opts.serviceVersion,
				session: this.session,
			});
			if (this.buffer.length >= this.cfg.flushEvery) this.flush();
		} catch (e) {
			this.debug("record", e);
		}
	}

	private redact(a: Attributes): Attributes {
		if (!this.cfg.redactPaths) return a;
		const out: Attributes = {};
		for (const [k, v] of Object.entries(a)) {
			out[k] = PATHISH.test(k) && typeof v === "string" ? shortHash(v) : v;
		}
		return out;
	}

	private redactPayload(p: Record<string, unknown>): Record<string, unknown> {
		if (!this.cfg.redactPaths) return p;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(p)) {
			if (PATHISH.test(k) && typeof v === "string") out[k] = shortHash(v);
			else if (PATHISH.test(k) && Array.isArray(v)) {
				out[k] = v.map((x) => (typeof x === "string" ? shortHash(x) : x));
			} else out[k] = v;
		}
		return out;
	}

	/** Write buffered records to every sink. Never throws. */
	flush(): void {
		if (this.buffer.length === 0) return;
		const pending = this.buffer.splice(0, this.buffer.length);
		for (const s of this.sinks) {
			try {
				s.write(pending);
			} catch (e) {
				this.debug(`sink ${s.kind}`, e);
			}
		}
	}

	/** Flush and stop accepting records. */
	close(): void {
		this.flush();
		this.closed = true;
	}

	private debug(where: string, e: unknown): void {
		if (this.cfg.debug) console.error(`[telemetry:${this.opts.service}] ${where}:`, e);
	}
}

/** Construct a Telemetry instance. Returns a disabled one if config says so. */
export function createTelemetry(opts: TelemetryOptions): Telemetry {
	return new Telemetry(opts);
}

/** Validate a user-supplied telemetry block; drop anything unrecognised. */
export function sanitizeTelemetryConfig(raw: unknown): Partial<TelemetryConfig> {
	if (raw === false) return { enabled: false };
	if (raw === true) return { enabled: true };
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<TelemetryConfig> = {};

	for (const k of ["enabled", "redactPaths", "debug"] as const) {
		if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
	}
	if (typeof r.file === "string" && r.file) out.file = r.file;
	else if (r.file === null) out.file = null;
	if (typeof r.maxBytes === "number" && r.maxBytes > 0) out.maxBytes = Math.floor(r.maxBytes);
	if (typeof r.flushEvery === "number" && r.flushEvery > 0) {
		out.flushEvery = Math.floor(r.flushEvery);
	}
	if (Array.isArray(r.sinks)) {
		const valid = r.sinks.filter(
			(s): s is SinkKind => s === "file" || s === "otel" || s === "none",
		);
		if (valid.length) out.sinks = valid.includes("none") ? [] : valid;
	}
	// Convenience: `"sinks": "otel"` as a bare string.
	if (typeof r.sinks === "string") {
		const s = r.sinks;
		if (s === "file" || s === "otel") out.sinks = [s];
		else if (s === "none") out.sinks = [];
	}
	return out;
}

export { FileSink, defaultSinkPath, slug } from "./sink-file.ts";
export { OtelSink } from "./sink-otel.ts";
export { layeredConfig, readJsonc, stripJsonc, type LayeredOptions } from "./jsonc.ts";
export {
	DEFAULT_TELEMETRY_CONFIG,
	TELEMETRY_SCHEMA_VERSION,
	type Attributes,
	type Measurement,
	type Sink,
	type SinkKind,
	type TelemetryConfig,
	type TelemetryRecord,
} from "./types.ts";
