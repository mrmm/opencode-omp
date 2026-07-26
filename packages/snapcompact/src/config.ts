import {
	DEFAULT_TELEMETRY_CONFIG,
	layeredConfig,
	sanitizeTelemetryConfig,
	type TelemetryConfig,
} from "@mrmm/telemetry";

export type SnapcompactMode = "tool" | "auto-compact";

export type ShapeName = "anthropic" | "google" | "openai" | "legacy";

export interface SnapcompactConfig {
	/**
	 * Off by default. The economics are conditional — framing prose costs ~57%
	 * MORE than sending text (measurement). Opt in per project.
	 */
	enabled: boolean;
	/** "tool" is verified. "auto-compact" depends on an unverified runtime hook. */
	mode: SnapcompactMode;
	/** Fractional headroom required over break-even. */
	densityMargin: number;
	/** Below this length, framing isn't worth a round trip. */
	minChars: number;
	/** null → provider image budget. */
	maxFrames: number | null;
	/** Force a provider shape instead of resolving from the model. */
	shapeOverride: ShapeName | null;
	/** Register the render tool (the one that writes frames). */
	registerRenderTool: boolean;
	/** Register the estimate tool (read-only, always safe). */
	registerEstimateTool: boolean;
	/** Prefix for tool names, so they can be renamed to avoid collisions. */
	toolPrefix: string;
	/** Allow callers to pass force:true and bypass the density gate. */
	allowForce: boolean;
	debug: boolean;
	/** Usage telemetry. Local JSONL by default; see the telemetry package. */
	telemetry: TelemetryConfig;
}

export const DEFAULT_CONFIG: SnapcompactConfig = {
	enabled: false,
	mode: "tool",
	densityMargin: 0.1,
	minChars: 2000,
	maxFrames: null,
	shapeOverride: null,
	registerRenderTool: true,
	registerEstimateTool: true,
	toolPrefix: "snapcompact",
	allowForce: true,
	debug: false,
	telemetry: DEFAULT_TELEMETRY_CONFIG,
};

const NAMES = ["opencode-omp-snapcompact.jsonc", "opencode-omp-snapcompact.json"];

/** Accept only known keys with expected types; drop anything else silently. */
export function sanitize(raw: unknown): Partial<SnapcompactConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<SnapcompactConfig> = {};

	for (const k of [
		"enabled",
		"registerRenderTool",
		"registerEstimateTool",
		"allowForce",
		"debug",
	] as const) {
		if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
	}
	if (r.mode === "tool" || r.mode === "auto-compact") out.mode = r.mode;
	if (typeof r.densityMargin === "number" && r.densityMargin >= 0 && r.densityMargin < 1) {
		out.densityMargin = r.densityMargin;
	}
	if (typeof r.minChars === "number" && r.minChars >= 0) {
		out.minChars = Math.floor(r.minChars);
	}
	if (r.maxFrames === null) out.maxFrames = null;
	else if (typeof r.maxFrames === "number" && r.maxFrames > 0) {
		out.maxFrames = Math.floor(r.maxFrames);
	}
	if (
		r.shapeOverride === "anthropic" ||
		r.shapeOverride === "google" ||
		r.shapeOverride === "openai" ||
		r.shapeOverride === "legacy"
	) {
		out.shapeOverride = r.shapeOverride;
	} else if (r.shapeOverride === null) {
		out.shapeOverride = null;
	}
	if (typeof r.toolPrefix === "string" && /^[a-z][a-z0-9_]*$/.test(r.toolPrefix)) {
		out.toolPrefix = r.toolPrefix;
	}
	if ("telemetry" in r) {
		out.telemetry = {
			...DEFAULT_TELEMETRY_CONFIG,
			...sanitizeTelemetryConfig(r.telemetry),
		};
	}
	return out;
}

/**
 * Resolve config by precedence, most specific last:
 *
 *   defaults
 *     < ~/.config/opencode/opencode-omp-snapcompact.jsonc   (global file)
 *     < <project>/opencode-omp-snapcompact.jsonc            (project file)
 *     < inline options in opencode.jsonc                    (highest)
 */
export function resolveConfig(projectDir?: string, inline?: unknown): SnapcompactConfig {
	return layeredConfig(NAMES, sanitize, DEFAULT_CONFIG, projectDir, inline, {
		globalDirName: "opencode",
	});
}

/** Back-compat alias. */
export function loadConfig(projectDir?: string): SnapcompactConfig {
	return resolveConfig(projectDir);
}
