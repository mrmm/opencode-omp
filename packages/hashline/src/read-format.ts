/**
 * Parser for OpenCode's rendered Read tool output.
 *
 * This shape is VERIFIED, not inferred: a reconstruction of it predicted the annotation hashes of a live read byte-for-byte (8/8 exact:
 * 428 866 cbe f10 b50 9eb 150 9c0), which only holds if the reconstruction below
 * matches the real pre-hook string exactly.
 *
 * Verified layout:
 *
 *   <path>{absolutePath}</path>
 *   <type>file</type>
 *   <content>
 *   {N}: {line}
 *   ...
 *                                                              <- blank line
 *   (End of file - total {N} lines)                            <- complete read
 *   (Showing lines {A}-{B} of {N}. Use offset={C} to continue.) <- paginated read
 *   </content>
 *
 * The blank line and footer are ALWAYS present. A splice that assumes `</content>`
 * follows the last content line corrupts every final-line edit — which is exactly
 * the class of bug this package exists to fix.
 */

/** A rendered content row: the true file line number and its text. */
export interface ContentLine {
	/** 1-based line number in the actual file (not the display offset). */
	lineNumber: number;
	/** Line text with the `N: ` render prefix stripped. */
	text: string;
	/** Index of this row within the rendered output's line array. */
	renderIndex: number;
}

export interface ParsedRead {
	/** Absolute path from the `<path>` element, or null when absent. */
	path: string | null;
	/** Rendered file rows in display order. */
	lines: ContentLine[];
	/** Render-array index of the `<content>` opening tag, or -1. */
	contentOpenIndex: number;
	/** Render-array index of the `</content>` closing tag, or -1. */
	contentCloseIndex: number;
	/** Footer text, when present. */
	footer: string | null;
	/** True when the footer indicates a paginated (partial) read. */
	paginated: boolean;
	/** Total file line count parsed from the footer, when available. */
	totalLines: number | null;
}

const PATH_RE = /^<path>(.*)<\/path>$/;
const CONTENT_ROW_RE = /^(\d+): ?(.*)$/;
const FOOTER_EOF_RE = /^\(End of file - total (\d+) lines?\)$/;
const FOOTER_PAGE_RE =
	/^\(Showing lines (\d+)-(\d+) of (\d+)\.(?: Use offset=(\d+) to continue\.)?\)$/;

/** True when the tool name / args look like a file read. */
export function isFileRead(tool: string, args?: Record<string, unknown>): boolean {
	const name = tool.toLowerCase();
	const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
	if (["read", "file_read", "read_file", "cat", "view"].includes(base)) return true;
	// Fallback: has a path-like arg and is not a mutating tool.
	const hasPath =
		!!args && ("filePath" in args || "path" in args || "file" in args);
	const mutating = /write|edit|patch|execute|run|command|shell|bash/.test(name);
	return hasPath && !mutating;
}

/**
 * Parse rendered Read output.
 *
 * Tolerant by design: anything that does not match the expected shape is reported
 * as absent rather than thrown, so an OpenCode render-format change degrades to
 * "no annotation" instead of corrupting output.
 */
export function parseReadOutput(rendered: string): ParsedRead {
	const rows = rendered.split("\n");
	let path: string | null = null;
	let contentOpenIndex = -1;
	let contentCloseIndex = -1;

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i] ?? "";
		if (path === null) {
			const m = row.match(PATH_RE);
			if (m) {
				path = m[1] ?? null;
				continue;
			}
		}
		if (contentOpenIndex === -1 && row === "<content>") {
			contentOpenIndex = i;
			continue;
		}
		if (row === "</content>") contentCloseIndex = i;
	}

	const lines: ContentLine[] = [];
	let footer: string | null = null;
	let paginated = false;
	let totalLines: number | null = null;

	const start = contentOpenIndex === -1 ? 0 : contentOpenIndex + 1;
	const end = contentCloseIndex === -1 ? rows.length : contentCloseIndex;

	for (let i = start; i < end; i++) {
		const row = rows[i] ?? "";
		const eof = row.match(FOOTER_EOF_RE);
		if (eof) {
			footer = row;
			totalLines = Number(eof[1]);
			continue;
		}
		const page = row.match(FOOTER_PAGE_RE);
		if (page) {
			footer = row;
			paginated = true;
			totalLines = Number(page[3]);
			continue;
		}
		const m = row.match(CONTENT_ROW_RE);
		if (m) {
			lines.push({
				lineNumber: Number(m[1]),
				text: m[2] ?? "",
				renderIndex: i,
			});
		}
	}

	return {
		path,
		lines,
		contentOpenIndex,
		contentCloseIndex,
		footer,
		paginated,
		totalLines,
	};
}

/** Where the tag line is placed within rendered Read output. */
export type TagPlacement = "after-type" | "before-content" | "top";

/**
 * Insert a tag line into rendered Read output.
 *
 * Content rows are deliberately left untouched: OpenCode's native `N: ` numbering
 * is already the addressing scheme the hashline patch language consumes. Adding a
 * per-line hash would cost ~146x more tokens for no additional capability.
 */
export function injectTag(
	rendered: string,
	tagLine: string,
	placement: TagPlacement = "after-type",
): string {
	if (placement === "top") return `${tagLine}\n${rendered}`;

	const rows = rendered.split("\n");
	const contentIdx = rows.findIndex((r) => r === "<content>");
	if (contentIdx === -1) return `${tagLine}\n${rendered}`;

	let anchor = contentIdx;
	if (placement === "after-type") {
		const typeIdx = rows.findIndex((r) => /^<type>.*<\/type>$/.test(r));
		if (typeIdx !== -1 && typeIdx < contentIdx) anchor = typeIdx + 1;
	}

	rows.splice(anchor, 0, tagLine);
	return rows.join("\n");
}

/** Render the canonical tag line: `[relative/path#TAG]`. */
export function formatTagLine(relPath: string, tag: string): string {
	return `[${relPath}#${tag}]`;
}
