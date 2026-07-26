/**
 * Cross-root path resolution.
 *
 * Regression cover for a real failure: a file was read in one repository, and
 * the resulting tag carried `scripts/tool.py` — relative to THAT repository.
 * The edit then ran with a different root, so the same relative path resolved
 * somewhere else and the patch failed with an unhelpful "does it exist?".
 *
 * A tag's path is only meaningful alongside the root it was produced under, so
 * the read hook records the absolute path and resolution consults it first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyPatch,
	computeFileHash,
	forgetPaths,
	knownPathCount,
	PathResolutionError,
	rememberPath,
} from "../src/patch.ts";

const SRC = "alpha\nbeta\ngamma\n";

let repoA: string;
let repoB: string;

beforeEach(() => {
	forgetPaths();
	repoA = mkdtempSync(join(tmpdir(), "omp-rootA-"));
	repoB = mkdtempSync(join(tmpdir(), "omp-rootB-"));
	mkdirSync(join(repoA, "scripts"), { recursive: true });
	writeFileSync(join(repoA, "scripts", "tool.py"), SRC, "utf8");
});

afterEach(() => forgetPaths());

describe("the original failure", () => {
	test("a tag from another root fails clearly instead of silently", async () => {
		// No read was recorded, and repoB has no scripts/tool.py.
		const patch = `[scripts/tool.py#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+CHANGED`;
		await expect(applyPatch(patch, repoB)).rejects.toThrow(PathResolutionError);
	});

	test("the error names every path attempted, not just the relative one", async () => {
		const patch = `[scripts/tool.py#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+CHANGED`;
		try {
			await applyPatch(patch, repoB);
			throw new Error("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			// The old message said only "Cannot read scripts/tool.py — does it exist?"
			expect(msg).toContain("Tried:");
			expect(msg).toContain(repoB); // the absolute path actually attempted
			expect(msg).toContain("relative to the directory the file was read from");
        }
	});

	test("a recorded read makes the cross-root edit succeed", async () => {
		// This is what the read hook now does.
		rememberPath("scripts/tool.py", join(repoA, "scripts", "tool.py"));

		const patch = `[scripts/tool.py#${computeFileHash(SRC)}]\nSWAP 2.=2:\n+BETA_CHANGED`;
		const applied = await applyPatch(patch, repoB); // note: different root

		expect(applied[0]?.path).toBe("scripts/tool.py");
		expect(readFileSync(join(repoA, "scripts", "tool.py"), "utf8")).toBe(
			"alpha\nBETA_CHANGED\ngamma\n",
		);
	});
});

describe("resolution order", () => {
	test("a recorded path wins over a same-named file under the current root", async () => {
		// Both roots have the path; the recorded one must be chosen.
		mkdirSync(join(repoB, "scripts"), { recursive: true });
		writeFileSync(join(repoB, "scripts", "tool.py"), "DECOY\n", "utf8");
		rememberPath("scripts/tool.py", join(repoA, "scripts", "tool.py"));

		await applyPatch(
			`[scripts/tool.py#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+FROM_A`,
			repoB,
		);

		expect(readFileSync(join(repoA, "scripts", "tool.py"), "utf8")).toStartWith("FROM_A");
		expect(readFileSync(join(repoB, "scripts", "tool.py"), "utf8")).toBe("DECOY\n");
	});

	test("falls back to the current root when nothing was recorded", async () => {
		mkdirSync(join(repoB, "scripts"), { recursive: true });
		writeFileSync(join(repoB, "scripts", "tool.py"), SRC, "utf8");

		await applyPatch(
			`[scripts/tool.py#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+LOCAL`,
			repoB,
		);
		expect(readFileSync(join(repoB, "scripts", "tool.py"), "utf8")).toStartWith("LOCAL");
	});

	test("a recorded path that has since been deleted is reported, not silently skipped", async () => {
		rememberPath("scripts/gone.py", join(repoA, "scripts", "gone.py"));
		try {
			await applyPatch(`[scripts/gone.py#ABCD]\nSWAP 1.=1:\n+X`, repoB);
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as Error).message).toContain("recorded at read time, now missing");
		}
	});

	test("an absolute tag path is honoured when it exists", async () => {
		const abs = join(repoA, "scripts", "tool.py");
		await applyPatch(`[${abs}#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+ABS`, repoB);
		expect(readFileSync(abs, "utf8")).toStartWith("ABS");
	});
});

describe("sandboxing still holds", () => {
	test("traversal is refused for paths that were never read", async () => {
		await expect(
			applyPatch(`[../../etc/passwd#ABCD]\nSWAP 1.=1:\n+X`, repoB),
		).rejects.toThrow(/outside the project directory/);
	});

	test("recording does not enable traversal for a different path", async () => {
		rememberPath("scripts/tool.py", join(repoA, "scripts", "tool.py"));
		await expect(
			applyPatch(`[../../etc/passwd#ABCD]\nSWAP 1.=1:\n+X`, repoB),
		).rejects.toThrow(/outside the project directory/);
	});
});

describe("registry bounds", () => {
	test("stays bounded under sustained use", () => {
		forgetPaths();
		for (let i = 0; i < 700; i++) rememberPath(`f${i}.ts`, `/tmp/f${i}.ts`);
		expect(knownPathCount()).toBeLessThanOrEqual(500);
	});

	test("re-recording the same path does not grow the registry", () => {
		forgetPaths();
		rememberPath("a.ts", "/tmp/a.ts");
		rememberPath("a.ts", "/tmp/a.ts");
		rememberPath("a.ts", "/other/a.ts");
		expect(knownPathCount()).toBe(1);
	});
});
