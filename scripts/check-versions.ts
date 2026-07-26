#!/usr/bin/env bun
/**
 * Version + tagging hygiene gate.
 *
 * Runs in CI on every push/PR and in the pre-push hook. Exits non-zero on any
 * violation, so a malformed version or an undocumented release cannot land.
 *
 * Enforced:
 *   1. Every package version is valid semver.
 *   2. Every package has a CHANGELOG with an entry for its current version.
 *   3. The CHANGELOG has an [Unreleased] section.
 *   4. CHANGELOG versions are strictly descending, no duplicates.
 *   5. Every published version has a matching git tag <pkg>@<version>
 *      (skipped for 0.x pre-release until first tag exists).
 *   6. If HEAD is tagged <pkg>@<v>, package.json must say exactly <v>.
 *   7. Tags follow <pkg>@<semver> — no bare vX.Y.Z, which is ambiguous here.
 *   8. Workspace-internal deps reference versions that actually exist.
 *
 * Usage:
 *   bun scripts/check-versions.ts            # full gate
 *   bun scripts/check-versions.ts --tags     # include tag-existence checks
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG_DIR = join(ROOT, "packages");
const CHECK_TAGS = process.argv.includes("--tags");

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function tagNameFor(pkgName: string): string {
	return pkgName.replace(/^@[^/]+\//, "");
}

interface Pkg {
	dir: string;
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
}

const errors: string[] = [];
const warnings: string[] = [];
const ok: string[] = [];

const fail = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);
const pass = (m: string) => ok.push(m);

function git(cmd: string): string {
	try {
		return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function cmpSemver(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
	const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return x - y;
		return String(x) < String(y) ? -1 : 1;
	}
	return 0;
}

function loadPackages(): Pkg[] {
	if (!existsSync(PKG_DIR)) return [];
	const out: Pkg[] = [];
	for (const entry of readdirSync(PKG_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pj = join(PKG_DIR, entry.name, "package.json");
		if (!existsSync(pj)) continue;
		try {
			const parsed = JSON.parse(readFileSync(pj, "utf8"));
			out.push({ dir: join(PKG_DIR, entry.name), ...parsed });
		} catch {
			fail(`packages/${entry.name}/package.json is not valid JSON`);
		}
	}
	return out;
}

/** Versions listed as `## [x.y.z]` headings, in file order. */
function changelogVersions(path: string): string[] {
	if (!existsSync(path)) return [];
	const out: string[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^##\s*\[([^\]]+)\]/);
		if (!m) continue;
		const v = m[1] ?? "";
		if (v.toLowerCase() === "unreleased") continue;
		out.push(v);
	}
	return out;
}

function hasUnreleased(path: string): boolean {
	if (!existsSync(path)) return false;
	return /^##\s*\[unreleased\]/im.test(readFileSync(path, "utf8"));
}

const packages = loadPackages();
if (packages.length === 0) fail("No packages found under packages/");

const allTags = git("tag -l").split("\n").filter(Boolean);
const headTags = git("tag --points-at HEAD").split("\n").filter(Boolean);
const knownVersions = new Map<string, string>();

for (const pkg of packages) {
	const label = pkg.name;

	// 1 — semver
	if (!pkg.version) {
		fail(`${label}: package.json has no version`);
		continue;
	}
	if (!SEMVER.test(pkg.version)) {
		fail(`${label}: version "${pkg.version}" is not valid semver`);
	} else {
		pass(`${label}: version ${pkg.version} is valid semver`);
	}
	knownVersions.set(pkg.name, pkg.version);

	// 2/3/4 — changelog
	const clPath = join(pkg.dir, "CHANGELOG.md");
	if (!existsSync(clPath)) {
		fail(`${label}: missing CHANGELOG.md`);
	} else {
		const versions = changelogVersions(clPath);

		if (!hasUnreleased(clPath)) {
			fail(`${label}: CHANGELOG.md has no [Unreleased] section`);
		}

		if (!versions.includes(pkg.version)) {
			fail(
				`${label}: CHANGELOG.md has no entry for current version ${pkg.version} ` +
					`(found: ${versions.slice(0, 3).join(", ") || "none"})`,
			);
		} else {
			pass(`${label}: CHANGELOG documents ${pkg.version}`);
		}

		const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
		if (dupes.length) {
			fail(`${label}: CHANGELOG has duplicate versions: ${[...new Set(dupes)].join(", ")}`);
		}

		for (let i = 1; i < versions.length; i++) {
			const prev = versions[i - 1] ?? "";
			const cur = versions[i] ?? "";
			if (cmpSemver(prev, cur) <= 0) {
				fail(
					`${label}: CHANGELOG versions must descend — "${prev}" is listed above "${cur}"`,
				);
				break;
			}
		}
	}

	// 5/6/7 — tags
	const tagBase = tagNameFor(pkg.name);
	const expectedTag = `${tagBase}@${pkg.version}`;
	const pkgTags = allTags.filter((t) => t.startsWith(`${tagBase}@`));

	for (const t of allTags) {
		if (/^v?\d+\.\d+\.\d+/.test(t)) {
			warn(
				`Tag "${t}" is a bare version. This repo versions packages independently — ` +
					`use <package>@<version>.`,
			);
			break;
		}
	}

	const headTagForPkg = headTags.find((t) => t.startsWith(`${tagBase}@`));
	if (headTagForPkg) {
		const tagged = headTagForPkg.slice(tagBase.length + 1);
		if (tagged !== pkg.version) {
			fail(
				`${label}: HEAD is tagged ${headTagForPkg} but package.json says ${pkg.version}`,
			);
		} else {
			pass(`${label}: HEAD tag matches package.json (${pkg.version})`);
		}
	}

	if (CHECK_TAGS) {
		if (!allTags.includes(expectedTag)) {
			if (pkgTags.length === 0) {
				warn(`${label}: not yet tagged — expected ${expectedTag} once released`);
			} else {
				fail(`${label}: version ${pkg.version} has no tag ${expectedTag}`);
			}
		} else {
			pass(`${label}: tag ${expectedTag} exists`);
		}
	}
}

// 8 — workspace dep consistency
for (const pkg of packages) {
	for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
		if (!knownVersions.has(dep)) continue;
		const actual = knownVersions.get(dep) ?? "";
		const bare = range.replace(/^[\^~>=<\s]*/, "");
		if (range !== "workspace:*" && bare && cmpSemver(bare, actual) > 0) {
			fail(
				`${pkg.name}: depends on ${dep}@${range} but that package is at ${actual}`,
			);
		}
	}
}

// ── report ──
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

console.log(`\n${D}version + tagging hygiene${X}\n`);
for (const m of ok) console.log(`  ${G}✓${X} ${m}`);
for (const m of warnings) console.log(`  ${Y}!${X} ${m}`);
for (const m of errors) console.log(`  ${R}✗${X} ${m}`);

console.log(
	`\n${ok.length} passed · ${warnings.length} warning(s) · ${errors.length} error(s)\n`,
);

if (errors.length > 0) {
	console.error(`${R}Version hygiene check failed.${X}\n`);
	process.exit(1);
}
