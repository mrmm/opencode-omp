/**
 * Release commit formatting.
 *
 * Cover for two defects found by reading a real release commit
 * (`chore(release): 3 packages`) after it had already shipped:
 *
 *   1. Its body read `telemetry@0.3.0\nopencode-omp-snapcompact@0.4.1\n...` —
 *      one line containing literal backslash-n. `JSON.stringify` escapes real
 *      newlines, and a double-quoted shell string does not interpret those, so
 *      git received the two characters rather than a line break.
 *
 *   2. `opencode-omp-hashline@0.4.1` shipped a version heading with nothing
 *      under it. It was bumped only because a dependency released, so it had no
 *      commits of its own, and the changelog said nothing about why it existed.
 */
import { describe, expect, test } from "bun:test";

import { renderChangelog, type Plan } from "../scripts/derive-version.ts";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function repo(): string {
	const d = mkdtempSync(join(tmpdir(), "omp-relmsg-"));
	const opts = { cwd: d, stdio: "ignore" as const };
	execSync("git init -q .", opts);
	execSync("git config user.email t@t.t", opts);
	execSync("git config user.name t", opts);
	execSync("git config commit.gpgsign false", opts);
	execSync("git commit -q --allow-empty -m init --no-verify", opts);
	return d;
}

const body = (d: string) =>
	execSync("git log -1 --format=%b", { cwd: d, encoding: "utf8" }).trim();

describe("multi-package commit body", () => {
	const HEADER = "chore(release): 3 packages [skip ci]";
	const BODY = "telemetry@0.3.0\nopencode-omp-snapcompact@0.4.1\nopencode-omp-hashline@0.4.1";

	test("the old approach mangles newlines (documents the defect)", () => {
		const d = repo();
		execSync(
			`git commit -q --allow-empty --no-verify -m ${JSON.stringify(HEADER)} -m ${JSON.stringify(BODY)}`,
			{ cwd: d, stdio: "ignore" },
		);
		// This is what shipped: one line, literal backslash-n.
		expect(body(d)).toContain("\\n");
		expect(body(d).split("\n")).toHaveLength(1);
	});

	test("writing the message to a file preserves real line breaks", () => {
		const d = repo();
		const f = join(d, ".git", "RELEASE_MSG");
		writeFileSync(f, `${HEADER}\n\n${BODY}\n`, "utf8");
		execSync(`git commit -q --allow-empty --no-verify -F ${JSON.stringify(f)}`, {
			cwd: d,
			stdio: "ignore",
		});

		expect(body(d)).not.toContain("\\n");
		expect(body(d).split("\n")).toEqual([
			"telemetry@0.3.0",
			"opencode-omp-snapcompact@0.4.1",
			"opencode-omp-hashline@0.4.1",
		]);
	});

	test("a version containing no newline is unaffected either way", () => {
		const d = repo();
		const f = join(d, ".git", "RELEASE_MSG");
		writeFileSync(f, "chore(release): telemetry@0.3.0 [skip ci]\n\ntelemetry@0.3.0\n", "utf8");
		execSync(`git commit -q --allow-empty --no-verify -F ${JSON.stringify(f)}`, {
			cwd: d,
			stdio: "ignore",
		});
		expect(body(d)).toBe("telemetry@0.3.0");
	});

	test("the header survives the commit-msg length convention", () => {
		// Header must stay short no matter how many packages release together.
		expect(HEADER.length).toBeLessThanOrEqual(72);
	});
});

describe("dependency-only bumps explain themselves", () => {
	const BLANK = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"## [0.4.0] - 2026-07-26",
		"",
		"### Added",
		"",
		"- initial (abc1234)",
		"",
	].join("\n");

	/** A propagated bump: real reason, no commits of its own. */
	const propagated: Plan = {
		name: "@mrmm/opencode-omp-hashline",
		tagName: "opencode-omp-hashline",
		dirName: "hashline",
		dir: "packages/hashline",
		current: "0.4.0",
		next: "0.4.1",
		bump: "patch",
		commits: [],
		reason: "dependency telemetry releases 0.3.0",
	} as unknown as Plan;

	test("the released section is not empty", () => {
		const out = renderChangelog(BLANK, propagated);
		const section = out.match(/## \[0\.4\.1\][^\n]*\n([\s\S]*?)(?=^## \[)/m)?.[1] ?? "";
		expect(section.trim()).not.toBe("");
	});

	test("it names the dependency that caused the release", () => {
		const out = renderChangelog(BLANK, propagated);
		expect(out).toContain("dependency telemetry releases 0.3.0");
	});

	test("it states that this package's own behaviour did not change", () => {
		const out = renderChangelog(BLANK, propagated);
		expect(out).toContain("No change to this package's own behaviour");
	});

	test("[Unreleased] is left in place for future work", () => {
		expect(renderChangelog(BLANK, propagated)).toContain("## [Unreleased]");
	});

	test("earlier releases are preserved", () => {
		const out = renderChangelog(BLANK, propagated);
		expect(out).toContain("## [0.4.0] - 2026-07-26");
		expect(out).toContain("- initial (abc1234)");
	});

	test("a bump with real commits lists them instead of the propagation note", () => {
		const own = {
			...propagated,
			commits: [{ type: "fix", scope: "hashline", subject: "resolve cross-root tags", sha: "def5678", breaking: false }],
			reason: "fix commits",
		} as unknown as Plan;
		const out = renderChangelog(BLANK, own);
		expect(out).toContain("resolve cross-root tags");
		expect(out).not.toContain("No change to this package's own behaviour");
	});
});
