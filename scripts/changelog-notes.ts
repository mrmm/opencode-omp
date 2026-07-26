#!/usr/bin/env bun
/**
 * Extract one version's section from a package CHANGELOG, for release notes.
 *
 * This exists as a file rather than inline shell because the previous inline
 * version was wrong in a way that was invisible: with the `m` flag, `$` means
 * END OF LINE, so a `(?=^## \[|$)` terminator matched immediately and captured
 * an empty body. Every release then silently fell back to "See CHANGELOG."
 *
 * Parsing is line-based here — no lookaheads, nothing to mis-escape through
 * two layers of shell quoting.
 *
 * Usage:
 *   bun scripts/changelog-notes.ts <packageDir> <version> [--install <name>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Return the body of `## [version]`, exclusive of the next `## [` heading. */
export function extractSection(changelog: string, version: string): string {
	const lines = changelog.split("\n");
	const isHeading = (l: string) => /^##\s*\[/.test(l);
	const wanted = new RegExp(`^##\\s*\\[${version.replace(/\./g, "\\.")}\\]`);

	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (wanted.test(lines[i] ?? "")) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return "";

	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		if (isHeading(lines[i] ?? "")) {
			end = i;
			break;
		}
	}

	// Drop link-reference definitions; they are noise in a release body.
	return lines
		.slice(start, end)
		.filter((l) => !/^\[[^\]]+\]:\s*http/i.test(l))
		.join("\n")
		.trim();
}

if (import.meta.main) {
	const [dir, version] = process.argv.slice(2);
	const installIdx = process.argv.indexOf("--install");
	const installName = installIdx !== -1 ? process.argv[installIdx + 1] : null;

	if (!dir || !version) {
		console.error("usage: changelog-notes.ts <packageDir> <version> [--install <name>]");
		process.exit(1);
	}

	const path = join(dir, "CHANGELOG.md");
	if (!existsSync(path)) {
		console.error(`no CHANGELOG at ${path}`);
		process.exit(1);
	}

	const body = extractSection(readFileSync(path, "utf8"), version);
	if (!body) {
		// Loud, not silent. An empty release body is a bug worth seeing.
		console.error(`::warning::no [${version}] section found in ${path}`);
		console.log(`Release ${version}.\n\nSee [CHANGELOG](${dir}/CHANGELOG.md).`);
		process.exit(0);
	}

	const parts = [body];
	if (installName) {
		parts.push(
			"",
			"---",
			"",
			"```sh",
			`bun add ${installName}@${version}`,
			"```",
		);
	}
	console.log(parts.join("\n"));
}
