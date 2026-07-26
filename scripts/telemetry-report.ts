#!/usr/bin/env bun
/**
 * Summarise locally collected telemetry.
 *
 * Reads the JSONL sinks and prints counters plus histogram percentiles. The
 * questions it exists to answer:
 *
 *   hashline    — how often does the stale-anchor guard actually fire, and what
 *                 does one tag really cost versus a hash per line?
 *   snapcompact — what is the REAL density distribution? The gate's thresholds
 *                 were calibrated on synthetic corpora; this is the evidence
 *                 that confirms or refutes that calibration.
 *
 * Usage:
 *   bun scripts/telemetry-report.ts
 *   bun scripts/telemetry-report.ts --json
 *   bun scripts/telemetry-report.ts --dir /custom/state/dir
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AS_JSON = process.argv.includes("--json");
const dirFlag = process.argv.indexOf("--dir");
const STATE_DIR =
	dirFlag !== -1
		? (process.argv[dirFlag + 1] ?? "")
		: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-omp");

const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const X = "\x1b[0m";

interface Record_ {
	name: string;
	instrument: "counter" | "histogram" | "event";
	value: number;
	attributes: Record<string, unknown>;
	service: string;
	session: string;
	ts: string;
}

function load(dir: string): Record_[] {
	if (!existsSync(dir)) return [];
	const out: Record_[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".jsonl") && !/\.jsonl\.\d+$/.test(f)) continue;
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as Record_);
			} catch {
				/* skip a torn final line */
			}
		}
	}
	return out;
}

function pctile(values: number[], p: number): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

const records = load(STATE_DIR);

if (records.length === 0) {
	console.log(`\n${D}no telemetry found in ${STATE_DIR}${X}`);
	console.log(`${D}it is written as the plugins are used; nothing is sent anywhere.${X}\n`);
	process.exit(0);
}

const byService = new Map<string, Record_[]>();
for (const r of records) {
	if (!byService.has(r.service)) byService.set(r.service, []);
	byService.get(r.service)?.push(r);
}

const report: Record<string, unknown> = {};

for (const [service, rows] of byService) {
	const counters = new Map<string, Map<string, number>>();
	const hists = new Map<string, number[]>();

	for (const r of rows) {
		if (r.instrument === "histogram") {
			if (!hists.has(r.name)) hists.set(r.name, []);
			hists.get(r.name)?.push(r.value);
		} else {
			const attrKey =
				Object.entries(r.attributes ?? {})
					.filter(([k]) => k !== "session")
					.map(([k, v]) => `${k}=${v}`)
					.sort()
					.join(" ") || "-";
			if (!counters.has(r.name)) counters.set(r.name, new Map());
			const m = counters.get(r.name)!;
			m.set(attrKey, (m.get(attrKey) ?? 0) + r.value);
		}
	}

	const sessions = new Set(rows.map((r) => r.session)).size;
	const span = [rows[0]?.ts, rows[rows.length - 1]?.ts];

	report[service] = {
		records: rows.length,
		sessions,
		from: span[0],
		to: span[1],
		counters: Object.fromEntries(
			[...counters].map(([n, m]) => [n, Object.fromEntries(m)]),
		),
		histograms: Object.fromEntries(
			[...hists].map(([n, v]) => [
				n,
				{
					n: v.length,
					min: Math.min(...v),
					p50: pctile(v, 50),
					p95: pctile(v, 95),
					max: Math.max(...v),
					mean: v.reduce((a, b) => a + b, 0) / v.length,
				},
			]),
		),
	};

	if (AS_JSON) continue;

	console.log(`\n${C}${service}${X}  ${D}${rows.length} records · ${sessions} session(s)${X}`);
	console.log(`${D}${span[0]?.slice(0, 19)} → ${span[1]?.slice(0, 19)}${X}\n`);

	if (counters.size) {
		console.log(`  ${D}counters${X}`);
		for (const [name, m] of [...counters].sort()) {
			const total = [...m.values()].reduce((a, b) => a + b, 0);
			console.log(`    ${name.padEnd(42)} ${String(total).padStart(6)}`);
			if (m.size > 1 || [...m.keys()][0] !== "-") {
				for (const [attr, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
					console.log(`      ${D}${attr.padEnd(38)}${X} ${String(v).padStart(6)}`);
				}
			}
		}
		console.log("");
	}

	if (hists.size) {
		console.log(`  ${D}histograms${X}`);
		console.log(
			`    ${"metric".padEnd(42)} ${"n".padStart(5)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"max".padStart(9)}`,
		);
		for (const [name, v] of [...hists].sort()) {
			console.log(
				`    ${name.padEnd(42)} ${String(v.length).padStart(5)} ` +
					`${pctile(v, 50).toFixed(2).padStart(9)} ${pctile(v, 95).toFixed(2).padStart(9)} ` +
					`${Math.max(...v).toFixed(2).padStart(9)}`,
			);
		}
		console.log("");
	}

	// ── the questions this data exists to answer ──
	const stale = [...(counters.get("hashline.patch.stale_anchor")?.values() ?? [])].reduce(
		(a, b) => a + b,
		0,
	);
	const applied = [...(counters.get("hashline.patch.applied")?.values() ?? [])].reduce(
		(a, b) => a + b,
		0,
	);
	if (stale + applied > 0) {
		const rate = (100 * stale) / (stale + applied);
		console.log(
			`  ${Y}stale-anchor rate${X}  ${rate.toFixed(1)}%  ${D}(${stale} caught of ${stale + applied} attempts)${X}`,
		);
		console.log(`  ${D}how often content-anchoring prevented an edit against a changed file${X}\n`);
	}

	const overhead = hists.get("hashline.read.overhead_chars");
	const perLine = hists.get("hashline.read.per_line_would_cost");
	if (overhead?.length && perLine?.length) {
		const a = overhead.reduce((x, y) => x + y, 0);
		const b = perLine.reduce((x, y) => x + y, 0);
		console.log(
			`  ${G}tag overhead${X}  ${a} chars total vs ${b} for per-line hashing  ${D}(${(b / Math.max(a, 1)).toFixed(0)}x cheaper)${X}\n`,
		);
	}

	const density = hists.get("snapcompact.density.chars_per_token");
	if (density?.length) {
		console.log(
			`  ${G}measured density${X}  p50 ${pctile(density, 50).toFixed(2)} chars/token ` +
				`${D}(frame rate 4.23 on Anthropic — below that, framing pays)${X}`,
		);
		const below = density.filter((d) => d < 4.23).length;
		console.log(
			`  ${D}${below}/${density.length} payloads (${((100 * below) / density.length).toFixed(0)}%) were dense enough to profit${X}\n`,
		);
	}

	const err = hists.get("snapcompact.saving_estimate_error_pct");
	if (err?.length) {
		const mean = err.reduce((a, b) => a + b, 0) / err.length;
		console.log(
			`  ${Y}estimate drift${X}  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} pp ` +
				`${D}(projected vs realised saving; near zero means the model is calibrated)${X}\n`,
		);
	}
}

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else console.log(`${D}source: ${STATE_DIR}${X}\n`);
