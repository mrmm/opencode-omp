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
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createTelemetry } from "@mrmm/telemetry";

import { resolveConfig, type HashlineConfig } from "./config.ts";
import {
	applyPatch,
	planPatch,
	PatchParseError,
	StaleAnchorError,
	computeFileHash,
} from "./patch.ts";
import { HASHLINE_SYSTEM_PROMPT, HASHLINE_SYSTEM_PROMPT_BRIEF } from "./prompt.ts";
import { formatTagLine, injectTag, isFileRead, parseReadOutput } from "./read-format.ts";

/**
 * Read from package.json rather than duplicated as a literal. A hand-maintained
 * copy had already drifted (0.2.0 against a released 0.3.0) behind a comment
 * claiming the release tooling kept it current — nothing did.
 */
const PKG_VERSION: string = (() => {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return (
			JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
				version?: string;
			}
		).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

/** Hoisted so the standing-cost gauge can measure what it adds per turn. */
const TOOL_DESCRIPTION =
	"Apply a hashline patch. Anchor every section on the [PATH#TAG] line from " +
	"your most recent read of that file. Ops: SWAP A.=B: / DEL A.=B / INS.PRE A: / " +
	"INS.POST A: / INS.HEAD: / INS.TAIL:, with +TEXT body rows. All sections are " +
	"verified before any file is written; a stale tag aborts the whole patch.";

/** File extension without the dot; "none" when absent. */
function extOf(p: string): string {
	const i = p.lastIndexOf(".");
	const j = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i > j + 1 ? p.slice(i + 1) : "none";
}

/**
 * What a hash on every line would have added, for direct comparison with the
 * single tag this package emits.
 */
function perLineOverhead(lines: number, hashLen = 3): number {
	return lines * ("#HL ".length + String(lines).length + 1 + hashLen + 1);
}

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

		const tel = createTelemetry({
			service: "opencode-omp-hashline",
			namespace: "opencode-omp",
			serviceVersion: PKG_VERSION,
			config: cfg.telemetry,
		});
		if (tel.enabled) log("telemetry", tel.sinkKinds.join("+"), tel.filePath ?? "");

		// Standing cost: what this plugin adds to EVERY turn whether used or not.
		// Recorded once per session so the report can weigh it against savings.
		// Characters, not tokens — the report tokenises with a real BPE so the
		// plugins stay dependency-free.
		if (tel.enabled) {
			const promptChars =
				cfg.promptStyle === "none"
					? 0
					: (cfg.promptStyle === "brief"
							? HASHLINE_SYSTEM_PROMPT_BRIEF
							: HASHLINE_SYSTEM_PROMPT
						).length;
			const toolDefChars = cfg.registerTool ? TOOL_DESCRIPTION.length + cfg.toolName.length : 0;
			tel.gauge("hashline.standing_cost.system_prompt_chars", promptChars, {
				style: cfg.promptStyle,
			});
			tel.gauge("hashline.standing_cost.tool_def_chars", toolDefChars);
			tel.gauge("hashline.standing_cost.total_chars", promptChars + toolDefChars);
			tel.count("hashline.session.started", 1, {
				annotate: cfg.annotateReads,
				tool: cfg.registerTool,
			});
		}

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
				if (reason) {
					tel.count("hashline.read.skipped", 1, {
						reason: reason.startsWith("excluded") ? "excluded" : reason,
						ext: extOf(relPath),
					});
					return log("skip", relPath, reason);
				}

				// Only touch output we recognise; an unknown render shape passes
				// through untouched rather than being corrupted.
				const parsed = parseReadOutput(output.output);
				if (parsed.contentOpenIndex === -1 || parsed.lines.length === 0) {
					// Worth watching: a spike here means the host's Read format moved,
					// which is precisely the failure this package exists to avoid.
					tel.count("hashline.read.skipped", 1, {
						reason: "unrecognised_shape",
						ext: extOf(relPath),
					});
					return log("skip", relPath, "unrecognised read shape");
				}

				let content: string;
				const stopRead = tel.timer("hashline.read.duration_ms");
				try {
					content = await readFile(absPath, "utf8");
				} catch {
					tel.count("hashline.read.skipped", 1, {
						reason: "unreadable",
						ext: extOf(relPath),
					});
					return log("skip", absPath, "unreadable");
				}

				if (Buffer.byteLength(content, "utf8") > cfg.maxFileSize) {
					tel.count("hashline.read.skipped", 1, { reason: "over_max_bytes", ext: extOf(relPath) });
					return log("skip", relPath, "over maxFileSize");
				}
				if (cfg.maxLines > 0 && content.split("\n").length > cfg.maxLines) {
					tel.count("hashline.read.skipped", 1, { reason: "over_max_lines", ext: extOf(relPath) });
					return log("skip", relPath, "over maxLines");
				}

				const tag = computeFileHash(content);
				const before = output.output.length;
				output.output = injectTag(
					output.output,
					formatTagLine(relPath, tag),
					cfg.tagPosition,
				);
				const lines = parsed.lines.length;
				const ext = extOf(relPath);
				tel.count("hashline.read.tagged", 1, { ext });
				// The comparison that justifies one tag over a hash per line.
				tel.histogram("hashline.read.overhead_chars", output.output.length - before, { ext });
				tel.histogram("hashline.read.overhead_ratio",
					before > 0 ? (output.output.length - before) / before : 0, { ext });
				tel.histogram("hashline.read.per_line_would_cost", perLineOverhead(lines), { ext });
				stopRead({ ext, result: "tagged" });
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
					description: TOOL_DESCRIPTION,
					args: {
						patch: tool.schema
							.string()
							.describe(
								"Patch text. Each section starts with [relative/path#TAG] followed by hunks.",
							),
					},
					async execute(args, ctx) {
						const projectRoot = ctx.worktree || ctx.directory || root;
						const stop = tel.timer("hashline.patch.duration_ms");
						tel.count("hashline.patch.attempted");
						try {
							// Capture pre-edit state so we can answer the question that
							// actually decides whether this plugin earns its cost:
							// would the built-in exact-string edit have worked here?
							const preflight = await planPatch(args.patch, projectRoot);
							for (const plan of preflight) {
								const lines = plan.original.split("\n");
								const targets = (plan.edits as Array<{ lineNum?: number }>)
									.map((e) => e.lineNum)
									.filter((n): n is number => typeof n === "number");
								for (const ln of targets) {
									const content = lines[ln - 1];
									if (content === undefined) continue;
									const occurrences = lines.filter((l) => l === content).length;
									// occurrences > 1 -> exact-string matching is ambiguous and
									// the built-in edit tool would refuse. Only those edits
									// represent capability this plugin uniquely provides.
									tel.count("hashline.patch.target", 1, {
										unique: occurrences === 1,
										blank: content.trim() === "",
									});
									tel.histogram("hashline.patch.target_occurrences", occurrences);
								}
							}

							const applied = await applyPatch(args.patch, projectRoot);
							tel.count("hashline.patch.applied", 1, { sections: applied.length });
							tel.histogram("hashline.patch.sections", applied.length);
							stop({ result: "applied" });
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
								// The safety net firing. This rate is the single best
								// evidence that content-anchoring earns its keep.
								tel.count("hashline.patch.stale_anchor", 1, { ext: extOf(err.path) });
								// A stale catch prevents a wrong-file edit. The averted cost is
								// the corrective cycle: re-read the file plus re-issue the patch.
								// Recorded as chars so the report can price it in tokens.
								try {
									const abs = resolve(projectRoot, err.path);
									const size = (await readFile(abs, "utf8")).length;
									tel.histogram("hashline.patch.retry_chars_avoided", size + args.patch.length, {
										ext: extOf(err.path),
									});
								} catch {
									/* size unavailable; the counter above still records the catch */
								}
								stop({ result: "stale" });
								return {
									title: `${cfg.toolName}: stale anchor`,
									output:
										`${err.message}\n\nNo files were modified. Re-read ${err.path} ` +
										`and rebuild the patch against the fresh tag.`,
								};
							}
							if (err instanceof PatchParseError) {
								tel.count("hashline.patch.error", 1, { reason: "parse" });
								stop({ result: "parse_error" });
								return { title: `${cfg.toolName}: parse error`, output: err.message };
							}
							tel.count("hashline.patch.error", 1, { reason: "other" });
							stop({ result: "error" });
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
