/**
 * Shared telemetry contract for opencode-omp plugins.
 *
 * Naming follows OpenTelemetry conventions (`<service>.<subject>.<verb>`, dotted,
 * lowercase, snake_case leaves) so the same data is meaningful whether it lands
 * in a local file or an OTLP backend.
 */

/** Attributes attached to a measurement. OTel-compatible scalar types only. */
export type Attributes = Record<string, string | number | boolean | undefined>;

export type SinkKind = "file" | "otel" | "none";

export interface TelemetryConfig {
	/** Master switch. */
	enabled: boolean;
	/**
	 * Where measurements go.
	 *   "file" — append JSONL locally. Default. No network, ever.
	 *   "otel" — emit through @opentelemetry/api; the host app's SDK decides
	 *            the destination. Requires the caller to have registered a
	 *            MeterProvider, otherwise OTel no-ops.
	 *   "none" — record nothing.
	 * Both may be combined: ["file", "otel"].
	 */
	sinks: SinkKind[];
	/** Override the JSONL path. */
	file: string | null;
	/** Rotate the JSONL once it exceeds this many bytes. */
	maxBytes: number;
	/** Replace path-like attribute values with a stable short hash. */
	redactPaths: boolean;
	/** Buffer this many records before writing. */
	flushEvery: number;
	debug: boolean;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
	enabled: true,
	sinks: ["file"],
	file: null,
	maxBytes: 5_000_000,
	redactPaths: false,
	flushEvery: 25,
	debug: false,
};

/** A single measurement. Mirrors an OTel metric plus an optional payload. */
export interface Measurement {
	/** Dotted metric name, e.g. `hashline.patch.applied`. */
	name: string;
	/** counter → monotonic sum; histogram → distribution; event → payload only. */
	instrument: "counter" | "histogram" | "event";
	value: number;
	attributes: Attributes;
	/** Free-form detail for `event`, where a scalar cannot carry the meaning. */
	payload?: Record<string, unknown>;
}

/** What is written to the JSONL sink. */
export interface TelemetryRecord extends Measurement {
	/** Schema version, so a reader can handle format drift. */
	v: number;
	ts: string;
	service: string;
	serviceVersion: string;
	session: string;
}

export const TELEMETRY_SCHEMA_VERSION = 1;

export interface Sink {
	readonly kind: SinkKind;
	write(records: TelemetryRecord[]): void;
	flush?(): void;
}
