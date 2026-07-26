/**
 * OpenCode plugin-loader contract.
 *
 * The loader calls EVERY export of a plugin entry as a Plugin function. One
 * non-function export aborts loading with "Plugin export is not a function" —
 * which is exactly how this package first failed in a live session, despite a
 * green unit suite. These tests exist so that can never recur silently.
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

	test("exposes the factory and a default instance", () => {
		expect(typeof entry.createHashlinePlugin).toBe("function");
		expect(typeof entry.HashlinePlugin).toBe("function");
	});

	test("entry leaks no constants — those belong in ./utils", () => {
		expect(entry).not.toHaveProperty("DEFAULT_CONFIG");
		expect(entry).not.toHaveProperty("HASHLINE_SYSTEM_PROMPT");
	});
});

describe("utils surface", () => {
	test("constants are reachable from ./utils", () => {
		expect(utils.DEFAULT_CONFIG).toBeDefined();
		expect(typeof utils.HASHLINE_SYSTEM_PROMPT).toBe("string");
		expect(typeof utils.computeFileHash).toBe("function");
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

	test("returns hooks when invoked with no options", async () => {
		const hooks = await entry.HashlinePlugin(input);
		expect(hooks).toBeDefined();
		expect(hooks["tool.execute.after"]).toBeDefined();
		expect(hooks.tool).toBeDefined();
	});

	test("inline options are honoured — registerTool:false drops the tool", async () => {
		const hooks = await entry.HashlinePlugin(input, { registerTool: false } as never);
		expect(hooks.tool).toBeUndefined();
	});

	test("inline options are honoured — annotateReads:false drops the read hook", async () => {
		const hooks = await entry.HashlinePlugin(input, { annotateReads: false } as never);
		expect(hooks["tool.execute.after"]).toBeUndefined();
	});

	test("inline options are honoured — promptStyle:none drops the transform", async () => {
		const hooks = await entry.HashlinePlugin(input, { promptStyle: "none" } as never);
		expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
	});

	test("enabled:false disables everything", async () => {
		const hooks = await entry.HashlinePlugin(input, { enabled: false } as never);
		expect(hooks["tool.execute.after"]).toBeUndefined();
		expect(hooks.tool).toBeUndefined();
		expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
	});

	test("toolName renames the registered tool", async () => {
		const hooks = await entry.HashlinePlugin(input, { toolName: "omp_edit" } as never);
		expect(Object.keys(hooks.tool ?? {})).toEqual(["omp_edit"]);
	});

	test("malformed inline options fall back to defaults instead of throwing", async () => {
		const hooks = await entry.HashlinePlugin(input, {
			toolName: "!!! invalid !!!",
			maxFileSize: -5,
			promptStyle: "nonsense",
		} as never);
		expect(Object.keys(hooks.tool ?? {})).toEqual(["hashline_patch"]);
	});
});
