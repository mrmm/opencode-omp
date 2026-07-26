/**
 * Metric contract.
 *
 * The verdict report reads these names to price cost against benefit. A rename
 * in a plugin would silently produce a wrong verdict rather than an error, so
 * the names are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelemetry } from "../src/index.ts";

function sink(): string {
	return join(mkdtempSync(join(tmpdir(), "omp-mc-")), "t.jsonl");
}
function read(p: string) {
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("gauge instrument", () => {
	test("records a point-in-time value", () => {
		const p = sink();
		const t = createTelemetry({
			service: "s",
			serviceVersion: "1",
			config: { file: p, flushEvery: 1000 },
		});
		t.gauge("s.standing_cost.total_chars", 2070, { style: "brief" });
		t.flush();
		const r = read(p)[0]!;
		expect(r.instrument).toBe("gauge");
		expect(r.value).toBe(2070);
		expect(r.attributes).toMatchObject({ style: "brief" });
	});

	test("a gauge is not summed like a counter", () => {
		const p = sink();
		const t = createTelemetry({
			service: "s",
			serviceVersion: "1",
			config: { file: p, flushEvery: 1000 },
		});
		t.gauge("g", 100);
		t.gauge("g", 100);
		t.flush();
		// Two records, each the standing value — the reader takes the last, not a sum.
		const vals = read(p).map((r) => r.value);
		expect(vals).toEqual([100, 100]);
	});
});

describe("metric names the verdict report depends on", () => {
	/** Renaming any of these breaks the verdict silently. */
	const HASHLINE = [
		"hashline.standing_cost.system_prompt_chars",
		"hashline.standing_cost.tool_def_chars",
		"hashline.standing_cost.total_chars",
		"hashline.session.started",
		"hashline.read.tagged",
		"hashline.read.skipped",
		"hashline.read.overhead_chars",
		"hashline.read.per_line_would_cost",
		"hashline.patch.attempted",
		"hashline.patch.applied",
		"hashline.patch.stale_anchor",
		"hashline.patch.retry_chars_avoided",
		"hashline.patch.target",
		"hashline.patch.target_occurrences",
		"hashline.patch.error",
	];
	const SNAPCOMPACT = [
		"snapcompact.standing_cost.tool_def_chars",
		"snapcompact.standing_cost.total_chars",
		"snapcompact.session.started",
		"snapcompact.render.invoked",
		"snapcompact.estimate.invoked",
		"snapcompact.gate.compacted",
		"snapcompact.gate.declined",
		"snapcompact.density.chars_per_token",
		"snapcompact.net_tokens_saved",
		"snapcompact.saving_estimate_error_pct",
	];

	test("hashline emits every name the report reads", () => {
		const src = readFileSync(
			join(new URL("../../hashline/src/index.ts", import.meta.url).pathname),
			"utf8",
		);
		const missing = HASHLINE.filter((n) => !src.includes(n));
		expect(missing).toEqual([]);
	});

	test("snapcompact emits every name the report reads", () => {
		const src = readFileSync(
			join(new URL("../../snapcompact/src/index.ts", import.meta.url).pathname),
			"utf8",
		);
		const missing = SNAPCOMPACT.filter((n) => !src.includes(n));
		expect(missing).toEqual([]);
	});

	test("the analysis module reads names the plugins actually emit", () => {
		// Guards the seam that would otherwise fail silently: a plugin renames a
		// metric, the reader keeps looking for the old name, and the verdict is
		// quietly wrong rather than broken.
		const src = readFileSync(
			join(new URL("../src/analyse.ts", import.meta.url).pathname),
			"utf8",
		);
		// Every quoted metric name in the report must exist in one of the lists.
		const referenced = [...src.matchAll(/"((?:hashline|snapcompact)\.[a-z_.]+)"/g)].map(
			(m) => m[1] as string,
		);
		const known = new Set([...HASHLINE, ...SNAPCOMPACT]);
		const unknown = [...new Set(referenced)].filter((n) => !known.has(n));
		expect(unknown).toEqual([]);
	});
});

describe("standing-cost semantics", () => {
	test("prompt + tool definition reconcile to the total", () => {
		const p = sink();
		const t = createTelemetry({
			service: "hashline",
			serviceVersion: "1",
			config: { file: p, flushEvery: 1000 },
		});
		t.gauge("hashline.standing_cost.system_prompt_chars", 473);
		t.gauge("hashline.standing_cost.tool_def_chars", 299);
		t.gauge("hashline.standing_cost.total_chars", 772);
		t.flush();
		const byName = new Map<string, number>(
			read(p).map((r) => [r.name as string, r.value as number]),
		);
		const parts =
			(byName.get("hashline.standing_cost.system_prompt_chars") ?? 0) +
			(byName.get("hashline.standing_cost.tool_def_chars") ?? 0);
		expect(parts).toBe(byName.get("hashline.standing_cost.total_chars") ?? -1);
	});
});
