/**
 * OpenCode plugin-loader contract — see the hashline counterpart for context.
 * A single non-function export in a plugin entry aborts loading.
 */
import { describe, expect, test } from "bun:test";

import * as entry from "../src/index.ts";
import * as utils from "../src/utils.ts";

describe("plugin entry export contract", () => {
	test("EVERY export of src/index.ts is a function", () => {
		const offenders = Object.entries(entry)
			.filter(([, v]) => typeof v !== "function")
			.map(([k, v]) => `${k} (${typeof v})`);
		expect(offenders).toEqual([]);
	});

	test("has a default export", () => {
		expect(typeof entry.default).toBe("function");
	});

	test("entry leaks no constants — those belong in ./utils", () => {
		expect(entry).not.toHaveProperty("DEFAULT_CONFIG");
	});
});

describe("utils surface", () => {
	test("gate helpers are reachable from ./utils", () => {
		expect(utils.DEFAULT_CONFIG).toBeDefined();
		expect(typeof utils.density).toBe("function");
		expect(typeof utils.shouldCompact).toBe("function");
	});

	test("ships disabled by default", () => {
		expect(utils.DEFAULT_CONFIG.enabled).toBe(false);
	});
});

describe("plugin invocation", () => {
	const input = {
		directory: "/tmp",
		worktree: "/tmp",
		client: {},
		project: {},
		serverUrl: new URL("http://localhost:1"),
		$: {},
		experimental_workspace: { register: () => {} },
	} as never;

	test("registers both tools by default", async () => {
		const hooks = await entry.SnapcompactPlugin(input);
		expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
			"snapcompact_estimate",
			"snapcompact_render",
		]);
	});

	test("toolPrefix renames both tools", async () => {
		const hooks = await entry.SnapcompactPlugin(input, { toolPrefix: "bitmap" } as never);
		expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
			"bitmap_estimate",
			"bitmap_render",
		]);
	});

	test("registerRenderTool:false leaves only the read-only estimator", async () => {
		const hooks = await entry.SnapcompactPlugin(input, {
			registerRenderTool: false,
		} as never);
		expect(Object.keys(hooks.tool ?? {})).toEqual(["snapcompact_estimate"]);
	});

	test("malformed inline options fall back to defaults", async () => {
		const hooks = await entry.SnapcompactPlugin(input, {
			toolPrefix: "!!bad!!",
			densityMargin: 42,
			shapeOverride: "nonsense",
		} as never);
		expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
			"snapcompact_estimate",
			"snapcompact_render",
		]);
	});
});

describe("config precedence", () => {
	test("inline options override defaults", () => {
		const cfg = utils.resolveConfig(undefined, { enabled: true, densityMargin: 0.25 });
		expect(cfg.enabled).toBe(true);
		expect(cfg.densityMargin).toBe(0.25);
	});

	test("invalid inline values are dropped, not applied", () => {
		const cfg = utils.resolveConfig(undefined, { densityMargin: 5, minChars: -1 });
		expect(cfg.densityMargin).toBe(utils.DEFAULT_CONFIG.densityMargin);
		expect(cfg.minChars).toBe(utils.DEFAULT_CONFIG.minChars);
	});
});
