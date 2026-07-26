/**
 * Analysis functions behind the CLI.
 *
 * Kept separate from rendering so the numbers can be asserted without parsing
 * terminal output — a report that looks right but computes wrong is the failure
 * mode this guards.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	counterTotal,
	counterWhere,
	FALLBACK_CHARS_PER_TOKEN,
	histStats,
	listSinks,
	load,
	loadTokeniser,
	sessions,
	stateDir,
	summarise,
	verdict,
} from "../src/analyse.ts";
import type { TelemetryRecord } from "../src/types.ts";

function rec(p: Partial<TelemetryRecord>): TelemetryRecord {
	return {
		v: 1,
		ts: "2026-07-26T12:00:00.000Z",
		service: "svc",
		serviceVersion: "1.0.0",
		session: "s1",
		name: "a.b",
		instrument: "counter",
		value: 1,
		attributes: {},
		...p,
	};
}

function fixture(records: TelemetryRecord[]): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-an-"));
	writeFileSync(join(dir, "svc.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	return dir;
}

describe("histStats", () => {
	test("computes percentiles and sum", () => {
		const s = histStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(s.n).toBe(10);
		expect(s.min).toBe(1);
		expect(s.max).toBe(10);
		expect(s.sum).toBe(55);
		expect(s.mean).toBe(5.5);
		expect(s.p50).toBe(5);
	});

	test("empty input does not divide by zero", () => {
		expect(histStats([])).toMatchObject({ n: 0, sum: 0, mean: 0 });
	});

	test("single value is its own percentile", () => {
		expect(histStats([42]).p95).toBe(42);
	});
});

describe("load", () => {
	test("reads JSONL and sorts by timestamp", () => {
		const dir = fixture([
			rec({ ts: "2026-07-26T12:00:02.000Z", name: "second" }),
			rec({ ts: "2026-07-26T12:00:01.000Z", name: "first" }),
		]);
		expect(load(dir).map((r) => r.name)).toEqual(["first", "second"]);
	});

	test("filters by --since", () => {
		const dir = fixture([
			rec({ ts: "2026-07-26T10:00:00.000Z", name: "old" }),
			rec({ ts: "2026-07-26T14:00:00.000Z", name: "new" }),
		]);
		const got = load(dir, { since: "2026-07-26T12:00:00.000Z" });
		expect(got.map((r) => r.name)).toEqual(["new"]);
	});

	test("filters by service substring", () => {
		const dir = fixture([
			rec({ service: "omp-hashline", name: "a" }),
			rec({ service: "omp-snapcompact", name: "b" }),
		]);
		expect(load(dir, { service: "hash" }).map((r) => r.name)).toEqual(["a"]);
	});

	test("survives a torn final line", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-an-"));
		writeFileSync(
			join(dir, "x.jsonl"),
			JSON.stringify(rec({ name: "good" })) + "\n{ broken\n",
		);
		expect(load(dir).map((r) => r.name)).toEqual(["good"]);
	});

	test("missing directory yields nothing rather than throwing", () => {
		expect(() => load("/nonexistent/omp/dir")).not.toThrow();
		expect(load("/nonexistent/omp/dir")).toEqual([]);
	});
});

describe("summarise", () => {
	const dir = fixture([
		rec({ name: "c", instrument: "counter", value: 2, attributes: { ext: "ts" } }),
		rec({ name: "c", instrument: "counter", value: 3, attributes: { ext: "ts" } }),
		rec({ name: "h", instrument: "histogram", value: 10 }),
		rec({ name: "h", instrument: "histogram", value: 20 }),
		rec({ name: "g", instrument: "gauge", value: 100 }),
		rec({ name: "g", instrument: "gauge", value: 200 }),
	]);
	const [s] = summarise(load(dir));

	test("sums counters by attribute set", () => {
		expect(counterTotal(s!, "c")).toBe(5);
	});

	test("aggregates histograms", () => {
		expect(s!.histograms.get("h")?.sum).toBe(30);
	});

	test("a gauge takes the LAST value, never a sum", () => {
		// This distinction matters: standing cost is a level, not an accumulation.
		expect(s!.gauges.get("g")).toBe(200);
	});

	test("counts distinct sessions", () => {
		expect(s!.sessions).toBe(1);
	});
});

describe("counterWhere", () => {
	const dir = fixture([
		rec({ name: "t", value: 3, attributes: { unique: true } }),
		rec({ name: "t", value: 1, attributes: { unique: false } }),
	]);
	const [s] = summarise(load(dir));

	test("restricts a total to one attribute value", () => {
		expect(counterWhere(s!, "t", "unique", true)).toBe(3);
		expect(counterWhere(s!, "t", "unique", false)).toBe(1);
	});

	test("unknown attribute yields zero", () => {
		expect(counterWhere(s!, "t", "nope", true)).toBe(0);
	});
});

describe("tokeniser", () => {
	test("falls back to a documented ratio when no tokenizer is present", () => {
		expect(FALLBACK_CHARS_PER_TOKEN).toBeGreaterThan(3);
		expect(FALLBACK_CHARS_PER_TOKEN).toBeLessThan(5);
	});

	test("loads without throwing either way", async () => {
		const t = await loadTokeniser();
		expect(typeof t.count).toBe("function");
		expect(t.count("hello world")).toBeGreaterThan(0);
		expect(t.fromChars(360)).toBeGreaterThan(0);
	});
});

describe("verdict", () => {
	test("standing cost scales with turns, and dominates when usage is low", () => {
		const dir = fixture([
			rec({ service: "hashline", name: "hashline.standing_cost.total_chars", instrument: "gauge", value: 786 }),
			rec({ service: "hashline", name: "hashline.read.tagged", value: 1 }),
		]);
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const [v] = verdict(summarise(load(dir)), tok, { turnsPerSession: 30 });
		expect(v!.perTurnTokens).toBe(Math.round(786 / 3.6));
		expect(v!.standingCostTokens).toBe(v!.perTurnTokens * 30);
		expect(v!.net).toBeLessThan(0);
	});

	test("turnsPerSession changes the cost, not the gain", () => {
		const dir = fixture([
			rec({ service: "hashline", name: "hashline.standing_cost.total_chars", instrument: "gauge", value: 360 }),
		]);
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const sums = summarise(load(dir));
		const a = verdict(sums, tok, { turnsPerSession: 10 })[0]!;
		const b = verdict(sums, tok, { turnsPerSession: 20 })[0]!;
		expect(b.standingCostTokens).toBe(a.standingCostTokens * 2);
		expect(b.realisedGainTokens).toBe(a.realisedGainTokens);
	});

	test("confidence reflects sample size, not whether the result flatters", () => {
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const thin = fixture([
			rec({ service: "hashline", session: "s1", name: "hashline.patch.attempted", value: 1 }),
		]);
		expect(verdict(summarise(load(thin)), tok)[0]!.confidence).toBe("none");

		const many = fixture(
			Array.from({ length: 40 }, (_, i) =>
				rec({
					service: "hashline",
					session: `s${i % 5}`,
					name: "hashline.patch.attempted",
					value: 1,
				}),
			),
		);
		expect(verdict(summarise(load(many)), tok)[0]!.confidence).not.toBe("none");
	});

	test("insufficient data never recommends a decision", () => {
		const dir = fixture([rec({ service: "hashline", name: "hashline.read.tagged", value: 1 })]);
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const [v] = verdict(summarise(load(dir)), tok);
		expect(v!.recommendation).toContain("INSUFFICIENT DATA");
	});

	test("reports the non-unique target share for hashline", () => {
		const dir = fixture([
			rec({ service: "hashline", session: "a", name: "hashline.patch.attempted", value: 10 }),
			rec({ service: "hashline", session: "b", name: "hashline.patch.target", value: 3, attributes: { unique: false } }),
			rec({ service: "hashline", session: "b", name: "hashline.patch.target", value: 1, attributes: { unique: true } }),
		]);
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const [v] = verdict(summarise(load(dir)), tok);
		expect(v!.notes.join(" ")).toContain("3/4");
	});

	test("flags snapcompact as pure cost when it never rendered", () => {
		const dir = fixture([
			rec({ service: "snapcompact", name: "snapcompact.standing_cost.total_chars", instrument: "gauge", value: 426 }),
			rec({ service: "snapcompact", name: "snapcompact.estimate.invoked", value: 1 }),
		]);
		const tok = { count: (s: string) => s.length, fromChars: (c: number) => Math.round(c / 3.6), exact: false };
		const [v] = verdict(summarise(load(dir)), tok);
		expect(v!.notes.join(" ")).toContain("never actually rendered");
	});
});

describe("sessions", () => {
	test("groups by service and session", () => {
		const dir = fixture([
			rec({ service: "a", session: "s1" }),
			rec({ service: "a", session: "s1" }),
			rec({ service: "a", session: "s2" }),
			rec({ service: "b", session: "s1" }),
		]);
		const rows = sessions(load(dir));
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.service === "a" && r.session === "s1")?.records).toBe(2);
	});
});

describe("listSinks / stateDir", () => {
	test("reports record counts and sizes", () => {
		const dir = fixture([rec({}), rec({})]);
		const sinks = listSinks(dir);
		expect(sinks).toHaveLength(1);
		expect(sinks[0]?.records).toBe(2);
		expect(sinks[0]?.bytes).toBeGreaterThan(0);
	});

	test("stateDir honours XDG_STATE_HOME", () => {
		const prev = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = "/tmp/xdg-probe";
		expect(stateDir("ns")).toBe("/tmp/xdg-probe/ns");
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	});
});
