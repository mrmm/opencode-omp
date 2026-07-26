import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HashlineConfig {
	enabled: boolean;
	exclude: string[];
	maxFileSize: number;
	injectSystemPrompt: boolean;
	debug: boolean;
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
	exclude: DEFAULT_EXCLUDE,
	maxFileSize: 1_048_576,
	injectSystemPrompt: true,
	debug: false,
};

const CONFIG_NAME = "opencode-omp-hashline.json";
const CONFIG_NAME_C = "opencode-omp-hashline.jsonc";

/** Strip // and /* *\/ comments plus trailing commas so JSONC parses as JSON. */
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

function sanitize(raw: unknown): Partial<HashlineConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<HashlineConfig> = {};
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (typeof r.maxFileSize === "number" && r.maxFileSize > 0)
		out.maxFileSize = r.maxFileSize;
	if (typeof r.injectSystemPrompt === "boolean")
		out.injectSystemPrompt = r.injectSystemPrompt;
	if (typeof r.debug === "boolean") out.debug = r.debug;
	if (Array.isArray(r.exclude) && r.exclude.every((x) => typeof x === "string"))
		out.exclude = r.exclude as string[];
	return out;
}

function readConfigFile(dir: string): Partial<HashlineConfig> {
	for (const name of [CONFIG_NAME_C, CONFIG_NAME]) {
		const p = join(dir, name);
		if (!existsSync(p)) continue;
		try {
			return sanitize(JSON.parse(stripJsonc(readFileSync(p, "utf8"))));
		} catch {
			// Malformed config must never break reads.
			return {};
		}
	}
	return {};
}

/** Global config, then project config; project wins. */
export function loadConfig(projectDir?: string): HashlineConfig {
	const global = readConfigFile(join(homedir(), ".config", "opencode"));
	const project = projectDir ? readConfigFile(projectDir) : {};
	return { ...DEFAULT_CONFIG, ...global, ...project };
}
