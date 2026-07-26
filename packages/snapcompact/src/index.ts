/**
 * opencode-omp-snapcompact — density-gated bitmap context compression.
 *
 * Wraps upstream `@oh-my-pi/snapcompact` (MIT, Can Bölük).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ONLY Plugin-compatible exports belong in this file.                     │
 * │ OpenCode's loader calls EVERY export as a Plugin function; a single     │
 * │ non-function export aborts loading. Helpers live in ./utils.            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The density gate is the point. A frame buys a FIXED chars-per-token rate
 * (4.23 on Anthropic). Denser text wins; sparser text costs more than sending
 * it plainly — prose measures -56.8%. Rendering unconditionally would degrade
 * prose-heavy sessions, so the gate is a correctness requirement, on by default.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createTelemetry } from "@mrmm/opencode-omp-telemetry";

import { resolveConfig, type SnapcompactConfig } from "./config.ts";
import { density, shouldCompact, type Decision } from "./density.ts";
import {
	budgetFor,
	economicsFor,
	frameBytes,
	renderFrames,
	toAttachments,
	type ModelRef,
} from "./render.ts";

/** Kept in step with package.json by the release tooling. */
const PKG_VERSION = "0.2.0";

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

/**
 * Build the plugin. `options` arrives from opencode.jsonc's array form:
 *
 *   ["opencode-omp-snapcompact", { "enabled": true, "densityMargin": 0.2 }]
 */
export function createSnapcompactPlugin(
	staticConfig?: Partial<SnapcompactConfig>,
): Plugin {
	return async ({ directory, worktree }, options) => {
		const root = worktree || directory || process.cwd();
		const cfg: SnapcompactConfig = {
			...resolveConfig(root, options),
			...staticConfig,
		};
		const log = (...a: unknown[]) => {
			if (cfg.debug) console.error("[omp-snapcompact]", ...a);
		};

		const tel = createTelemetry({
			service: "opencode-omp-snapcompact",
			serviceVersion: PKG_VERSION,
			config: cfg.telemetry,
		});

		log("config", JSON.stringify(cfg));

		const modelRef = (): ModelRef =>
			cfg.shapeOverride ? { api: cfg.shapeOverride } : {};

		const tools: Record<string, unknown> = {};

		if (cfg.registerRenderTool) {
			tools[`${cfg.toolPrefix}_render`] = tool({
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
						.describe("Bypass the density gate. Still reports the result."),
				},
				async execute(args, ctx) {
					const forced = (args.force ?? false) && cfg.allowForce;
					if (args.force && !cfg.allowForce) {
						log("force requested but disabled by config");
					}

					if (!cfg.enabled && !forced) {
						return {
							title: `${cfg.toolPrefix}: disabled`,
							output:
								"snapcompact is off by default because its savings are conditional.\n" +
								'Enable inline in opencode.jsonc:\n' +
								'  ["opencode-omp-snapcompact", { "enabled": true }]\n' +
								"or in opencode-omp-snapcompact.jsonc.",
						};
					}

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
							title: `${cfg.toolPrefix}: no input`,
							output: "Provide `text` or `paths`.",
						};
					}

					const model = modelRef();
					const econ = economicsFor(model);
					const budget = cfg.maxFrames ?? budgetFor(model);

					const decision: Decision = shouldCompact(text, econ, {
						margin: cfg.densityMargin,
						minChars: cfg.minChars,
						maxFrames: budget,
						force: forced,
						visionCapable: true,
					});

					if (!decision.compact) {
						const d = decision.density;
						// The real-world density distribution. The gate's thresholds
						// were calibrated on synthetic corpora; these are the numbers
						// that confirm or refute that calibration.
						tel.count("snapcompact.gate.declined", 1, { reason: decision.reason });
						if (d) {
							tel.histogram("snapcompact.density.chars_per_token", d.ratio, {
								decision: "declined",
							});
							tel.histogram("snapcompact.input.chars", d.chars, { decision: "declined" });
						}
						if (typeof decision.estimatedSavingPct === "number") {
							tel.histogram(
								"snapcompact.projected_saving_pct",
								decision.estimatedSavingPct,
								{ decision: "declined" },
							);
						}
						return {
							title: `${cfg.toolPrefix}: declined (${decision.reason})`,
							output: [
								decision.detail,
								d
									? `\nMeasured: ${d.chars} chars / ${d.tokens} tokens = ${d.ratio.toFixed(2)} chars/token.`
									: "",
								`Frame rate: ${econ.imageRatio.toFixed(2)} chars/token (capacity ${econ.capacity}, ${econ.frameTokens} tokens/frame).`,
								cfg.allowForce ? "\nNo frames produced. Pass force: true to override." : "",
							]
								.filter(Boolean)
								.join("\n"),
							metadata: { decision },
						};
					}

					const stopRender = tel.timer("snapcompact.render.duration_ms");
					const frames = await renderFrames(text, model, budget);
					const attachments = toAttachments(frames);
					stopRender({ frames: frames.length });
					const bytes = frames.reduce((s, f) => s + frameBytes(f), 0);
					const imageTokens = frames.length * econ.frameTokens;
					const saving = 100 * (1 - imageTokens / decision.density.tokens);

					tel.count("snapcompact.gate.compacted", 1, { forced: forced });
					tel.histogram("snapcompact.density.chars_per_token", decision.density.ratio, {
						decision: "compacted",
					});
					tel.histogram("snapcompact.input.chars", decision.density.chars, {
						decision: "compacted",
					});
					tel.histogram("snapcompact.frames", frames.length);
					tel.histogram("snapcompact.payload_bytes", bytes);
					// Projected vs realised: drift here means the estimate is wrong.
					tel.histogram("snapcompact.actual_saving_pct", saving, { decision: "compacted" });
					tel.histogram(
						"snapcompact.saving_estimate_error_pct",
						saving - decision.estimatedSavingPct,
					);

					ctx.metadata({
						title: `${cfg.toolPrefix}: ${frames.length} frame(s), ${pct(saving)}`,
						metadata: {
							frames: frames.length,
							bytes,
							textTokens: decision.density.tokens,
							imageTokens,
							savingPct: saving,
						},
					});

					return {
						title: `${cfg.toolPrefix}: ${frames.length} frame(s) ${pct(saving)}`,
						output: [
							`Compressed ${decision.density.chars} chars into ${frames.length} PNG frame(s).`,
							"",
							`  text tokens   ${decision.density.tokens}`,
							`  image tokens  ${imageTokens}`,
							`  saving        ${pct(saving)}`,
							`  density       ${decision.density.ratio.toFixed(2)} chars/token (frame rate ${econ.imageRatio.toFixed(2)})`,
							`  payload       ${bytes} bytes PNG`,
							"",
							"Frames are attached. Read them directly — they contain the full text.",
						].join("\n"),
						metadata: { frames: frames.length, savingPct: saving },
						attachments,
					};
				},
			});
		}

		if (cfg.registerEstimateTool) {
			tools[`${cfg.toolPrefix}_estimate`] = tool({
				description:
					"Estimate whether bitmap framing would save tokens for some text, without " +
					"rendering. Reports measured density, frame economics, and projected saving.",
				args: { text: tool.schema.string().describe("Text to evaluate.") },
				async execute(args) {
					const model = modelRef();
					const econ = economicsFor(model);
					const d = density(args.text);
					const decision = shouldCompact(args.text, econ, {
						margin: cfg.densityMargin,
						minChars: cfg.minChars,
						maxFrames: cfg.maxFrames ?? budgetFor(model),
					});
					tel.count("snapcompact.estimate", 1, {
						would_compact: decision.compact,
					});
					tel.histogram("snapcompact.density.chars_per_token", d.ratio, {
						decision: "estimate",
					});
					const verdict = decision.compact
						? `WOULD COMPACT — projected ${pct(decision.estimatedSavingPct)} across ${decision.estimatedFrames} frame(s)`
						: `WOULD DECLINE (${decision.reason}) — ${decision.detail}`;
					return {
						title: `${cfg.toolPrefix}: estimate`,
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
			});
		}

		return { tool: tools } as never;
	};
}

/** Default instance. Receives inline options from opencode.jsonc. */
export const SnapcompactPlugin: Plugin = createSnapcompactPlugin();

export default SnapcompactPlugin;
