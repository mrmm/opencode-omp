import { describe, expect, test } from "bun:test";

import {
	approximateDensity,
	density,
	frameEconomics,
	shouldCompact,
} from "../src/density.ts";

/** Anthropic shape measured during verification gate V5. */
const ANTHROPIC = frameEconomics(13916, 3293); // 4.23 chars/token
const GOOGLE = frameEconomics(13916, 1120); // 12.43 chars/token

/** Corpora matching the V5 measurement table. */
const JSON_DENSE = JSON.stringify(
	Array.from({ length: 300 }, (_, i) => ({
		id: i,
		name: `item_${i}`,
		tags: ["a", "b"],
		meta: { ok: true, score: i * 1.5 },
	})),
	null,
	1,
);

const PROSE_SPARSE = Array.from(
	{ length: 120 },
	(_, i) =>
		`The agent reads the file and decides which lines to change, then emits a patch anchored to content hashes so stale edits are rejected before they corrupt anything. Iteration ${i}.`,
).join("\n");

const TOOL_OUTPUT = Array.from(
	{ length: 300 },
	(_, i) =>
		`[2026-07-26T12:${String(i % 60).padStart(2, "0")}:00Z] INFO  worker=${i % 8} msg="processed batch" count=${i * 13} dur=${i % 97}ms`,
).join("\n");

describe("density — real tokenizer (AC-2)", () => {
	test("JSON measures dense, matching the V5 finding (~2.2 chars/token)", () => {
		const d = density(JSON_DENSE);
		expect(d.ratio).toBeGreaterThan(1.8);
		expect(d.ratio).toBeLessThan(2.8);
	});

	test("prose measures sparse, matching the V5 finding (~5.1 chars/token)", () => {
		const d = density(PROSE_SPARSE);
		expect(d.ratio).toBeGreaterThan(4.3);
	});

	test("real tokenizer disagrees with the chars/4 heuristic on JSON", () => {
		// This gap is exactly why AC-2 forbids the heuristic: chars/4 would
		// misclassify JSON and let unprofitable renders through.
		expect(Math.abs(density(JSON_DENSE).ratio - approximateDensity(JSON_DENSE).ratio))
			.toBeGreaterThan(1);
	});

	test("empty input does not divide by zero", () => {
		expect(density("").ratio).toBe(0);
	});
});

describe("frameEconomics", () => {
	test("anthropic frame yields ~4.23 chars/token", () => {
		expect(ANTHROPIC.imageRatio).toBeCloseTo(4.23, 1);
	});

	test("google frame yields ~12.43 chars/token", () => {
		expect(GOOGLE.imageRatio).toBeCloseTo(12.43, 1);
	});
});

describe("AC-1 — density gate", () => {
	test("COMPACTS dense JSON on anthropic", () => {
		const d = shouldCompact(JSON_DENSE, ANTHROPIC);
		expect(d.compact).toBe(true);
		if (d.compact) expect(d.estimatedSavingPct).toBeGreaterThan(0);
	});

	test("COMPACTS tool output on anthropic", () => {
		expect(shouldCompact(TOOL_OUTPUT, ANTHROPIC).compact).toBe(true);
	});

	test("DECLINES sparse prose on anthropic — the whole point of the gate", () => {
		const d = shouldCompact(PROSE_SPARSE, ANTHROPIC);
		expect(d.compact).toBe(false);
		if (!d.compact) {
			expect(d.reason).toBe("not-dense-enough");
			expect(d.estimatedSavingPct).toBeLessThan(0); // would genuinely cost more
		}
	});

	test("google's better rate compacts prose that anthropic declines", () => {
		expect(shouldCompact(PROSE_SPARSE, ANTHROPIC).compact).toBe(false);
		expect(shouldCompact(PROSE_SPARSE, GOOGLE).compact).toBe(true);
	});

	test("declines input below the length floor", () => {
		const d = shouldCompact("short", ANTHROPIC, { minChars: 2000 });
		expect(d.compact).toBe(false);
		if (!d.compact) expect(d.reason).toBe("too-short");
	});

	test("declines non-vision models", () => {
		const d = shouldCompact(JSON_DENSE, ANTHROPIC, { visionCapable: false });
		expect(d.compact).toBe(false);
		if (!d.compact) expect(d.reason).toBe("model-not-vision-capable");
	});

	test("force bypasses the gate but still reports the loss (AC-3)", () => {
		const d = shouldCompact(PROSE_SPARSE, ANTHROPIC, { force: true });
		expect(d.compact).toBe(true);
		if (d.compact) expect(d.estimatedSavingPct).toBeLessThan(0);
	});

	test("a larger margin is stricter", () => {
		const lenient = shouldCompact(TOOL_OUTPUT, ANTHROPIC, { margin: 0.0 });
		const strict = shouldCompact(TOOL_OUTPUT, ANTHROPIC, { margin: 0.95 });
		expect(lenient.compact).toBe(true);
		expect(strict.compact).toBe(false);
	});

	test("declining always explains why", () => {
		const d = shouldCompact(PROSE_SPARSE, ANTHROPIC);
		if (!d.compact) {
			expect(d.detail).toContain("chars/token");
			expect(d.detail.length).toBeGreaterThan(40);
		}
	});
});

describe("AC-3 — savings are computed, not asserted", () => {
	test("reported saving matches frames x frameTokens vs real token count", () => {
		const d = shouldCompact(JSON_DENSE, ANTHROPIC);
		expect(d.compact).toBe(true);
		if (d.compact) {
			const expected =
				100 * (1 - (d.estimatedFrames * ANTHROPIC.frameTokens) / d.density.tokens);
			expect(d.estimatedSavingPct).toBeCloseTo(expected, 5);
			expect(d.estimatedImageTokens).toBe(d.estimatedFrames * ANTHROPIC.frameTokens);
		}
	});
});

describe("AC-6 — frame budget", () => {
	test("frame count is capped at the budget", () => {
		const huge = JSON_DENSE.repeat(50);
		const d = shouldCompact(huge, ANTHROPIC, { maxFrames: 3 });
		if (d.compact) expect(d.estimatedFrames).toBeLessThanOrEqual(3);
	});
});
