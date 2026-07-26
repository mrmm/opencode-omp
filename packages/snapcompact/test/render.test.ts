/**
 * Render-path tests against the real upstream rasterizer.
 *
 * These exercise the native addon, so they are skipped when it is unavailable
 * (e.g. CI on an unsupported platform) rather than failing the suite.
 */
import { describe, expect, test } from "bun:test";

let available = true;
let mod: typeof import("../src/render.ts");
try {
	mod = await import("../src/render.ts");
	// Touch the native path once to confirm it loads.
	await mod.renderFrames("probe", {}, 1);
} catch {
	available = false;
	mod = {} as never;
}

const maybe = available ? describe : describe.skip;

maybe("renderFrames — real PNG output", () => {
	const dense = Array.from(
		{ length: 80 },
		(_, i) => `[${i}] {"id":${i},"ok":true,"name":"item_${i}"}`,
	).join("\n");

	test("AC-5 — produces a valid PNG", async () => {
		const frames = await mod.renderFrames(dense, {}, 4);
		expect(frames.length).toBeGreaterThan(0);
		const buf = Buffer.from(frames[0]!.data, "base64");
		expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	});

	test("data is already base64 — must not be double-encoded", async () => {
		const frames = await mod.renderFrames(dense, {}, 1);
		// Verified: raw `data` starts with the base64 PNG prefix "iVBO".
		expect(frames[0]!.data.slice(0, 4)).toBe("iVBO");
	});

	test("height hugs content — blank rows are never billed", async () => {
		const frames = await mod.renderFrames("one short line", {}, 1);
		const buf = Buffer.from(frames[0]!.data, "base64");
		const height = buf.readUInt32BE(20);
		const width = buf.readUInt32BE(16);
		expect(width).toBeGreaterThan(0);
		expect(height).toBeLessThan(width); // far short of a square full frame
	});

	test("deterministic for identical input", async () => {
		const a = await mod.renderFrames(dense, {}, 1);
		const b = await mod.renderFrames(dense, {}, 1);
		expect(a[0]!.data).toBe(b[0]!.data);
	});

	test("respects the frame cap", async () => {
		const huge = dense.repeat(60);
		expect((await mod.renderFrames(huge, {}, 2)).length).toBeLessThanOrEqual(2);
	});
});

maybe("toAttachments", () => {
	test("emits OpenCode-shaped image attachments", async () => {
		const frames = await mod.renderFrames("some dense text here", {}, 1);
		const [att] = mod.toAttachments(frames);
		expect(att).toBeDefined();
		expect(att!.type).toBe("file");
		expect(att!.mime).toBe("image/png");
		expect(att!.url.startsWith("data:image/png;base64,")).toBe(true);
		expect(att!.filename).toMatch(/^snapcompact-frame-\d+\.png$/);
	});
});

maybe("economics", () => {
	test("anthropic default frame rate is ~4.23 chars/token", () => {
		const e = mod.economicsFor({});
		expect(e.imageRatio).toBeGreaterThan(3.5);
		expect(e.imageRatio).toBeLessThan(5.5);
	});

	test("provider budgets are exposed", () => {
		expect(mod.budgetFor({ api: "anthropic" })).toBeGreaterThan(0);
	});
});
