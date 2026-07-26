/**
 * opencode-omp-snapcompact — density-gated bitmap context compression for OpenCode.
 *
 * Wraps upstream `@oh-my-pi/snapcompact` (MIT, Can Boluk). Text is rasterized into
 * dense pixel-font PNG frames that vision models read back directly — locally,
 * deterministically, with no LLM call and no API cost.
 *
 * The gate is the point. Verification (V5) measured the trade with a real BPE
 * tokenizer and found it CONDITIONAL, not universal:
 *
 *   JSON (2.24 chars/tok)   -> +39.0% saved on Anthropic
 *   tool output (2.36)      -> +34.9%
 *   code (3.57)             -> -17.6%   (costs more)
 *   prose (5.09)            -> -56.8%   (costs much more)
 *
 * A frame buys a fixed 4.23 chars/token on Anthropic. Denser text wins; sparser
 * text loses. Rendering unconditionally would make prose-heavy sessions worse, so
 * the density gate is a correctness requirement and is enforced by default.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { loadConfig, type SnapcompactConfig } from "./config.ts";
import { density, shouldCompact, type Decision } from "./density.ts";
import {
	budgetFor,
	economicsFor,
	frameBytes,
	renderFrames,
	toAttachments,
	type ModelRef,
} from "./render.ts";

function pct(n: number): string {
	return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function inside(root: string, p: string): string {
	const abs = isAbsolute(p) ? p : resolve(root, p);
	const rel = relative(root, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Refusing to read outside the project directory: ${p}`);
	}
	return abs;
}

export function createSnapcompactPlugin(
	userConfig?: Partial<SnapcompactConfig>,
): Plugin {
	return async ({ directory, worktree }) => {
		const root = worktree || directory || process.cwd();
		const cfg: SnapcompactConfig = { ...loadConfig(root), ...userConfig };
		const log = (...a: unknown[]) => {
			if (cfg.debug) console.error("[omp-snapcompact]", ...a);
		};

		return {
			tool: {
				snapcompact_render: tool({
					description:
						"Compress token-dense text (JSON, logs, tool output) into bitmap PNG frames " +
						"a vision model reads back directly. Saves ~35-40% on dense content. " +
						"DECLINES when text is too token-sparse to profit — prose and code usually " +
						"cost MORE as images. No LLM call, no API cost, deterministic.",
					args: {
						text: tool.schema
							.string()
							.optional()
							.describe("Text to compress. Provide this or `paths`."),
						paths: tool.schema
							.array(tool.schema.string())
							.optional()
							.describe("Project-relative files to read and concatenate."),
						force: tool.schema
							.boolean()
							.optional()
							.describe(
								"Bypass the density gate. Still reports the (likely negative) result.",
							),
					},
					async execute(args, ctx) {
						if (!cfg.enabled && !args.force) {
							return {
								title: "snapcompact: disabled",
								output:
									"snapcompact is off by default because its savings are conditional.\n" +
									"Enable via opencode-omp-snapcompact.jsonc { \"enabled\": true }, or pass force: true.",
							};
						}

						// Gather input
						let text = args.text ?? "";
						if (args.paths?.length) {
							const parts: string[] = [];
							for (const p of args.paths) {
								try {
									const abs = inside(ctx.worktree || ctx.directory || root, p);
									parts.push(`=== ${p} ===\n${await readFile(abs, "utf8")}`);
								} catch (e) {
									parts.push(`=== ${p} (unreadable) ===`);
									log("unreadable", p, e);
								}
							}
							text = text ? `${text}\n${parts.join("\n")}` : parts.join("\n");
						}

						if (!text.trim()) {
							return {
								title: "snapcompact: no input",
								output: "Provide `text` or `paths`.",
							};
						}

						// Model-aware economics
						const model: ModelRef = {};
						const econ = economicsFor(model);
						const budget = cfg.maxFrames ?? budgetFor(model);

						const decision: Decision = shouldCompact(text, econ, {
							margin: cfg.densityMargin,
							minChars: cfg.minChars,
							maxFrames: budget,
							force: args.force ?? false,
							visionCapable: true,
						});

						if (!decision.compact) {
							const d = decision.density;
							return {
								title: `snapcompact: declined (${decision.reason})`,
								output: [
									decision.detail,
									d
										? `\nMeasured: ${d.chars} chars / ${d.tokens} tokens = ${d.ratio.toFixed(2)} chars/token.`
										: "",
									`Frame rate: ${econ.imageRatio.toFixed(2)} chars/token (capacity ${econ.capacity}, ${econ.frameTokens} tokens/frame).`,
									"\nNo frames were produced. Pass force: true to override.",
								]
									.filter(Boolean)
									.join("\n"),
								metadata: { decision },
							};
						}

						// Render
						const frames = await renderFrames(text, model, budget);
						const attachments = toAttachments(frames);
						const bytes = frames.reduce((s, f) => s + frameBytes(f), 0);
						const actualImageTokens = frames.length * econ.frameTokens;
						const actualSaving = 100 * (1 - actualImageTokens / decision.density.tokens);

						ctx.metadata({
							title: `snapcompact: ${frames.length} frame(s), ${pct(actualSaving)}`,
							metadata: {
								frames: frames.length,
								bytes,
								textTokens: decision.density.tokens,
								imageTokens: actualImageTokens,
								savingPct: actualSaving,
							},
						});

						return {
							title: `snapcompact: ${frames.length} frame(s) ${pct(actualSaving)}`,
							output: [
								`Compressed ${decision.density.chars} chars into ${frames.length} PNG frame(s).`,
								"",
								`  text tokens   ${decision.density.tokens}`,
								`  image tokens  ${actualImageTokens}`,
								`  saving        ${pct(actualSaving)}`,
								`  density       ${decision.density.ratio.toFixed(2)} chars/token (frame rate ${econ.imageRatio.toFixed(2)})`,
								`  payload       ${bytes} bytes PNG`,
								"",
								"Frames are attached. Read them directly — they contain the full text.",
							].join("\n"),
							metadata: {
								frames: frames.length,
								savingPct: actualSaving,
							},
							attachments,
						};
					},
				}),

				snapcompact_estimate: tool({
					description:
						"Estimate whether bitmap framing would save tokens for some text, without rendering. " +
						"Reports measured density, frame economics, and projected saving.",
					args: {
						text: tool.schema.string().describe("Text to evaluate."),
					},
					async execute(args) {
						const econ = economicsFor({});
						const d = density(args.text);
						const decision = shouldCompact(args.text, econ, {
							margin: cfg.densityMargin,
							minChars: cfg.minChars,
							maxFrames: cfg.maxFrames ?? budgetFor({}),
						});
						const verdict = decision.compact
							? `WOULD COMPACT — projected ${pct(decision.estimatedSavingPct)} across ${decision.estimatedFrames} frame(s)`
							: `WOULD DECLINE (${decision.reason}) — ${decision.detail}`;
						return {
							title: "snapcompact: estimate",
							output: [
								`chars        ${d.chars}`,
								`tokens       ${d.tokens}`,
								`density      ${d.ratio.toFixed(2)} chars/token`,
								`frame rate   ${econ.imageRatio.toFixed(2)} chars/token`,
								`capacity     ${econ.capacity} chars/frame @ ${econ.frameTokens} tokens`,
								"",
								verdict,
							].join("\n"),
							metadata: { density: d, economics: econ, decision },
						};
					},
				}),
			},
		};
	};
}

export const SnapcompactPlugin: Plugin = createSnapcompactPlugin();
export default SnapcompactPlugin;

export { loadConfig, DEFAULT_CONFIG } from "./config.ts";
export type { SnapcompactConfig, SnapcompactMode } from "./config.ts";
export {
	density,
	approximateDensity,
	shouldCompact,
	frameEconomics,
} from "./density.ts";
export type { Decision, DensityReading, FrameEconomics } from "./density.ts";
export {
	renderFrames,
	toAttachments,
	economicsFor,
	budgetFor,
	frameCount,
	shapeFor,
	frameBytes,
} from "./render.ts";
export type { Frame, ModelRef, ToolAttachment } from "./render.ts";
