/**
 * Release-note extraction.
 *
 * Regression cover for a bug that produced empty release bodies on every
 * release: the original matcher used `(?=^## \[|$)` with the `m` flag, where
 * `$` means end-of-LINE, so the lazy body matched nothing and every release
 * fell back to a placeholder. Nothing failed — the notes were just blank.
 */
import { describe, expect, test } from "bun:test";

import { extractSection } from "../scripts/changelog-notes.ts";

const CHANGELOG = `# Changelog — thing

Format follows Keep a Changelog.

## [Unreleased]

## [0.3.0] - 2026-07-26

### Breaking

- dropped the legacy path (abc1234)

### Added

- a new capability (def5678)

## [0.2.0] - 2026-07-20

### Fixed

- an older fix (aaa1111)

[Unreleased]: https://example.com/compare/v0.3.0...HEAD
[0.3.0]: https://example.com/releases/tag/v0.3.0
`;

describe("extractSection", () => {
	test("captures the full body, not an empty string", () => {
		const body = extractSection(CHANGELOG, "0.3.0");
		expect(body.length).toBeGreaterThan(0);
		expect(body).toContain("### Breaking");
		expect(body).toContain("dropped the legacy path");
		expect(body).toContain("### Added");
		expect(body).toContain("a new capability");
	});

	test("stops at the next version heading", () => {
		const body = extractSection(CHANGELOG, "0.3.0");
		expect(body).not.toContain("0.2.0");
		expect(body).not.toContain("an older fix");
	});

	test("extracts an older version correctly", () => {
		const body = extractSection(CHANGELOG, "0.2.0");
		expect(body).toContain("an older fix");
		expect(body).not.toContain("a new capability");
	});

	test("drops trailing link-reference definitions", () => {
		const body = extractSection(CHANGELOG, "0.2.0");
		expect(body).not.toContain("https://example.com/compare");
		expect(body).not.toMatch(/^\[[^\]]+\]:/m);
	});

	test("returns empty for a version that is absent", () => {
		expect(extractSection(CHANGELOG, "9.9.9")).toBe("");
	});

	test("does not confuse a version with a prefix of another", () => {
		const cl = `## [0.1.0]\n\n- one\n\n## [0.1.0-beta.1]\n\n- beta\n`;
		expect(extractSection(cl, "0.1.0")).toContain("one");
		expect(extractSection(cl, "0.1.0")).not.toContain("beta");
	});

	test("treats dots literally rather than as regex wildcards", () => {
		const cl = `## [1.2.3]\n\n- real\n\n## [1X2X3]\n\n- decoy\n`;
		expect(extractSection(cl, "1.2.3")).toContain("real");
		expect(extractSection(cl, "1.2.3")).not.toContain("decoy");
	});

	test("skips the Unreleased section when asked for a version", () => {
		const body = extractSection(CHANGELOG, "0.3.0");
		expect(body).not.toContain("Unreleased");
	});

	test("handles a final section with no following heading", () => {
		const cl = `## [1.0.0]\n\n### Added\n\n- last thing\n`;
		expect(extractSection(cl, "1.0.0")).toContain("last thing");
	});
});

describe("real changelogs in this repo", () => {
	const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
	const { join } = require("node:path") as typeof import("node:path");
	const ROOT = new URL("..", import.meta.url).pathname;

	for (const [dir, version] of [
		["hashline", "0.3.0"],
		["snapcompact", "0.3.0"],
		["telemetry", "0.1.0"],
	] as const) {
		test(`${dir}@${version} yields a non-empty release body`, () => {
			const p = join(ROOT, "packages", dir, "CHANGELOG.md");
			if (!existsSync(p)) return;
			const body = extractSection(readFileSync(p, "utf8"), version);
			expect(body.length).toBeGreaterThan(20);
		});
	}
});
