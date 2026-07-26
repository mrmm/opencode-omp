/**
 * Version-derivation logic.
 *
 * These rules decide released version numbers with no human in the loop, so
 * they get the same scrutiny as shipped code.
 */
import { describe, expect, test } from "bun:test";

import { applyBump, changelogSections, type Commit } from "../scripts/derive-version.ts";

function commit(partial: Partial<Commit>): Commit {
	return {
		sha: "abc12345",
		type: "fix",
		scope: null,
		breaking: false,
		subject: "something",
		files: ["packages/hashline/src/index.ts"],
		...partial,
	};
}

describe("applyBump — stable (1.x and above)", () => {
	test("major resets minor and patch", () => {
		expect(applyBump("1.4.2", "major")).toBe("2.0.0");
	});
	test("minor resets patch", () => {
		expect(applyBump("1.4.2", "minor")).toBe("1.5.0");
	});
	test("patch increments patch", () => {
		expect(applyBump("1.4.2", "patch")).toBe("1.4.3");
	});
	test("none yields no version", () => {
		expect(applyBump("1.4.2", "none")).toBeNull();
	});
});

describe("applyBump — pre-1.0 (semver §4)", () => {
	test("breaking moves MINOR, not MAJOR, while 0.x", () => {
		// Burning 1.0.0 on the first breaking change would wrongly signal
		// stability. Anything may change in 0.y.z.
		expect(applyBump("0.1.0", "major")).toBe("0.2.0");
		expect(applyBump("0.9.3", "major")).toBe("0.10.0");
	});

	test("minor and patch behave normally while 0.x", () => {
		expect(applyBump("0.1.0", "minor")).toBe("0.2.0");
		expect(applyBump("0.1.0", "patch")).toBe("0.1.1");
	});

	test("1.0.0 is only reached deliberately, never by derivation", () => {
		const reachable = ["major", "minor", "patch"].map((b) =>
			applyBump("0.5.0", b as never),
		);
		expect(reachable).not.toContain("1.0.0");
	});
});

describe("applyBump — arithmetic edges", () => {
	test("does not treat versions as decimals", () => {
		expect(applyBump("1.9.0", "minor")).toBe("1.10.0");
		expect(applyBump("1.0.9", "patch")).toBe("1.0.10");
	});
});

describe("changelogSections", () => {
	test("maps commit types to changelog headings", () => {
		const s = changelogSections([
			commit({ type: "feat", subject: "add thing" }),
			commit({ type: "fix", subject: "fix thing" }),
			commit({ type: "perf", subject: "speed up" }),
		]);
		expect([...s.keys()].sort()).toEqual(["Added", "Fixed", "Performance"]);
	});

	test("breaking commits are hoisted to their own section", () => {
		const s = changelogSections([
			commit({ type: "feat", subject: "big change", breaking: true }),
			commit({ type: "fix", subject: "small fix" }),
		]);
		expect(s.has("Breaking")).toBe(true);
		expect(s.get("Breaking")).toHaveLength(1);
		// A breaking commit must not also appear under its ordinary heading.
		expect(s.get("Added")).toBeUndefined();
	});

	test("non-release types are omitted entirely", () => {
		const s = changelogSections([commit({ type: "style", subject: "reformat" })]);
		expect(s.size).toBe(0);
	});

	test("groups multiple commits under one heading", () => {
		const s = changelogSections([
			commit({ type: "fix", subject: "one" }),
			commit({ type: "fix", subject: "two" }),
		]);
		expect(s.get("Fixed")).toHaveLength(2);
	});
});
