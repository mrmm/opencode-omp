/**
 * Patch application over the native-free upstream path.
 *
 * measurement established that `input` + `format` + `apply` import no
 * native code, unlike `Patcher` which pulls `Recovery` -> `@oh-my-pi/pi-natives`
 * (139MB, for a single `diffLineRuns` call). Testing confirmed this path applies
 * SWAP + INS.POST + DEL correctly in one patch.
 *
 * Trade: no 3-way-merge recovery. A stale anchor is rejected rather than merged —
 * a safe failure, and 350x smaller.
 */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { applyEdits } from "@oh-my-pi/hashline/apply";
import { computeFileHash } from "@oh-my-pi/hashline/format";
import { Patch } from "@oh-my-pi/hashline/input";

export interface SectionPlan {
	relPath: string;
	absPath: string;
	expectedTag: string;
	actualTag: string;
	original: string;
	edits: readonly unknown[];
}

export interface AppliedSection {
	path: string;
	startLine: number;
	endLine: number;
	newTag: string;
}

export class StaleAnchorError extends Error {
	constructor(
		readonly path: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(
			`Stale anchor for ${path}: patch is anchored on #${expected} but the file ` +
				`currently hashes to #${actual}. Re-read the file to get a fresh tag.`,
		);
		this.name = "StaleAnchorError";
	}
}

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

/** Keep writes inside the project. */
function resolveInside(root: string, p: string): string {
	const abs = isAbsolute(p) ? p : resolve(root, p);
	const rel = relative(root, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Refusing to edit outside the project directory: ${p}`);
	}
	return abs;
}

/**
 * Preflight every section before writing anything.
 *
 * Mirrors upstream's guarantee that "multi-section patches are preflighted up front
 * so a partial batch never lands" (AC-5).
 */
export async function planPatch(
	patchText: string,
	projectRoot: string,
): Promise<SectionPlan[]> {
	let parsed: Patch;
	try {
		parsed = Patch.parse(patchText);
	} catch (err) {
		throw new PatchParseError(
			`Could not parse patch: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!parsed.sections.length) {
		throw new PatchParseError(
			"Patch contained no sections. Every section starts with [PATH#TAG].",
		);
	}

	const plans: SectionPlan[] = [];
	for (const section of parsed.sections) {
		const relPath = section.path;
		const absPath = resolveInside(projectRoot, relPath);

		let original: string;
		try {
			original = await readFile(absPath, "utf8");
		} catch {
			throw new Error(`Cannot read ${relPath} — does it exist?`);
		}

		const actualTag = computeFileHash(original);
		const expectedTag = section.fileHash;

		if (!expectedTag) {
			throw new PatchParseError(
				`Section for ${relPath} has no #TAG. Anchor it on the tag from your latest read.`,
			);
		}
		if (expectedTag.toUpperCase() !== actualTag.toUpperCase()) {
			throw new StaleAnchorError(relPath, expectedTag, actualTag);
		}

		plans.push({
			relPath,
			absPath,
			expectedTag,
			actualTag,
			original,
			edits: section.edits,
		});
	}
	return plans;
}

/** Apply a preflighted plan. Only called once every section verified. */
export async function commitPatch(
	plans: SectionPlan[],
): Promise<AppliedSection[]> {
	const results: AppliedSection[] = [];
	const written: Array<{ absPath: string; original: string }> = [];

	try {
		for (const plan of plans) {
			const applied = applyEdits(plan.original, plan.edits as never) as {
				text?: string;
				content?: string;
			};
			const next = applied.text ?? applied.content;
			if (typeof next !== "string") {
				throw new Error(`applyEdits returned no text for ${plan.relPath}`);
			}

			await writeFile(plan.absPath, next, "utf8");
			written.push({ absPath: plan.absPath, original: plan.original });

			const touched = (plan.edits as Array<{ lineNum?: number }>)
				.map((e) => e.lineNum)
				.filter((n): n is number => typeof n === "number");

			results.push({
				path: plan.relPath,
				startLine: touched.length ? Math.min(...touched) : 0,
				endLine: touched.length ? Math.max(...touched) : 0,
				newTag: computeFileHash(next),
			});
		}
	} catch (err) {
		// Best-effort rollback so a mid-batch failure doesn't leave a partial write.
		for (const w of written.reverse()) {
			try {
				await writeFile(w.absPath, w.original, "utf8");
			} catch {
				/* rollback is best-effort */
			}
		}
		throw err;
	}

	return results;
}

/** Preflight then commit. */
export async function applyPatch(
	patchText: string,
	projectRoot: string,
): Promise<AppliedSection[]> {
	return commitPatch(await planPatch(patchText, projectRoot));
}

export { computeFileHash };
