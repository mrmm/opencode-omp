#!/usr/bin/env bun
/**
 * Derive each package's next version from Conventional Commits.
 *
 * No human picks a number. The commit history is the source of truth:
 * a commit's type determines the bump, and the files it touched determine
 * which package that bump applies to.
 *
 *   feat:              -> minor   (major-bumping is opt-in via ! / BREAKING CHANGE)
 *   fix: perf:         -> patch
 *   BREAKING CHANGE /! -> major   (minor while 0.x, per semver §4)
 *   everything else    -> none
 *
 * Scope is a hint, not the rule. `fix(hashline):` that only edits snapcompact
 * files releases snapcompact — paths cannot lie, scopes can.
 *
 * Usage:
 *   bun scripts/derive-version.ts            # human-readable
 *   bun scripts/derive-version.ts --json     # machine-readable, for CI
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG_DIR = join(ROOT, "packages");
const AS_JSON = process.argv.includes("--json");

export type Bump = "major" | "minor" | "patch" | "none";

export interface Commit {
	sha: string;
	type: string;
	scope: string | null;
	breaking: boolean;
	subject: string;
	files: string[];
}

export interface Plan {
	name: string;
	/** Directory basename under packages/. */
	dirName: string;
	/** Git tag base — the package name with any npm scope stripped, since a
	 *  slash in a tag is legal but awkward to type and to match. */
	tagName: string;
	dir: string;
	current: string;
	bump: Bump;
	next: string | null;
	commits: Commit[];
	lastTag: string | null;
	reason: string;
}

function git(cmd: string): string {
	try {
		return execSync(`git ${cmd}`, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 32 * 1024 * 1024,
		}).trim();
	} catch {
		return "";
	}
}

/** Conventional Commits header: type(scope)!: subject */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<subject>.+)$/;

const MINOR_TYPES = new Set(["feat"]);
const PATCH_TYPES = new Set(["fix", "perf", "revert"]);

function bumpRank(b: Bump): number {
	return b === "major" ? 3 : b === "minor" ? 2 : b === "patch" ? 1 : 0;
}

function bumpFor(c: Commit): Bump {
	if (c.breaking) return "major";
	if (MINOR_TYPES.has(c.type)) return "minor";
	if (PATCH_TYPES.has(c.type)) return "patch";
	return "none";
}

/**
 * Apply a bump. While 0.x, a breaking change moves the MINOR — semver §4 says
 * anything may change at any time in 0.y.z, so burning 1.0.0 on the first
 * breaking change would be wrong.
 */
export function applyBump(version: string, bump: Bump): string | null {
	if (bump === "none") return null;
	const [maj = 0, min = 0, pat = 0] = version.split(".").map(Number);
	const preStable = maj === 0;
	if (bump === "major") {
		return preStable ? `0.${min + 1}.0` : `${maj + 1}.0.0`;
	}
	if (bump === "minor") return `${maj}.${min + 1}.0`;
	return `${maj}.${min}.${pat + 1}`;
}

/** `@scope/name` -> `name`. Tags never carry the scope. */
export function tagNameFor(pkgName: string): string {
	return pkgName.replace(/^@[^/]+\//, "");
}

function latestTagFor(pkgName: string): string | null {
	const tags = git(`tag -l ${JSON.stringify(`${tagNameFor(pkgName)}@*`)} --sort=-v:refname`)
		.split("\n")
		.filter(Boolean);
	return tags[0] ?? null;
}

function commitsSince(ref: string | null): Commit[] {
	const range = ref ? `${ref}..HEAD` : "HEAD";
	const raw = git(`log ${range} --no-merges --format=%H%x1f%B%x1e`);
	if (!raw) return [];

	const out: Commit[] = [];
	for (const chunk of raw.split("\x1e")) {
		const trimmed = chunk.trim();
		if (!trimmed) continue;
		const [sha = "", body = ""] = trimmed.split("\x1f");
		const header = body.split("\n")[0] ?? "";
		const m = header.match(HEADER);
		if (!m?.groups) continue;

		const breaking =
			m.groups.bang === "!" || /^BREAKING[ -]CHANGE:/m.test(body);

		const files = git(`show --pretty=format: --name-only ${sha}`)
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);

		out.push({
			sha: sha.slice(0, 8),
			type: m.groups.type ?? "",
			scope: m.groups.scope ?? null,
			breaking,
			subject: m.groups.subject ?? "",
			files,
		});
	}
	return out;
}

export function buildPlans(): Plan[] {
	if (!existsSync(PKG_DIR)) return [];
	const plans: Plan[] = [];
	/** package name -> directory basename, for workspace dep resolution. */
	const nameToDir = new Map<string, string>();
	/** directory basename -> workspace dependency names. */
	const deps = new Map<string, string[]>();

	for (const entry of readdirSync(PKG_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(PKG_DIR, entry.name);
		const pjPath = join(dir, "package.json");
		if (!existsSync(pjPath)) continue;

		const pj = JSON.parse(readFileSync(pjPath, "utf8")) as {
			name: string;
			version: string;
			private?: boolean;
		};
		if (pj.private) continue;

		nameToDir.set(pj.name, entry.name);
		deps.set(
			entry.name,
			Object.keys((pj as { dependencies?: Record<string, string> }).dependencies ?? {}),
		);

		const lastTag = latestTagFor(pj.name);
		const prefix = `packages/${entry.name}/`;

		// Path-based attribution. A commit counts for this package when it
		// touched the package, or when it touched shared tooling that ships
		// with it (root config, scripts, workflows).
		const relevant = commitsSince(lastTag).filter((c) =>
			c.files.some((f) => f.startsWith(prefix)),
		);

		let bump: Bump = "none";
		for (const c of relevant) {
			const b = bumpFor(c);
			if (bumpRank(b) > bumpRank(bump)) bump = b;
		}

		const next = applyBump(pj.version, bump);
		const reason = !lastTag
			? "never released — tag it to establish a baseline"
			: relevant.length === 0
				? `no commits touching ${prefix} since ${lastTag}`
				: bump === "none"
					? `${relevant.length} commit(s), none release-worthy`
					: `${relevant.length} commit(s) -> ${bump}`;

		plans.push({
			name: pj.name,
			dirName: entry.name,
			tagName: tagNameFor(pj.name),
			dir,
			current: pj.version,
			bump,
			next,
			commits: relevant,
			lastTag,
			reason,
		});
	}

	// Propagate shared-package releases to their dependents.
	//
	// Path attribution alone misses this: editing packages/telemetry does not
	// touch packages/hashline, yet a hashline release must go out for consumers
	// to receive the change. Resolved to a fixed point so a chain of internal
	// dependencies propagates fully.
	const byName = new Map(plans.map((p) => [p.name, p]));
	let changed = true;
	while (changed) {
		changed = false;
		for (const plan of plans) {
			if (plan.next) continue; // already releasing
			const myDeps = deps.get(plan.dirName) ?? [];
			const releasingDep = myDeps
				.map((d) => byName.get(d))
				.find((d) => d?.next);
			if (releasingDep) {
				plan.bump = "patch";
				plan.next = applyBump(plan.current, "patch");
				plan.reason = `dependency ${releasingDep.tagName} releases ${releasingDep.next}`;
				changed = true;
			}
		}
	}

	return plans;
}

/** Fold commits into a dated changelog section, preserving manual [Unreleased] prose. */
/** Repository the changelog compare/tag links point at. */
export const REPO = "https://github.com/mrmm/opencode-omp";

export function renderChangelog(existing: string, plan: Plan): string {
	const today = new Date().toISOString().slice(0, 10);
	const sections = changelogSections(plan.commits);

	const manual = (
		existing.match(/^##\s*\[unreleased\][^\n]*\n([\s\S]*?)(?=^##\s*\[|\Z)/im)?.[1] ?? ""
	).trim();

	const generated: string[] = [];

	// A dependency-only bump carries no commits of its own, which previously
	// rendered a version heading with nothing under it. Explain why it shipped.
	if (plan.commits.length === 0 && plan.reason) {
		generated.push("### Changed", "", `- ${plan.reason}. No change to this package's own behaviour; released`,
			"  so the published artifact carries the current shared code.", "");
	}

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
		.replace(/^\[unreleased\]:.*$/im, `[Unreleased]: ${REPO}/compare/${plan.tagName}@${plan.next}...HEAD`)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n*$/, "\n");

	if (!new RegExp(`^\\[${plan.next?.replace(/\./g, "\\.")}\\]:`, "im").test(out)) {
		out += `[${plan.next}]: ${REPO}/releases/tag/${plan.tagName}@${plan.next}\n`;
	}
	return out;
}

/** Group commits into changelog sections. */
export function changelogSections(commits: Commit[]): Map<string, Commit[]> {
	const LABEL: Record<string, string> = {
		feat: "Added",
		fix: "Fixed",
		perf: "Performance",
		revert: "Reverted",
		docs: "Documentation",
		refactor: "Changed",
		chore: "Changed",
		test: "Changed",
		build: "Changed",
		ci: "Changed",
	};
	const out = new Map<string, Commit[]>();
	const breaking = commits.filter((c) => c.breaking);
	if (breaking.length) out.set("Breaking", breaking);
	for (const c of commits) {
		if (c.breaking) continue;
		const label = LABEL[c.type];
		if (!label) continue;
		if (!out.has(label)) out.set(label, []);
		out.get(label)?.push(c);
	}
	return out;
}

if (import.meta.main) {
	const plans = buildPlans();

	if (AS_JSON) {
		console.log(JSON.stringify(plans, null, 2));
	} else {
		const G = "\x1b[32m";
		const Y = "\x1b[33m";
		const D = "\x1b[2m";
		const X = "\x1b[0m";
		console.log(`\n${D}derived from conventional commits${X}\n`);
		for (const p of plans) {
			const arrow = p.next ? `${G}${p.current} → ${p.next}${X}` : `${D}${p.current} (hold)${X}`;
			console.log(`  ${p.name}  ${arrow}`);
			console.log(`    ${D}${p.reason}${X}`);
			for (const c of p.commits.slice(0, 6)) {
				const mark = c.breaking ? `${Y}!${X}` : " ";
				console.log(`    ${mark} ${c.sha} ${c.type}: ${c.subject.slice(0, 66)}`);
			}
            if (p.commits.length > 6) console.log(`      ${D}… ${p.commits.length - 6} more${X}`);
			console.log("");
		}
		const releasing = plans.filter((p) => p.next);
		console.log(
			releasing.length
				? `${releasing.length} package(s) to release\n`
				: `${D}nothing to release${X}\n`,
		);
	}
}
