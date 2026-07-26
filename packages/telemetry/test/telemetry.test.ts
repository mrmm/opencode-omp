import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createTelemetry,
	DEFAULT_TELEMETRY_CONFIG,
	sanitizeTelemetryConfig,
	shortHash,
	stripJsonc,
	Telemetry,
} from "../src/index.ts";

function sink(): string {
	return join(mkdtempSync(join(tmpdir(), "omp-tel-")), "t.jsonl");
}

function read(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function mk(path: string, cfg: Record<string, unknown> = {}): Telemetry {
	return createTelemetry({
		service: "test-service",
		serviceVersion: "9.9.9",
		session: "sess1",
		config: { file: path, flushEvery: 1000, ...cfg },
	});
}

describe("instruments", () => {
	test("counter, histogram, and event all land", () => {
		const p = sink();
		const t = mk(p);
		t.count("a.count", 1, { ext: "ts" });
		t.histogram("a.hist", 42.5, { ext: "ts" });
		t.event("a.event", { detail: "x" });
		t.flush();

		const rows = read(p);
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.instrument).sort()).toEqual(["counter", "event", "histogram"]);
		expect(rows.find((r) => r.name === "a.hist")?.value).toBe(42.5);
		expect(rows.find((r) => r.name === "a.event")?.payload).toEqual({ detail: "x" });
	});

	test("records carry schema, service, and session", () => {
		const p = sink();
		const t = mk(p);
		t.count("x");
		t.flush();
		const r = read(p)[0]!;
		expect(r.v).toBe(1);
		expect(r.service).toBe("test-service");
		expect(r.serviceVersion).toBe("9.9.9");
		expect(r.session).toBe("sess1");
		expect(typeof r.ts).toBe("string");
	});

	test("timer records elapsed milliseconds as a histogram", async () => {
		const p = sink();
		const t = mk(p);
		const stop = t.timer("op.duration_ms");
		await new Promise((r) => setTimeout(r, 12));
		const ms = stop({ result: "ok" });
		t.flush();

		expect(ms).toBeGreaterThan(5);
		const r = read(p)[0]!;
		expect(r.instrument).toBe("histogram");
		expect(r.attributes).toMatchObject({ result: "ok" });
	});

	test("output is valid JSONL — one parseable object per line", () => {
		const p = sink();
		const t = mk(p);
		for (let i = 0; i < 5; i++) t.count("n", i);
		t.flush();
		const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(5);
		for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
	});
});

describe("buffering", () => {
	test("auto-flushes at flushEvery", () => {
		const p = sink();
		const t = mk(p, { flushEvery: 3 });
		t.count("a");
		t.count("b");
		expect(read(p)).toHaveLength(0); // still buffered
		t.count("c");
		expect(read(p)).toHaveLength(3); // threshold reached
	});

	test("flush on an empty buffer is a no-op", () => {
		const p = sink();
		const t = mk(p);
		expect(() => t.flush()).not.toThrow();
		expect(existsSync(p)).toBe(false);
	});
});

describe("disabling", () => {
	test("enabled:false writes nothing and creates no file", () => {
		const p = sink();
		const t = mk(p, { enabled: false });
		t.count("x");
		t.flush();
		expect(t.enabled).toBe(false);
		expect(existsSync(p)).toBe(false);
	});

	test('sinks:["none"] disables all sinks', () => {
		const cfg = sanitizeTelemetryConfig({ sinks: ["none"] });
		expect(cfg.sinks).toEqual([]);
		const p = sink();
		const t = mk(p, cfg);
		t.count("x");
		t.flush();
		expect(existsSync(p)).toBe(false);
	});

	test("close() stops accepting records", () => {
		const p = sink();
		const t = mk(p);
		t.count("before");
		t.close();
		t.count("after");
		t.flush();
		const names = read(p).map((r) => r.name);
		expect(names).toContain("before");
		expect(names).not.toContain("after");
	});
});

describe("redaction", () => {
	test("hashes path-like attributes when enabled", () => {
		const p = sink();
		const t = mk(p, { redactPaths: true });
		t.count("x", 1, { path: "src/secret/file.ts", ext: "ts" });
		t.flush();
		const a = read(p)[0]!.attributes as Record<string, string>;
		expect(a.path).not.toContain("secret");
		expect(a.path).toMatch(/^[0-9a-f]{8}$/);
		expect(a.ext).toBe("ts"); // non-path attributes untouched
	});

	test("leaves paths intact when disabled (the default)", () => {
		const p = sink();
		const t = mk(p, { redactPaths: false });
		t.count("x", 1, { path: "src/a.ts" });
		t.flush();
		expect((read(p)[0]!.attributes as Record<string, string>).path).toBe("src/a.ts");
	});

	test("redacts path arrays inside event payloads", () => {
		const p = sink();
		const t = mk(p, { redactPaths: true });
		t.event("e", { paths: ["a/b.ts", "c/d.ts"] });
		t.flush();
		const paths = (read(p)[0]!.payload as Record<string, string[]>).paths ?? [];
		expect(paths).toHaveLength(2);
		expect(paths.every((x) => /^[0-9a-f]{8}$/.test(x))).toBe(true);
	});

	test("shortHash is stable and differs across inputs", () => {
		expect(shortHash("a")).toBe(shortHash("a"));
		expect(shortHash("a")).not.toBe(shortHash("b"));
	});
});

describe("resilience — telemetry must never break its caller", () => {
	test("an unwritable sink path does not throw", () => {
		const t = mk("/proc/nonexistent/nope/t.jsonl");
		expect(() => {
			t.count("x");
			t.flush();
		}).not.toThrow();
	});

	test("circular payloads do not throw", () => {
		const p = sink();
		const t = mk(p);
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		expect(() => {
			t.event("e", circular);
			t.flush();
		}).not.toThrow();
	});
});

describe("config sanitising", () => {
	test("booleans are shorthand for enabling/disabling", () => {
		expect(sanitizeTelemetryConfig(false)).toEqual({ enabled: false });
		expect(sanitizeTelemetryConfig(true)).toEqual({ enabled: true });
	});

	test("a bare sink name is accepted", () => {
		expect(sanitizeTelemetryConfig({ sinks: "otel" }).sinks).toEqual(["otel"]);
	});

	test("unknown keys and bad values are dropped", () => {
		const c = sanitizeTelemetryConfig({
			bogus: 1,
			maxBytes: -5,
			flushEvery: 0,
			sinks: ["nonsense"],
		});
		expect(c).not.toHaveProperty("bogus");
		expect(c).not.toHaveProperty("maxBytes");
		expect(c).not.toHaveProperty("flushEvery");
		expect(c).not.toHaveProperty("sinks");
	});

	test("defaults are local-only", () => {
		expect(DEFAULT_TELEMETRY_CONFIG.sinks).toEqual(["file"]);
		expect(DEFAULT_TELEMETRY_CONFIG.redactPaths).toBe(false);
	});
});

describe("otel sink", () => {
	test("selecting otel does not throw when no MeterProvider is registered", () => {
		const t = createTelemetry({
			service: "s",
			serviceVersion: "1",
			config: { sinks: ["otel"] },
		});
		expect(() => {
			t.count("x");
			t.flush();
		}).not.toThrow();
	});

	test("file and otel can run together", () => {
		const p = sink();
		const t = mk(p, { sinks: ["file", "otel"] });
		t.count("x");
		t.flush();
		expect(t.sinkKinds).toEqual(["file", "otel"]);
		expect(read(p)).toHaveLength(1); // file sink unaffected by otel
	});
});

describe("stripJsonc", () => {
	test("removes comments and trailing commas", () => {
		const src = `{
  // line comment
  "a": 1, /* block */
  "b": "keep // this",
}`;
		expect(JSON.parse(stripJsonc(src))).toEqual({ a: 1, b: "keep // this" });
	});
});
