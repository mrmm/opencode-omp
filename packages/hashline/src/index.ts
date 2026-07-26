/**
 * opencode-omp-hashline — file-hash-anchored patch editing for OpenCode.
 *
 * Wraps upstream `@oh-my-pi/hashline` (MIT, Can Boluk). Nothing is reimplemented;
 * the patch language, hashing, and applier all come from the original package.
 *
 * What this plugin restores that `opencode-hashline@1.4.0` broke:
 *
 *   - Anchors on RAW FILE CONTENT, never on the rendered Read output.
 *     The broken package did `const content = output.output` — the already-rendered
 *     XML — producing refs that address display positions. Measured: 0/155,460 refs
 *     had a correct line number and 0/390 edits succeeded.
 *
 *   - ONE 4-hex tag per file instead of a hash on every line. OpenCode already
 *     emits `N: ` line numbers, which is exactly the addressing the patch language
 *     consumes. Overhead drops from +37% to under 64 characters per read.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { loadConfig, type HashlineConfig } from "./config.ts";
import {
	applyPatch,
	PatchParseError,
	StaleAnchorError,
	computeFileHash,
} from "./patch.ts";
import { HASHLINE_SYSTEM_PROMPT } from "./prompt.ts";
import { formatTagLine, injectTag, isFileRead, parseReadOutput } from "./read-format.ts";

function matchesGlob(path: string, pattern: string): boolean {
	const rx = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${rx}$`).test(path);
}

function isExcluded(path: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesGlob(path, p));
}

function toRelative(root: string, abs: string): string {
	const rel = relative(root, abs);
	return !rel || rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
}

export function createHashlinePlugin(userConfig?: Partial<HashlineConfig>): Plugin {
	return async ({ directory, worktree }) => {
		const root = worktree || directory || process.cwd();
		const cfg: HashlineConfig = { ...loadConfig(root), ...userConfig };
		const log = (...a: unknown[]) => {
			if (cfg.debug) console.error("[omp-hashline]", ...a);
		};

		return {
			/**
			 * Inject the file tag into read output.
			 *
			 * Reads the RAW file from disk — never trusts `output.output` for content.
			 * That distinction is the entire fix.
			 */
			"tool.execute.after": async (input, output) => {
				if (!cfg.enabled) return;
				if (!isFileRead(input.tool, input.args)) return;
				if (typeof output.output !== "string" || !output.output) return;

				const args = (input.args ?? {}) as Record<string, unknown>;
				const rawPath = args.filePath ?? args.path ?? args.file;
				if (typeof rawPath !== "string") return;

				const absPath = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
				const relPath = toRelative(root, absPath);

				if (isExcluded(relPath, cfg.exclude) || isExcluded(absPath, cfg.exclude)) {
					log("excluded", relPath);
					return;
				}

				// Only annotate output we actually recognise; unknown shapes pass through
				// untouched so a host render change degrades to "no tag", never corruption.
				const parsed = parseReadOutput(output.output);
				if (parsed.contentOpenIndex === -1 || parsed.lines.length === 0) {
					log("unrecognised read shape, skipping", relPath);
					return;
				}

				let content: string;
				try {
					content = await readFile(absPath, "utf8");
				} catch {
					log("unreadable, skipping", absPath);
					return;
				}

				if (Buffer.byteLength(content, "utf8") > cfg.maxFileSize) {
					log("too large, skipping", relPath);
					return;
				}

				const tag = computeFileHash(content);
				output.output = injectTag(output.output, formatTagLine(relPath, tag));
				log("tagged", relPath, tag);
			},

			"experimental.chat.system.transform": async (_input, output) => {
				if (!cfg.enabled || !cfg.injectSystemPrompt) return;
				if (output.system.some((s) => s.includes("hashline_patch"))) return;
				output.system.push(HASHLINE_SYSTEM_PROMPT);
			},

			tool: {
				hashline_patch: tool({
					description:
						"Apply a hashline patch. Anchor every section on the [PATH#TAG] line from " +
						"your most recent read of that file. Ops: SWAP A.=B: / DEL A.=B / INS.PRE A: / " +
						"INS.POST A: / INS.HEAD: / INS.TAIL:, with +TEXT body rows. All sections are " +
						"verified before any file is written; a stale tag aborts the whole patch.",
					args: {
						patch: tool.schema
							.string()
							.describe(
								"Patch text. Each section starts with [relative/path#TAG] followed by hunks.",
							),
					},
					async execute(args, ctx) {
						const projectRoot = ctx.worktree || ctx.directory || root;
						try {
							const applied = await applyPatch(args.patch, projectRoot);
							const lines = applied.map(
								(a) =>
									`  ${a.path}: lines ${a.startLine}-${a.endLine} → fresh tag #${a.newTag}`,
							);
							ctx.metadata({
								title: `hashline_patch: ${applied.length} file(s)`,
								metadata: { sections: applied },
							});
							return {
								title: `hashline_patch: ${applied.length} file(s)`,
								output: [
									`Applied ${applied.length} section(s).`,
									...lines,
									"",
									"Anchor your next edit on the fresh tags above, or re-read.",
								].join("\n"),
								metadata: { sections: applied },
							};
						} catch (err) {
							if (err instanceof StaleAnchorError) {
								return {
									title: "hashline_patch: stale anchor",
									output:
										`${err.message}\n\nNo files were modified. Re-read ${err.path} ` +
										`and rebuild the patch against the fresh tag.`,
								};
							}
							if (err instanceof PatchParseError) {
								return { title: "hashline_patch: parse error", output: err.message };
							}
							return {
								title: "hashline_patch: failed",
								output: err instanceof Error ? err.message : String(err),
							};
						}
					},
				}),
			},
		};
	};
}

export const HashlinePlugin: Plugin = createHashlinePlugin();
export default HashlinePlugin;

export { loadConfig, DEFAULT_CONFIG } from "./config.ts";
export type { HashlineConfig } from "./config.ts";
export { applyPatch, planPatch, commitPatch, computeFileHash } from "./patch.ts";
export { parseReadOutput, injectTag, formatTagLine, isFileRead } from "./read-format.ts";
export { HASHLINE_SYSTEM_PROMPT, HASHLINE_SYSTEM_PROMPT_BRIEF } from "./prompt.ts";
