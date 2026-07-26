import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyPatch,
	computeFileHash,
	planPatch,
	PatchParseError,
	StaleAnchorError,
} from "../src/patch.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-hashline-"));
});

afterEach(() => {
	// tmpdir entries are disposable; explicit cleanup is not required.
});

function write(rel: string, content: string): string {
	const abs = join(root, rel);
	writeFileSync(abs, content, "utf8");
	return abs;
}

const SRC = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

describe("computeFileHash", () => {
	test("is deterministic", () => {
		expect(computeFileHash(SRC)).toBe(computeFileHash(SRC));
	});

	test("changes when content changes", () => {
		expect(computeFileHash(SRC)).not.toBe(computeFileHash(`${SRC}x`));
	});

	test("is a 4-hex tag", () => {
		expect(computeFileHash(SRC)).toMatch(/^[0-9A-F]{4}$/);
	});
});

describe("AC-3 — fresh tag applies", () => {
	test("SWAP replaces exactly the targeted line", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		const applied = await applyPatch(`[a.txt#${tag}]\nSWAP 2.=2:\n+BETA_NEW`, root);

		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
			"alpha\nBETA_NEW\ngamma\ndelta\nepsilon\n",
		);
		expect(applied[0]?.path).toBe("a.txt");
		expect(applied[0]?.newTag).toMatch(/^[0-9A-F]{4}$/);
	});

	test("DEL removes a range", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		await applyPatch(`[a.txt#${tag}]\nDEL 2.=3`, root);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha\ndelta\nepsilon\n");
	});

	test("INS.POST inserts after the anchor", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		await applyPatch(`[a.txt#${tag}]\nINS.POST 1:\n+INSERTED`, root);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
			"alpha\nINSERTED\nbeta\ngamma\ndelta\nepsilon\n",
		);
	});

	test("INS.PRE inserts before the anchor", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		await applyPatch(`[a.txt#${tag}]\nINS.PRE 1:\n+FIRST`, root);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(`FIRST\n${SRC}`);
	});

	test("AC-7 — mixed ops in one patch use ORIGINAL line numbers", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		await applyPatch(
			`[a.txt#${tag}]\nSWAP 2.=2:\n+BETA_NEW\nINS.POST 4:\n+AFTER_DELTA\nDEL 5.=5`,
			root,
		);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
			"alpha\nBETA_NEW\ngamma\ndelta\nAFTER_DELTA\n",
		);
	});

	test("new tag reported matches the written content", async () => {
		write("a.txt", SRC);
		const applied = await applyPatch(
			`[a.txt#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+ALPHA2`,
			root,
		);
		const after = readFileSync(join(root, "a.txt"), "utf8");
		expect(applied[0]?.newTag).toBe(computeFileHash(after));
	});
});

describe("AC-4 — stale tag rejected before any write", () => {
	test("throws StaleAnchorError and leaves the file untouched", async () => {
		write("a.txt", SRC);
		const stale = "0000";
		await expect(
			applyPatch(`[a.txt#${stale}]\nSWAP 1.=1:\n+NOPE`, root),
		).rejects.toThrow(StaleAnchorError);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(SRC);
	});

	test("tag from before an external modification is rejected", async () => {
		write("a.txt", SRC);
		const tag = computeFileHash(SRC);
		write("a.txt", `${SRC}extra\n`); // changed underneath
		await expect(
			applyPatch(`[a.txt#${tag}]\nSWAP 1.=1:\n+NOPE`, root),
		).rejects.toThrow(StaleAnchorError);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(`${SRC}extra\n`);
	});
});

describe("AC-5 — multi-section atomicity", () => {
	test("a stale section prevents ALL writes", async () => {
		write("a.txt", SRC);
		write("b.txt", SRC);
		const fresh = computeFileHash(SRC);
		const patch =
			`[a.txt#${fresh}]\nSWAP 1.=1:\n+A_CHANGED\n` + `[b.txt#0000]\nSWAP 1.=1:\n+B_CHANGED`;

		await expect(applyPatch(patch, root)).rejects.toThrow(StaleAnchorError);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(SRC);
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe(SRC);
	});

	test("all-fresh multi-section patch applies to every file", async () => {
		write("a.txt", SRC);
		write("b.txt", SRC);
		const t = computeFileHash(SRC);
		await applyPatch(
			`[a.txt#${t}]\nSWAP 1.=1:\n+A_CHANGED\n[b.txt#${t}]\nSWAP 1.=1:\n+B_CHANGED`,
			root,
		);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toStartWith("A_CHANGED");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toStartWith("B_CHANGED");
	});
});

describe("AC-6 — duplicate lines are addressable", () => {
	const DUPES = Array.from({ length: 15 }, (_, i) =>
		i % 3 === 0 ? "  }" : `line_${i}`,
	).join("\n");

	test("targets one occurrence, leaves the rest untouched", async () => {
		write("d.txt", DUPES);
		const tag = computeFileHash(DUPES);
		// Line 1 and line 4 are both "  }".
		await applyPatch(`[d.txt#${tag}]\nSWAP 1.=1:\n+TARGETED`, root);
		const out = readFileSync(join(root, "d.txt"), "utf8").split("\n");
		expect(out[0]).toBe("TARGETED");
		expect(out[3]).toBe("  }"); // untouched — exact-string matching cannot do this
	});
});

describe("planPatch — preflight without writing", () => {
	test("returns a plan and writes nothing", async () => {
		write("a.txt", SRC);
		const plans = await planPatch(
			`[a.txt#${computeFileHash(SRC)}]\nSWAP 1.=1:\n+X`,
			root,
		);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.relPath).toBe("a.txt");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(SRC);
	});
});

describe("error handling", () => {
	test("missing #TAG is a parse error", async () => {
		write("a.txt", SRC);
		await expect(applyPatch("[a.txt]\nSWAP 1.=1:\n+X", root)).rejects.toThrow();
	});

	test("empty patch is rejected", async () => {
		await expect(applyPatch("", root)).rejects.toThrow(PatchParseError);
	});

	test("nonexistent file is reported clearly, naming the absolute path tried", async () => {
		// The message must identify WHERE it looked. An earlier version said only
		// "Cannot read nope.txt — does it exist?", which gave no way to see that
		// the path had been resolved against an unexpected root.
		const err = await applyPatch(`[nope.txt#ABCD]\nSWAP 1.=1:\n+X`, root).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Cannot locate nope.txt");
		expect((err as Error).message).toContain(root);
	});

	test("path traversal outside the project is refused", async () => {
		await expect(
			applyPatch(`[../../etc/passwd#ABCD]\nSWAP 1.=1:\n+X`, root),
		).rejects.toThrow(/outside the project/);
	});
});

describe("AC-8 — line endings", () => {
	test("CRLF content round-trips without silent LF conversion", async () => {
		const crlf = "alpha\r\nbeta\r\ngamma\r\n";
		write("c.txt", crlf);
		const tag = computeFileHash(crlf);
		await applyPatch(`[c.txt#${tag}]\nSWAP 2.=2:\n+BETA_NEW`, root);
		const out = readFileSync(join(root, "c.txt"), "utf8");
		expect(out).toContain("BETA_NEW");
		expect(out).toContain("\r\n"); // unmodified lines keep CRLF
	});
});
