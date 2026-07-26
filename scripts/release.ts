#!/usr/bin/env bun
/**
 * Release a single package: bump → changelog → verify → commit → tag.
 *
 * Packages version independently, so every release targets exactly one package
 * and produces exactly one tag: <package>@<version>.
 *
 * Usage:
 *   bun scripts/release.ts hashline patch
 *   bun scripts/release.ts snapcompact minor --dry-run
 *   bun scripts/release.ts hashline 1.2.3
 *
 * Refuses to proceed on a dirty tree, an existing tag, a missing changelog
 * entry, or a failing test/typecheck run.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

const die = (m: string): never => {
	console.error(`${R}✗${X} ${m}`);
	process.exit(1);
};
const step = (m: string) => console.log(`${D}→${X} ${m}`);
const done = (m: string) => console.log(`${G}✓${X} ${m}`);

function sh(cmd: string, allowFail = false): string {
	try {
		return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (e) {
		if (allowFail) return "";
		const err = e as { stdout?: string; stderr?: string; message: string };
		throw new Error(err.stderr || err.stdout || err.message);
	}
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const [pkgArg, bumpArg] = positional;

if (!pkgArg || !bumpArg) {
	console.log(`
${D}Usage${X}
  bun scripts/release.ts <package> <patch|minor|major|x.y.z> [--dry-run]

${D}Examples${X}
  bun scripts/release.ts hashline patch
  bun scripts/release.ts snapcompact minor --dry-run
`);
	process.exit(1);
}

const pkgDir = join(ROOT, "packages", pkgArg);
const pkgJsonPath = join(pkgDir, "package.json");
if (!existsSync(pkgJsonPath)) die(`No package at packages/${pkgArg}`);

const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
	name: string;
	version: string;
};
const { name, version: current } = pkgJson;

function bump(v: string, kind: string): string {
	if (/^\d+\.\d+\.\d+/.test(kind)) return kind;
	const [maj = 0, min = 0, pat = 0] = v.split(".").map(Number);
	if (kind === "major") return `${maj + 1}.0.0`;
	if (kind === "minor") return `${maj}.${min + 1}.0`;
	if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
	return die(`Unknown bump "${kind}" — use patch, minor, major, or an explicit x.y.z`);
}

const next = bump(current, bumpArg);
const tag = `${name}@${next}`;

console.log(`\n${D}release${X} ${name}  ${current} → ${G}${next}${X}  ${D}tag ${tag}${X}\n`);

// ── preflight ──
step("checking working tree");
if (sh("git status --porcelain")) {
	die("Working tree is dirty. Commit or stash first — a release must be reproducible.");
}
done("tree clean");

step("checking tag availability");
if (sh(`git tag -l ${JSON.stringify(tag)}`)) die(`Tag ${tag} already exists`);
done(`${tag} is free`);

step("checking changelog");
const clPath = join(pkgDir, "CHANGELOG.md");
if (!existsSync(clPath)) die(`Missing ${clPath}`);
const changelog = readFileSync(clPath, "utf8");
if (!/^##\s*\[unreleased\]/im.test(changelog)) {
	die("CHANGELOG.md has no [Unreleased] section to promote");
}

const unreleasedBody = (changelog.match(
	/^##\s*\[unreleased\][^\n]*\n([\s\S]*?)(?=^##\s*\[|\Z)/im,
)?.[1] ?? "").trim();

if (!unreleasedBody && !dryRun) {
	die(
		"[Unreleased] is empty — document the change before releasing.\n" +
			"  An undocumented release is indistinguishable from an accidental one.",
	);
}
done(`[Unreleased] has ${unreleasedBody.split("\n").filter(Boolean).length} line(s)`);

step("running tests");
try {
	sh("bun test");
	done("tests pass");
} catch (e) {
	die(`Tests failed:\n${(e as Error).message.slice(0, 800)}`);
}

step("running typecheck");
try {
	sh("bun run typecheck");
	done("typecheck clean");
} catch (e) {
	die(`Typecheck failed:\n${(e as Error).message.slice(0, 800)}`);
}

if (dryRun) {
	console.log(`\n${Y}dry run — no changes written${X}`);
	console.log(`${D}would bump${X}    ${pkgJsonPath}`);
	console.log(`${D}would promote${X} [Unreleased] → [${next}]`);
	console.log(`${D}would commit${X}  release(${pkgArg}): ${next}`);
	console.log(`${D}would tag${X}     ${tag}\n`);
	process.exit(0);
}

// ── apply ──
step("bumping package.json");
writeFileSync(
	pkgJsonPath,
	`${readFileSync(pkgJsonPath, "utf8").replace(
		/("version"\s*:\s*)"[^"]+"/,
		`$1"${next}"`,
	)}`.replace(/\n*$/, "\n"),
);
done(`version → ${next}`);

step("promoting changelog entry");
const today = new Date().toISOString().slice(0, 10);
const repo = "https://github.com/mrmm/opencode-omp";
let updated = changelog.replace(
	/^(##\s*\[unreleased\][^\n]*)$/im,
	`$1\n\n## [${next}] - ${today}`,
);
// Refresh link refs.
updated = updated
	.replace(
		/^\[unreleased\]:.*$/im,
		`[Unreleased]: ${repo}/compare/${name}@${next}...HEAD`,
	)
	.replace(/\n*$/, "\n");
if (!new RegExp(`^\\[${next.replace(/\./g, "\\.")}\\]:`, "im").test(updated)) {
	updated = `${updated.replace(/\n*$/, "\n")}[${next}]: ${repo}/releases/tag/${name}@${next}\n`;
}
writeFileSync(clPath, updated);
done(`[Unreleased] → [${next}] (${today})`);

step("verifying hygiene gate");
try {
	sh("bun scripts/check-versions.ts");
	done("hygiene gate passed");
} catch (e) {
	die(`Hygiene gate failed after bump:\n${(e as Error).message.slice(0, 800)}`);
}

step("committing");
sh(`git add ${JSON.stringify(pkgJsonPath)} ${JSON.stringify(clPath)}`);
sh(`git commit -m ${JSON.stringify(`release(${pkgArg}): ${next}`)}`);
done(`committed release(${pkgArg}): ${next}`);

step("tagging");
sh(`git tag -a ${JSON.stringify(tag)} -m ${JSON.stringify(`${name} ${next}`)}`);
done(`tagged ${tag}`);

console.log(`
${G}released${X} ${name} ${next}

${D}next${X}
  git push origin main --follow-tags
  cd packages/${pkgArg} && npm publish --access public
`);
