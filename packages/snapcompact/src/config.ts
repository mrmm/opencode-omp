import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SnapcompactMode = "tool" | "auto-compact";

export interface SnapcompactConfig {
	/**
	 * Off by default. The economics are conditional — framing prose costs ~57%
	 * MORE than sending text (verification gate V5). Opt in per project.
	 */
	enabled: boolean;
	/** "tool" is verified. "auto-compact" depends on unverified gate V2. */
	mode: SnapcompactMode;
	/** Fractional headroom required over break-even. */
	densityMargin: number;
	/** Below this length, framing isn't worth a round trip. */
	minChars: number;
	/** null → provider image budget. */
	maxFrames: number | null;
	debug: boolean;
}

export const DEFAULT_CONFIG: SnapcompactConfig = {
	enabled: false,
	mode: "tool",
	densityMargin: 0.1,
	minChars: 2000,
	maxFrames: null,
	debug: false,
};

const NAMES = ["opencode-omp-snapcompact.jsonc", "opencode-omp-snapcompact.json"];

function stripJsonc(text: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] ?? "";
		const n = text[i + 1] ?? "";
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += c;
			if (c === "\\") {
				out += n;
				i++;
			} else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && n === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function sanitize(raw: unknown): Partial<SnapcompactConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<SnapcompactConfig> = {};
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (r.mode === "tool" || r.mode === "auto-compact") out.mode = r.mode;
	if (typeof r.densityMargin === "number" && r.densityMargin >= 0 && r.densityMargin < 1)
		out.densityMargin = r.densityMargin;
	if (typeof r.minChars === "number" && r.minChars >= 0) out.minChars = r.minChars;
	if (r.maxFrames === null) out.maxFrames = null;
	else if (typeof r.maxFrames === "number" && r.maxFrames > 0)
		out.maxFrames = Math.floor(r.maxFrames);
	if (typeof r.debug === "boolean") out.debug = r.debug;
	return out;
}

function readConfigFile(dir: string): Partial<SnapcompactConfig> {
	for (const name of NAMES) {
		const p = join(dir, name);
		if (!existsSync(p)) continue;
		try {
			return sanitize(JSON.parse(stripJsonc(readFileSync(p, "utf8"))));
		} catch {
			return {};
		}
	}
	return {};
}

/** Global config, then project config; project wins. */
export function loadConfig(projectDir?: string): SnapcompactConfig {
	const global = readConfigFile(join(homedir(), ".config", "opencode"));
	const project = projectDir ? readConfigFile(projectDir) : {};
	return { ...DEFAULT_CONFIG, ...global, ...project };
}
