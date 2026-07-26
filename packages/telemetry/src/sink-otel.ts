/**
 * OpenTelemetry sink.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency. This file must therefore
 * never import it statically — doing so would make a 2.6 MB package mandatory
 * for a plugin that is otherwise 400 KB. It is resolved lazily, and its absence
 * degrades to a no-op.
 *
 * Note the API/SDK split: importing the API alone changes nothing. Metrics only
 * go anywhere once the host application registers a MeterProvider. That is the
 * whole point — this package instruments, the host decides the destination
 * (OTLP, Prometheus, console, anything), and we do not reimplement any of it.
 */
import type { Attributes, Sink, TelemetryRecord } from "./types.ts";

type Counter = { add(value: number, attributes?: Attributes): void };
type Histogram = { record(value: number, attributes?: Attributes): void };
type Meter = {
	createCounter(name: string, opts?: unknown): Counter;
	createHistogram(name: string, opts?: unknown): Histogram;
};

/** Resolve the OTel metrics API if the host installed it. */
async function loadMeter(service: string, version: string): Promise<Meter | null> {
	try {
		// Indirect specifier keeps bundlers from hard-resolving an optional dep.
		const mod = (await import(/* @vite-ignore */ "@opentelemetry/api")) as {
			metrics?: { getMeter(name: string, version?: string): Meter };
		};
		return mod.metrics?.getMeter(service, version) ?? null;
	} catch {
		return null;
	}
}

export class OtelSink implements Sink {
	readonly kind = "otel" as const;

	private meter: Meter | null = null;
	private ready: Promise<void>;
	private readonly counters = new Map<string, Counter>();
	private readonly histograms = new Map<string, Histogram>();
	private pending: TelemetryRecord[] = [];

	constructor(
		service: string,
		version: string,
		private readonly onError?: (e: unknown) => void,
	) {
		this.ready = loadMeter(service, version)
			.then((m) => {
				this.meter = m;
				// Drain anything recorded before the async import resolved.
				const queued = this.pending;
				this.pending = [];
				if (m) this.emit(queued);
			})
			.catch((e) => this.onError?.(e));
	}

	/** Available once the optional dependency has resolved. */
	get active(): boolean {
		return this.meter !== null;
	}

	write(records: TelemetryRecord[]): void {
		if (!this.meter) {
			// Bounded: never let a missing SDK grow memory without limit.
			if (this.pending.length < 500) this.pending.push(...records);
			return;
		}
		this.emit(records);
	}

	private emit(records: TelemetryRecord[]): void {
		const meter = this.meter;
		if (!meter) return;
		for (const r of records) {
			try {
				const attrs: Attributes = { ...r.attributes, session: r.session };
				// Gauges ride the histogram instrument: OTel's sync gauge requires an
				// observable callback, which does not fit a push-at-will API.
				if (r.instrument === "histogram" || r.instrument === "gauge") {
					let h = this.histograms.get(r.name);
					if (!h) {
						h = meter.createHistogram(r.name);
						this.histograms.set(r.name, h);
					}
					h.record(r.value, attrs);
				} else {
					// Events are emitted as counters so they remain aggregatable;
					// their payload is not representable as an OTel metric and is
					// intentionally dropped on this sink.
					let c = this.counters.get(r.name);
					if (!c) {
						c = meter.createCounter(r.name);
						this.counters.set(r.name, c);
					}
					c.add(r.value, attrs);
				}
			} catch (e) {
				this.onError?.(e);
			}
		}
	}

	async flushAsync(): Promise<void> {
		await this.ready;
	}
}
