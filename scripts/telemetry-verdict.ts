#!/usr/bin/env bun
/**
 * Is each plugin worth keeping?
 *
 * A plugin's cost is not what it does when used — it is what it charges when it
 * is NOT used. Every tool definition and system-prompt fragment is re-sent on
 * every turn, forever. A plugin invoked twice a week can easily cost more than
 * it ever saves.
 *
 * This prices both sides in tokens and reports the net:
 *
 *   standing cost = (prompt + tool definitions) x turns
 *   realised gain = tokens actually saved, from recorded events
 *   verdict       = gain - cost, plus whether there is enough data to trust it
 *
 * Character counts are recorded by the plugins (cheap, exact) and tokenised
 * here with a real BPE, so the plugins themselves stay dependency-free.
 *
 * Usage:
 *   bun scripts/telemetry-verdict.ts
 *   bun scripts/telemetry-verdict.ts --turns-per-session 40
 *   bun scripts/telemetry-verdict.ts --json
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getEncoding } from "js-tiktoken";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const flag = (name: string, dflt: number): number => {
	const i = argv.indexOf(name);
	if (i === -1) return dflt;
	const v = Number(argv[i + 1]);
	return Number.isFinite(v) && v > 0 ? v : dflt;
};
const dirFlag = argv.indexOf("--dir");
const STATE_DIR =
	dirFlag !== -1
		? (argv[dirFlag + 1] ?? "")
		: join(
				process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
				"opencode-omp",
			);

/** Turns per session. Conservative default; override once you know yours. */
const TURNS_PER_SESSION = flag("--turns-per-session", 30);

const enc = getEncoding("o200k_base");
/** Characters -> tokens, measured rather than assumed at 4 chars/token. */
const toTokens = (chars: number, sample?: string): number =>
	sample ? enc.encode(sample).length : Math.round(chars / 3.6);

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const B = "\x1b[1m";
const X = "\x1b[0m";

interface Rec {
	name: string;
	instrument: string;
	value: number;
	attributes: Record<string, unknown>;
	service: string;
	session: string;
	ts: string;
}

function load(dir: string): Rec[] {
	if (!existsSync(dir)) return [];
	const out: Rec[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.includes(".jsonl")) continue;
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as Rec);
			} catch {
				/* torn final line */
			}
		}
	}
	return out;
}

const records = load(STATE_DIR);
if (records.length === 0) {
	console.log(`\n${D}no telemetry in ${STATE_DIR}${X}`);
	console.log(`${D}use the plugins for a while, then run this again.${X}\n`);
	process.exit(0);
}

const byService = new Map<string, Rec[]>();
for (const r of records) {
	if (!byService.has(r.service)) byService.set(r.service, []);
	byService.get(r.service)?.push(r);
}

const sum = (rs: Rec[], name: string) =>
	rs.filter((r) => r.name === name).reduce((a, r) => a + r.value, 0);
const vals = (rs: Rec[], name: string) =>
	rs.filter((r) => r.name === name).map((r) => r.value);
const last = (rs: Rec[], name: string) => {
	const m = rs.filter((r) => r.name === name);
	return m.length ? (m[m.length - 1]?.value ?? 0) : 0;
};
const countWhere = (rs: Rec[], name: string, k: string, v: unknown) =>
	rs.filter((r) => r.name === name && r.attributes?.[k] === v).reduce((a, r) => a + r.value, 0);

interface Verdict {
	service: string;
	breakdown?: string;
	sessions: number;
	turns: number;
	standingCostTokens: number;
	realisedGainTokens: number;
	net: number;
	confidence: "none" | "low" | "moderate" | "good";
	lines: string[];
	recommendation: string;
}

const results: Verdict[] = [];

for (const [service, rs] of byService) {
	const sessions = new Set(rs.map((r) => r.session)).size;
	const turns = sessions * TURNS_PER_SESSION;
	const lines: string[] = [];

	// ── cost side ──
	const promptChars = last(rs, "hashline.standing_cost.system_prompt_chars");
	const toolChars =
		last(rs, "hashline.standing_cost.tool_def_chars") ||
		last(rs, "snapcompact.standing_cost.tool_def_chars");
	const standingChars =
		last(rs, "hashline.standing_cost.total_chars") ||
		last(rs, "snapcompact.standing_cost.total_chars") ||
		promptChars + toolChars;
	const standingTokensPerTurn = toTokens(standingChars);
	const standingCostTokens = standingTokensPerTurn * turns;
	const promptTokens = toTokens(promptChars);
	const toolTokens = toTokens(toolChars);
	const promptStyle = String(
		rs.find((r) => r.name === "hashline.standing_cost.system_prompt_chars")?.attributes
			?.style ?? "",
	);

	let realisedGainTokens = 0;

	if (service.includes("hashline")) {
		const tagged = sum(rs, "hashline.read.tagged");
		const overheadChars = vals(rs, "hashline.read.overhead_chars").reduce((a, b) => a + b, 0);
		const perLineChars = vals(rs, "hashline.read.per_line_would_cost").reduce((a, b) => a + b, 0);
		const applied = sum(rs, "hashline.patch.applied");
		const attempted = sum(rs, "hashline.patch.attempted");
		const stale = sum(rs, "hashline.patch.stale_anchor");
		const retryChars = vals(rs, "hashline.patch.retry_chars_avoided").reduce((a, b) => a + b, 0);
		const uniqueTargets = countWhere(rs, "hashline.patch.target", "unique", true);
		const dupTargets = countWhere(rs, "hashline.patch.target", "unique", false);

		// Gains, each traceable to a recorded event:
		//  1. averted corrective cycles from stale-anchor catches
		//  2. cheaper annotation than a hash on every line — but ONLY versus that
		//     alternative, not versus doing nothing, so it is reported separately
		const retryGain = toTokens(retryChars);
		const tagOverheadCost = toTokens(overheadChars);
		realisedGainTokens = retryGain - tagOverheadCost;

		lines.push(`reads tagged            ${tagged}`);
		lines.push(`tag overhead            ${overheadChars} chars ≈ ${tagOverheadCost} tokens (a real cost)`);
		lines.push(`vs per-line hashing     ${perLineChars} chars — avoided, but only against that design`);
		lines.push(`patches attempted       ${attempted}`);
		lines.push(`patches applied         ${applied}`);
		lines.push(`stale anchors caught    ${stale}${stale ? `  → ${retryGain} tokens of corrective cycles averted` : ""}`);
		lines.push("");
		lines.push(`${B}the decisive number${X}`);
		if (uniqueTargets + dupTargets === 0) {
			lines.push(`  no edit targets recorded yet — cannot tell whether the built-in`);
			lines.push(`  edit tool would have sufficed`);
		} else {
			const pctDup = (100 * dupTargets) / (uniqueTargets + dupTargets);
			lines.push(`  targets whose content was NOT unique: ${dupTargets}/${uniqueTargets + dupTargets} (${pctDup.toFixed(0)}%)`);
			lines.push(`  those are edits the built-in exact-string tool would REFUSE.`);
			lines.push(`  the other ${uniqueTargets} would have worked without this plugin.`);
		}
	}

	if (service.includes("snapcompact")) {
		const renderInvoked = sum(rs, "snapcompact.render.invoked");
		const estimateInvoked = sum(rs, "snapcompact.estimate.invoked");
		const compacted = sum(rs, "snapcompact.gate.compacted");
		const declined = sum(rs, "snapcompact.gate.declined");
		const netSaved = vals(rs, "snapcompact.net_tokens_saved").reduce((a, b) => a + b, 0);
		const density = vals(rs, "snapcompact.density.chars_per_token");
		realisedGainTokens = netSaved;

		lines.push(`render invoked          ${renderInvoked}`);
		lines.push(`estimate invoked        ${estimateInvoked}`);
		lines.push(`gate compacted          ${compacted}`);
		lines.push(`gate declined           ${declined}`);
		lines.push(`net tokens saved        ${netSaved >= 0 ? "+" : ""}${netSaved}`);
		if (density.length) {
			const sorted = [...density].sort((a, b) => a - b);
			const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
			const profitable = density.filter((d) => d < 4.23).length;
			lines.push("");
			lines.push(`${B}density reality check${X}`);
			lines.push(`  observed p50: ${p50.toFixed(2)} chars/token across ${density.length} sample(s)`);
			lines.push(`  ${profitable}/${density.length} dense enough to profit on Anthropic (needs < 4.23)`);
		}
		if (renderInvoked === 0) {
			lines.push("");
			lines.push(`${Y}never actually rendered${X} — currently pure standing cost`);
		}
	}

	const net = realisedGainTokens - standingCostTokens;

	// Confidence follows sample size, not the sign of the result.
	const signal =
		service.includes("hashline")
			? sum(rs, "hashline.patch.attempted") + sum(rs, "hashline.read.tagged")
			: sum(rs, "snapcompact.render.invoked") + sum(rs, "snapcompact.estimate.invoked");
	const confidence: Verdict["confidence"] =
		sessions < 2 || signal < 5 ? "none" : signal < 25 ? "low" : signal < 100 ? "moderate" : "good";

	const recommendation =
		confidence === "none"
			? "INSUFFICIENT DATA — keep it enabled and revisit; do not decide on this"
			: net > 0
				? "KEEP — measured gain exceeds standing cost"
				: confidence === "low"
					? "UNPROVEN — negative so far, but the sample is too small to act on"
					: "RECONSIDER — standing cost exceeds measured gain at this usage rate";

	// Where the standing cost actually sits, and the cheapest lever available.
	let breakdown: string | undefined;
	if (promptChars > 0) {
		const share = Math.round((100 * promptTokens) / Math.max(standingTokensPerTurn, 1));
		const briefSaving = promptStyle === "full" ? Math.round(promptTokens * 0.67) : 0;
		breakdown =
			`${D}cost is${X} ${standingTokensPerTurn}/turn = ${promptTokens} prompt (${share}%) + ${toolTokens} tool def` +
			(briefSaving
				? `\n  ${Y}lever${X}           promptStyle "brief" would cut ~${briefSaving} tokens/turn (~${(briefSaving * turns).toLocaleString()} over ${turns} turns)`
				: "");
	} else if (toolChars > 0) {
		breakdown = `${D}cost is${X} ${standingTokensPerTurn}/turn from ${toolTokens} tokens of tool definitions`;
	}

	results.push({
		service,
		breakdown,
		sessions,
		turns,
		standingCostTokens,
		realisedGainTokens,
		net,
		confidence,
		lines,
		recommendation,
	});
}

if (AS_JSON) {
	console.log(JSON.stringify(results, null, 2));
	process.exit(0);
}

console.log(`\n${B}is it worth keeping?${X}`);
console.log(
	`${D}standing cost assumes ${TURNS_PER_SESSION} turns/session (--turns-per-session to change)${X}\n`,
);

for (const v of results) {
	const colour = v.confidence === "none" ? Y : v.net > 0 ? G : R;
	console.log(`${C}${v.service}${X}  ${D}${v.sessions} session(s) ≈ ${v.turns} turns${X}`);
	console.log("");
	for (const l of v.lines) console.log(`  ${l}`);
	console.log("");
	if (v.breakdown) console.log(`  ${v.breakdown}`);
	console.log(`  ${D}standing cost${X}   −${v.standingCostTokens} tokens  ${D}(paid every turn, used or not)${X}`);
	console.log(`  ${D}realised gain${X}   ${v.realisedGainTokens >= 0 ? "+" : ""}${v.realisedGainTokens} tokens`);
    console.log(`  ${B}net${X}             ${colour}${v.net >= 0 ? "+" : ""}${v.net} tokens${X}`);
	console.log(`  ${D}confidence${X}      ${v.confidence}`);
	console.log(`  ${colour}${v.recommendation}${X}`);
	console.log("");
}

console.log(`${D}source: ${STATE_DIR}${X}`);
console.log(
	`${D}note: hashline's tag overhead is a real cost; the "vs per-line hashing" figure${X}`,
);
console.log(
	`${D}      is only an advantage over that specific alternative, not over doing nothing.${X}\n`,
);
