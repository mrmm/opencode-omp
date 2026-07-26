/**
 * Minimal JSONC reader.
 *
 * Lives here because every plugin in this repo needs it and each had grown its
 * own copy. Shared so a fix lands once.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Strip `//` and `/* *\/` comments plus trailing commas, preserving strings. */
export function stripJsonc(text: string): string {
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

/** Parse a JSONC file. Returns null on absence or malformed content. */
export function readJsonc(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
	} catch {
		// A malformed config must degrade to defaults, never break the plugin.
		return null;
	}
}

export interface LayeredOptions {
	/** Directory holding user-global config. Default: ~/.config/<globalDirName>. */
	globalDir?: string;
	/** Leaf under ~/.config when `globalDir` is not given. */
	globalDirName?: string;
}

/**
 * Layered config lookup, most specific last:
 *   defaults < <globalDir>/<name> < <projectDir>/<name> < inline
 */
export function layeredConfig<T extends object>(
	basenames: string[],
	sanitize: (raw: unknown) => Partial<T>,
	defaults: T,
	projectDir?: string,
	inline?: unknown,
	opts: LayeredOptions = {},
): T {
	const read = (dir: string): Partial<T> => {
		for (const name of basenames) {
			const v = readJsonc(join(dir, name));
			if (v !== null) return sanitize(v);
		}
		return {};
	};
	const globalDir =
		opts.globalDir ?? join(homedir(), ".config", opts.globalDirName ?? "");
	return {
		...defaults,
		...(opts.globalDir || opts.globalDirName ? read(globalDir) : {}),
		...(projectDir ? read(projectDir) : {}),
		...sanitize(inline),
	};
}
