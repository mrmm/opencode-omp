/**
 * End-to-end: drive the real plugin the way OpenCode does, and assert the
 * specific failure mode of `opencode-hashline@1.4.0` is gone.
 *
 * Baseline measured on the broken package during verification:
 *   - 0 / 155,460 refs had a correct line number
 *   - 0 / 390 edits succeeded using as-displayed refs
 *   - +37% read output size
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHashlinePlugin } from "../src/index.ts";
import { computeFileHash } from "../src/patch.ts";
import { parseReadOutput } from "../src/read-format.ts";

/** Reproduce OpenCode's Read render (shape proven exact by gate V8). */
function renderRead(absPath: string, content: string, offset = 1, limit = 2000): string {
	const lines = content.split("\n");
	const total = lines.length;
	const start = Math.max(1, offset);
	const end = Math.min(start + limit - 1, total);
	const shown = lines
		.slice(start - 1, end)
		.map((l, i) => `${start + i}: ${l}`)
		.join("\n");
	const footer =
		end < total
			? `(Showing lines ${start}-${end} of ${total}. Use offset=${end + 1} to continue.)`
			: `(End of file - total ${total} lines)`;
	return `<path>${absPath}</path>\n<type>file</type>\n<content>\n${shown}\n\n${footer}\n</content>`;
}

async function bootPlugin(root: string) {
	const factory = createHashlinePlugin({ enabled: true, promptStyle: "full" });
	return factory({
		directory: root,
		worktree: root,
		client: {} as never,
		project: {} as never,
		serverUrl: new URL("http://localhost:1"),
		$: {} as never,
		experimental_workspace: { register: () => {} },
	} as never);
}

function ctxFor(root: string) {
	return {
		sessionID: "test",
		messageID: "m1",
		agent: "test",
		directory: root,
		worktree: root,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	} as never;
}

describe("read hook — anchors on the FILE, not the render", () => {
	test("injects exactly one tag matching the raw file hash", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const content = "alpha\nbeta\ngamma\n";
		const abs = join(root, "a.txt");
		writeFileSync(abs, content);

		const hooks = await bootPlugin(root);
		const output = { title: "Read", output: renderRead(abs, content), metadata: {} };
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c1", args: { filePath: abs } },
			output as never,
		);

		const tags = output.output.split("\n").filter((l) => /^\[.*#[0-9A-F]{4}\]$/.test(l));
		expect(tags).toHaveLength(1);
		expect(tags[0]).toBe(`[a.txt#${computeFileHash(content)}]`);
	});

	test("REGRESSION: line numbers stay file-relative at a deep offset", async () => {
		// The exact failure of opencode-hashline: at offset 200 it emitted ref "4"
		// for file line 200, because it numbered the rendered XML.
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const content = Array.from({ length: 500 }, (_, i) => `OFF_L${i + 1} data`).join("\n");
		const abs = join(root, "big.txt");
		writeFileSync(abs, content);

		const hooks = await bootPlugin(root);
		const output = {
			title: "Read",
			output: renderRead(abs, content, 200, 5),
			metadata: {},
		};
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c2", args: { filePath: abs } },
			output as never,
		);

		const parsed = parseReadOutput(output.output);
		expect(parsed.lines[0]?.lineNumber).toBe(200);
		expect(parsed.lines[0]?.text).toBe("OFF_L200 data");
		expect(parsed.lines[4]?.lineNumber).toBe(204);
	});

	test("REGRESSION: no per-line #HL prefixes (the +37% tax)", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const abs = join(root, "m.txt");
		writeFileSync(abs, content);

		const hooks = await bootPlugin(root);
		const rendered = renderRead(abs, content);
		const output = { title: "Read", output: rendered, metadata: {} };
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c3", args: { filePath: abs } },
			output as never,
		);

		expect(output.output).not.toContain("#HL ");
		const growth = (output.output.length - rendered.length) / rendered.length;
		expect(growth).toBeLessThan(0.02); // vs +0.37 for the broken package
	});

	test("excluded paths are not annotated", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const abs = join(root, "secret.pem");
		writeFileSync(abs, "KEY\n");

		const hooks = await bootPlugin(root);
		const rendered = renderRead(abs, "KEY\n");
		const output = { title: "Read", output: rendered, metadata: {} };
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c4", args: { filePath: abs } },
			output as never,
		);
		expect(output.output).toBe(rendered);
	});

	test("unrecognised render shape passes through untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const abs = join(root, "a.txt");
		writeFileSync(abs, "x\n");

		const hooks = await bootPlugin(root);
		const output = { title: "Read", output: "totally different", metadata: {} };
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c5", args: { filePath: abs } },
			output as never,
		);
		expect(output.output).toBe("totally different");
	});
});

describe("full loop — read the tag, then edit with it", () => {
	test("a tag taken verbatim from read output applies successfully", async () => {
		// The end-to-end scenario that fails 100% of the time on the broken package.
        const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const content = "alpha\nbeta\ngamma\ndelta\n";
		const abs = join(root, "loop.txt");
		writeFileSync(abs, content);

		const hooks = await bootPlugin(root);
		const output = { title: "Read", output: renderRead(abs, content), metadata: {} };
		await hooks["tool.execute.after"]?.(
			{ tool: "read", sessionID: "s", callID: "c6", args: { filePath: abs } },
			output as never,
		);

		// Take the tag exactly as displayed — no oracle, no correction.
		const tagLine = output.output
			.split("\n")
			.find((l) => /^\[.*#[0-9A-F]{4}\]$/.test(l));
		expect(tagLine).toBeDefined();

		const patchTool = (hooks.tool as Record<string, never>)?.hashline_patch as unknown as {
			execute: (a: { patch: string }, c: unknown) => Promise<{ output: string }>;
		};
		const res = await patchTool.execute(
			{ patch: `${tagLine}\nSWAP 2.=2:\n+BETA_FROM_DISPLAYED_TAG` },
			ctxFor(root),
		);

		expect(res.output).toContain("Applied 1 section");
		expect(readFileSync(abs, "utf8")).toBe(
			"alpha\nBETA_FROM_DISPLAYED_TAG\ngamma\ndelta\n",
		);
	});

	test("stale tag is refused with guidance and no write", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-int-"));
		const content = "alpha\nbeta\n";
		const abs = join(root, "s.txt");
		writeFileSync(abs, content);

		const hooks = await bootPlugin(root);
		const patchTool = (hooks.tool as Record<string, never>)?.hashline_patch as unknown as {
			execute: (a: { patch: string }, c: unknown) => Promise<{ output: string }>;
		};
		const res = await patchTool.execute(
			{ patch: `[s.txt#0000]\nSWAP 1.=1:\n+NOPE` },
			ctxFor(root),
		);

		expect(res.output).toContain("Stale anchor");
		expect(res.output).toContain("No files were modified");
		expect(readFileSync(abs, "utf8")).toBe(content);
	});
});

describe("system prompt", () => {
	test("injected once, and not duplicated", async () => {
		const hooks = await bootPlugin(mkdtempSync(join(tmpdir(), "omp-int-")));
		const out = { system: [] as string[] };
		await hooks["experimental.chat.system.transform"]?.({ model: {} } as never, out as never);
		await hooks["experimental.chat.system.transform"]?.({ model: {} } as never, out as never);
		expect(out.system.filter((s) => s.includes("hashline_patch"))).toHaveLength(1);
	});
});
