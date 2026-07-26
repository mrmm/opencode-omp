import {
	DEFAULT_TELEMETRY_CONFIG,
	layeredConfig,
	sanitizeTelemetryConfig,
	type TelemetryConfig,
} from "@mrmm/telemetry";

export type PromptStyle = "full" | "brief" | "none";
export type TagPosition = "after-type" | "before-content" | "top";

export interface HashlineConfig {
	/** Master switch. */
	enabled: boolean;
	/** Annotate reads with the file tag. Off = tool still usable with manual tags. */
	annotateReads: boolean;
	/** Register the patch tool. */
	registerTool: boolean;
	/** Tool name. Rename to avoid collisions with another plugin. */
	toolName: string;
	/** Glob denylist. */
	exclude: string[];
	/** Glob allowlist. Empty = allow everything not excluded. */
	includeOnly: string[];
	/** Skip files larger than this many bytes. */
	maxFileSize: number;
	/** Skip files with more than this many lines. 0 = no limit. */
	maxLines: number;
	/** How much patch-language guidance to inject. */
	promptStyle: PromptStyle;
	/** Where the tag line is placed in read output. */
	tagPosition: TagPosition;
	/** Log decisions to stderr. */
	debug: boolean;
	/** Usage telemetry. Local JSONL by default; see the telemetry package. */
	telemetry: TelemetryConfig;
}

export const DEFAULT_EXCLUDE = [
	"**/node_modules/**",
	"**/.git/**",
	"**/*.lock",
	"**/package-lock.json",
	"**/bun.lockb",
	"**/*.min.js",
	"**/*.min.css",
	"**/*.map",
	"**/*.png",
	"**/*.jpg",
	"**/*.jpeg",
	"**/*.gif",
	"**/*.ico",
	"**/*.pdf",
	"**/*.zip",
	"**/*.wasm",
	"**/.env",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/id_rsa",
	"**/id_ed25519",
	"**/credentials",
];

export const DEFAULT_CONFIG: HashlineConfig = {
	enabled: true,
	annotateReads: true,
	registerTool: true,
	toolName: "hashline_patch",
	exclude: DEFAULT_EXCLUDE,
	includeOnly: [],
	maxFileSize: 1_048_576,
	maxLines: 0,
	promptStyle: "full",
	tagPosition: "after-type",
	debug: false,
	telemetry: DEFAULT_TELEMETRY_CONFIG,
};

const NAMES = ["opencode-omp-hashline.jsonc", "opencode-omp-hashline.json"];

/**
 * Accept only known keys with expected types; silently drop anything else.
 * A malformed config must degrade to defaults, never break file reads.
 */
export function sanitize(raw: unknown): Partial<HashlineConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<HashlineConfig> = {};

	for (const k of ["enabled", "annotateReads", "registerTool", "debug"] as const) {
		if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
	}
	if (typeof r.toolName === "string" && /^[a-z][a-z0-9_]*$/.test(r.toolName)) {
		out.toolName = r.toolName;
	}
	if (typeof r.maxFileSize === "number" && r.maxFileSize > 0) {
		out.maxFileSize = r.maxFileSize;
	}
	if (typeof r.maxLines === "number" && r.maxLines >= 0) {
		out.maxLines = Math.floor(r.maxLines);
	}
	if (r.promptStyle === "full" || r.promptStyle === "brief" || r.promptStyle === "none") {
		out.promptStyle = r.promptStyle;
	}
	if (
		r.tagPosition === "after-type" ||
		r.tagPosition === "before-content" ||
		r.tagPosition === "top"
	) {
		out.tagPosition = r.tagPosition;
	}
	for (const k of ["exclude", "includeOnly"] as const) {
		const v = r[k];
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			out[k] = v as string[];
		}
	}
	// Convenience: injectSystemPrompt:false is shorthand for promptStyle:"none".
	if (r.injectSystemPrompt === false && out.promptStyle === undefined) {
		out.promptStyle = "none";
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
 *     < ~/.config/opencode/opencode-omp-hashline.jsonc   (global file)
 *     < <project>/opencode-omp-hashline.jsonc            (project file)
 *     < inline options in opencode.jsonc                 (highest)
 */
export function resolveConfig(projectDir?: string, inline?: unknown): HashlineConfig {
	return layeredConfig(NAMES, sanitize, DEFAULT_CONFIG, projectDir, inline, {
		globalDirName: "opencode",
	});
}

/** Back-compat alias. */
export function loadConfig(projectDir?: string): HashlineConfig {
	return resolveConfig(projectDir);
}
