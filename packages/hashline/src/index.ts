/**
 * opencode-omp-hashline — file-hash-anchored patch editing for OpenCode.
 *
 * Wraps upstream `@oh-my-pi/hashline` (MIT, Can Bölük). Nothing reimplemented.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ONLY Plugin-compatible exports belong in this file.                     │
 * │                                                                         │
 * │ OpenCode's loader calls EVERY export as a Plugin function. A single     │
 * │ non-function export (an object, a string) aborts loading with          │
 * │ "Plugin export is not a function" — verified the hard way.              │
 * │                                                                         │
 * │ Constants and helpers live in ./utils, reachable as:                    │
 * │   import { computeFileHash } from "opencode-omp-hashline/utils";        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * What this restores that `opencode-hashline@1.4.0` broke: anchoring on RAW
 * FILE CONTENT rather than the rendered Read output, and one 4-hex tag per file
 * instead of a hash on every line (+37% -> under 64 chars).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { resolveConfig, type HashlineConfig } from "./config.ts";
import { applyPatch, PatchParseError, StaleAnchorError, computeFileHash } from "./patch.ts";
import { HASHLINE_SYSTEM_PROMPT, HASHLINE_SYSTEM_PROMPT_BRIEF } from "./prompt.ts";
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

function toRelative(root: string, abs: string): string {
	const rel = relative(root, abs);
	return !rel || rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
}

/**
 * Build the plugin. `options` arrives from opencode.jsonc's array form:
 *
 *   ["opencode-omp-hashline", { "debug": true, "promptStyle": "brief" }]
 *
 * so behaviour is tunable without editing plugin source.
 */
export function createHashlinePlugin(staticConfig?: Partial<HashlineConfig>): Plugin {
	return async ({ directory, worktree }, options) => {
		const root = worktree || directory || process.cwd();
		const cfg: HashlineConfig = {
			...resolveConfig(root, options),
			...staticConfig,
		};

		const log = (...a: unknown[]) => {
			if (cfg.debug) console.error("[omp-hashline]", ...a);
		};

		log("config", JSON.stringify({ ...cfg, exclude: `${cfg.exclude.length} patterns` }));

		const skip = (relPath: string, absPath: string): string | null => {
			if (cfg.includeOnly.length > 0) {
				const allowed = cfg.includeOnly.some(
					(p) => matchesGlob(relPath, p) || matchesGlob(absPath, p),
				);
				if (!allowed) return "not in includeOnly";
			}
			const denied = cfg.exclude.find(
				(p) => matchesGlob(relPath, p) || matchesGlob(absPath, p),
			);
			return denied ? `excluded by ${denied}` : null;
		};

		const hooks: Record<string, unknown> = {};

		if (cfg.enabled && cfg.annotateReads) {
			hooks["tool.execute.after"] = async (
				input: { tool: string; args?: Record<string, unknown> },
				output: { output?: string },
			) => {
				if (!isFileRead(input.tool, input.args)) return;
				if (typeof output.output !== "string" || !output.output) return;

				const args = input.args ?? {};
				const rawPath = args.filePath ?? args.path ?? args.file;
				if (typeof rawPath !== "string") return;

				const absPath = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
				const relPath = toRelative(root, absPath);

				const reason = skip(relPath, absPath);
				if (reason) return log("skip", relPath, reason);

				// Only touch output we recognise; an unknown render shape passes
				// through untouched rather than being corrupted.
				const parsed = parseReadOutput(output.output);
				if (parsed.contentOpenIndex === -1 || parsed.lines.length === 0) {
					return log("skip", relPath, "unrecognised read shape");
				}

				let content: string;
				try {
					content = await readFile(absPath, "utf8");
				} catch {
					return log("skip", absPath, "unreadable");
				}

				if (Buffer.byteLength(content, "utf8") > cfg.maxFileSize) {
					return log("skip", relPath, "over maxFileSize");
				}
				if (cfg.maxLines > 0 && content.split("\n").length > cfg.maxLines) {
					return log("skip", relPath, "over maxLines");
				}

				const tag = computeFileHash(content);
				output.output = injectTag(
					output.output,
					formatTagLine(relPath, tag),
					cfg.tagPosition,
				);
				log("tagged", relPath, tag);
			};
		}

		if (cfg.enabled && cfg.promptStyle !== "none") {
			hooks["experimental.chat.system.transform"] = async (
				_i: unknown,
				out: { system: string[] },
			) => {
				const text =
					cfg.promptStyle === "brief"
						? HASHLINE_SYSTEM_PROMPT_BRIEF
						: HASHLINE_SYSTEM_PROMPT;
				const marker = cfg.toolName;
				if (out.system.some((s) => s.includes(marker))) return;
				out.system.push(text.replaceAll("hashline_patch", cfg.toolName));
			};
		}

		if (cfg.enabled && cfg.registerTool) {
			hooks.tool = {
				[cfg.toolName]: tool({
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
								title: `${cfg.toolName}: ${applied.length} file(s)`,
								metadata: { sections: applied },
							});
							return {
								title: `${cfg.toolName}: ${applied.length} file(s)`,
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
									title: `${cfg.toolName}: stale anchor`,
									output:
										`${err.message}\n\nNo files were modified. Re-read ${err.path} ` +
										`and rebuild the patch against the fresh tag.`,
								};
							}
							if (err instanceof PatchParseError) {
								return { title: `${cfg.toolName}: parse error`, output: err.message };
							}
							return {
								title: `${cfg.toolName}: failed`,
								output: err instanceof Error ? err.message : String(err),
							};
						}
					},
				}),
			};
		}

		return hooks as never;
	};
}

/** Default instance. Receives inline options from opencode.jsonc. */
export const HashlinePlugin: Plugin = createHashlinePlugin();

export default HashlinePlugin;
