import { describe, expect, test } from "bun:test";

import {
	formatTagLine,
	injectTag,
	isFileRead,
	parseReadOutput,
} from "../src/read-format.ts";

/**
 * Fixtures captured from LIVE OpenCode Read output during measurement.
 * The reconstruction was proven exact: predicted annotation hashes matched the
 * live plugin 8/8 (428 866 cbe f10 b50 9eb 150 9c0).
 */
const COMPLETE_READ = [
	"<path>/abs/project/thoughts/v8/v8.txt</path>",
	"<type>file</type>",
	"<content>",
	"1: AAA first line",
	"2: BBB second line",
	"3: CCC third line",
	"4: DDD fourth line",
	"5: EEE fifth line",
	"",
	"(End of file - total 5 lines)",
	"</content>",
].join("\n");

const PAGINATED_READ = [
	"<path>/abs/project/offsets.txt</path>",
	"<type>file</type>",
	"<content>",
	"200: OFF_L200 data_200",
	"201: OFF_L201 data_201",
	"202: OFF_L202 data_202",
	"",
	"(Showing lines 200-202 of 500. Use offset=203 to continue.)",
	"</content>",
].join("\n");

describe("parseReadOutput — complete read", () => {
	const parsed = parseReadOutput(COMPLETE_READ);

	test("extracts the path", () => {
		expect(parsed.path).toBe("/abs/project/thoughts/v8/v8.txt");
	});

	test("extracts all content rows with TRUE file line numbers", () => {
		expect(parsed.lines).toHaveLength(5);
		expect(parsed.lines[0]).toMatchObject({ lineNumber: 1, text: "AAA first line" });
		expect(parsed.lines[4]).toMatchObject({ lineNumber: 5, text: "EEE fifth line" });
	});

	test("does NOT treat the footer as a content row", () => {
		expect(parsed.lines.some((l) => l.text.includes("End of file"))).toBe(false);
	});

	test("captures the EOF footer and total (footer refinement)", () => {
		expect(parsed.footer).toBe("(End of file - total 5 lines)");
		expect(parsed.paginated).toBe(false);
		expect(parsed.totalLines).toBe(5);
	});

	test("locates the content element boundaries", () => {
		expect(parsed.contentOpenIndex).toBe(2);
		expect(parsed.contentCloseIndex).toBe(10);
	});
});

describe("parseReadOutput — paginated read", () => {
	const parsed = parseReadOutput(PAGINATED_READ);

	test("line numbers are file-relative, not display-relative (AC-2)", () => {
		// The whole bug in opencode-hashline: display position 1 is file line 200.
		expect(parsed.lines[0]?.lineNumber).toBe(200);
		expect(parsed.lines[2]?.lineNumber).toBe(202);
	});

	test("detects pagination and total", () => {
		expect(parsed.paginated).toBe(true);
		expect(parsed.totalLines).toBe(500);
	});
});

describe("parseReadOutput — resilience", () => {
	test("unknown shape yields no content rows rather than throwing", () => {
		const parsed = parseReadOutput("some entirely different output");
		expect(parsed.contentOpenIndex).toBe(-1);
		expect(parsed.lines).toHaveLength(0);
	});

	test("empty input is safe", () => {
		expect(() => parseReadOutput("")).not.toThrow();
	});

	test("preserves lines whose text is itself numeric-prefixed", () => {
		const out = [
			"<path>/a.txt</path>",
			"<type>file</type>",
			"<content>",
			"1: 42: not a line number",
			"",
			"(End of file - total 1 lines)",
			"</content>",
		].join("\n");
		expect(parseReadOutput(out).lines[0]).toMatchObject({
			lineNumber: 1,
			text: "42: not a line number",
		});
	});
});

describe("injectTag", () => {
	test("places the tag between <type> and <content>", () => {
		const rows = injectTag(COMPLETE_READ, "[thoughts/v8/v8.txt#AF00]").split("\n");
		expect(rows[1]).toBe("<type>file</type>");
		expect(rows[2]).toBe("[thoughts/v8/v8.txt#AF00]");
		expect(rows[3]).toBe("<content>");
	});

	test("leaves every content row byte-identical (no per-line hashing)", () => {
		const after = parseReadOutput(injectTag(COMPLETE_READ, "[x#AAAA]"));
		const before = parseReadOutput(COMPLETE_READ);
		expect(after.lines.map((l) => l.text)).toEqual(before.lines.map((l) => l.text));
		expect(after.lines.map((l) => l.lineNumber)).toEqual(
			before.lines.map((l) => l.lineNumber),
		);
	});

	test("overhead stays under 64 chars regardless of file size (AC-1)", () => {
		const big = [
			"<path>/big.txt</path>",
			"<type>file</type>",
			"<content>",
			...Array.from({ length: 5000 }, (_, i) => `${i + 1}: line ${i}`),
			"",
			"(End of file - total 5000 lines)",
			"</content>",
		].join("\n");
		const tagged = injectTag(big, formatTagLine("big.txt", "AF00"));
		expect(tagged.length - big.length).toBeLessThan(64);
	});

	test("degrades safely when <content> is absent", () => {
		expect(injectTag("no content element", "[a#B]")).toContain("[a#B]");
	});
});

describe("formatTagLine", () => {
	test("renders the canonical bracket form", () => {
		expect(formatTagLine("src/foo.ts", "A3F2")).toBe("[src/foo.ts#A3F2]");
	});
});

describe("isFileRead", () => {
	test("matches known read tools", () => {
		for (const t of ["read", "Read", "file_read", "read_file", "cat", "view"]) {
			expect(isFileRead(t)).toBe(true);
		}
	});

	test("matches namespaced read tools", () => {
		expect(isFileRead("mcp.read")).toBe(true);
	});

	test("rejects mutating tools even with a path arg", () => {
		for (const t of ["write", "edit", "bash", "patch"]) {
			expect(isFileRead(t, { filePath: "/a" })).toBe(false);
		}
	});

	test("path-arg heuristic for unknown non-mutating tools", () => {
		expect(isFileRead("custom_viewer", { filePath: "/a" })).toBe(true);
		expect(isFileRead("custom_viewer")).toBe(false);
	});
});
