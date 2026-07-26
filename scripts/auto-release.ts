#!/usr/bin/env bun
/**
 * Apply the derived release plan. Intended to run unattended in CI on push to
 * main; safe to run locally to preview.
 *
 * Nobody chooses a version. `derive-version.ts` reads the commit history, this
 * applies the result: bump package.json, fold commits into the changelog,
 * commit once, tag per package.
 *
 * Usage:
 *   bun scripts/auto-release.ts --dry-run   # show what would happen
 *   bun scripts/auto-release.ts             # apply
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildPlans, changelogSections, type Plan } from "./derive-version.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DRY = process.argv.includes("--dry-run");
const REPO = "https://github.com/mrmm/opencode-omp";

const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const D = "\x1b[2m";
const X = "\x1b[0m";

const step = (m: string) => console.log(`${D}→${X} ${m}`);
const done = (m: string) => console.log(`${G}✓${X} ${m}`);
const die = (m: string): never => {
	console.error(`${R}✗${X} ${m}`);
	process.exit(1);
};

function sh(cmd: string): string {
	return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Fold commits into a dated changelog section, preserving manual [Unreleased] prose. */
function renderChangelog(existing: string, plan: Plan): string {
	const today = new Date().toISOString().slice(0, 10);
	const sections = changelogSections(plan.commits);

	const manual = (
		existing.match(/^##\s*\[unreleased\][^\n]*\n([\s\S]*?)(?=^##\s*\[|\Z)/im)?.[1] ?? ""
	).trim();

	const generated: string[] = [];
	for (const [label, commits] of sections) {
		generated.push(`### ${label}`, "");
		for (const c of commits) {
			const scope = c.scope ? `**${c.scope}**: ` : "";
			generated.push(`- ${scope}${c.subject} (${c.sha})`);
		}
		generated.push("");
	}

	// Manual prose wins the top slot; generated commit list follows so nothing
	// that actually shipped can be silently omitted.
	const body = [manual, generated.join("\n").trim()].filter(Boolean).join("\n\n");

	let out = existing.replace(
		/^##\s*\[unreleased\][^\n]*$/im,
		`## [Unreleased]\n\n## [${plan.next}] - ${today}\n\n${body}`,
	);

	// Drop the now-duplicated manual block that sat under the old [Unreleased].
	if (manual) {
		const dupe = `## [${plan.next}] - ${today}\n\n${body}\n${manual}`;
		if (out.includes(dupe)) out = out.replace(dupe, `## [${plan.next}] - ${today}\n\n${body}\n`);
	}

	out = out
		.replace(/^\[unreleased\]:.*$/im, `[Unreleased]: ${REPO}/compare/${plan.name}@${plan.next}...HEAD`)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n*$/, "\n");

	if (!new RegExp(`^\\[${plan.next?.replace(/\./g, "\\.")}\\]:`, "im").test(out)) {
		out += `[${plan.next}]: ${REPO}/releases/tag/${plan.name}@${plan.next}\n`;
	}
	return out;
}

const plans = buildPlans().filter((p) => p.next);

if (plans.length === 0) {
	console.log(`\n${D}nothing to release — no release-worthy commits since the last tags${X}\n`);
	process.exit(0);
}

console.log(`\n${D}auto-release${X}${DRY ? `  ${Y}(dry run)${X}` : ""}\n`);
for (const p of plans) {
	console.log(`  ${p.name}  ${G}${p.current} → ${p.next}${X}  ${D}(${p.bump})${X}`);
}
console.log("");

if (!DRY) {
	step("checking working tree");
	if (sh("git status --porcelain")) die("Working tree is dirty — refusing to release.");
	done("tree clean");
}

step("running tests");
try {
	sh("bun test");
	done("tests pass");
} catch (e) {
	die(`Tests failed:\n${(e as Error).message.slice(0, 600)}`);
}

step("running typecheck");
try {
	sh("bun run typecheck");
	done("typecheck clean");
} catch (e) {
	die(`Typecheck failed:\n${(e as Error).message.slice(0, 600)}`);
}

if (DRY) {
	for (const p of plans) {
		console.log(`\n${D}── ${p.name} changelog preview ──${X}`);
		const cl = readFileSync(join(p.dir, "CHANGELOG.md"), "utf8");
		const rendered = renderChangelog(cl, p);
		const start = rendered.indexOf(`## [${p.next}]`);
		console.log(rendered.slice(start, start + 700));
	}
	console.log(`\n${Y}dry run — nothing written${X}\n`);
	process.exit(0);
}

const touched: string[] = [];
for (const p of plans) {
	const pjPath = join(p.dir, "package.json");
	writeFileSync(
		pjPath,
		readFileSync(pjPath, "utf8").replace(/("version"\s*:\s*)"[^"]+"/, `$1"${p.next}"`),
	);
	const clPath = join(p.dir, "CHANGELOG.md");
	writeFileSync(clPath, renderChangelog(readFileSync(clPath, "utf8"), p));
	touched.push(pjPath, clPath);
	done(`${p.name} → ${p.next}`);
}

step("verifying hygiene gate");
try {
	sh("bun scripts/check-versions.ts");
	done("hygiene gate passed");
} catch (e) {
	die(`Hygiene gate failed after bump:\n${(e as Error).message.slice(0, 600)}`);
}

step("committing");
sh(`git add ${touched.map((f) => JSON.stringify(f)).join(" ")}`);
const summary = plans.map((p) => `${p.name}@${p.next}`).join(", ");
// [skip ci] prevents the release commit from re-triggering the release workflow.
sh(`git commit -m ${JSON.stringify(`chore(release): ${summary} [skip ci]`)}`);
done(`committed ${summary}`);

step("tagging");
for (const p of plans) {
	const tag = `${p.name}@${p.next}`;
	sh(`git tag -a ${JSON.stringify(tag)} -m ${JSON.stringify(`${p.name} ${p.next}`)}`);
	done(`tagged ${tag}`);
}

console.log(`\n${G}released${X} ${summary}\n`);
console.log(JSON.stringify({ released: plans.map((p) => ({ name: p.name, version: p.next })) }));
