#!/usr/bin/env bun
/**
 * Telemetry inspection CLI.
 *
 * Exists so nobody has to open a JSONL file to answer "what is this costing me".
 * Every subcommand also supports --json for piping into something else.
 */
import { rmSync, statSync, watch as fsWatch } from "node:fs";

import {
	counterTotal,
	load,
	listSinks,
	loadTokeniser,
	sessions as sessionRows,
	stateDir,
	summarise,
	verdict,
	type ServiceSummary,
} from "./analyse.ts";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const B = "\x1b[1m";
const X = "\x1b[0m";

const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith("-") ? argv[0] : "summary") as string;

const has = (f: string) => argv.includes(f);
const val = (f: string, dflt?: string): string | undefined => {
	const i = argv.indexOf(f);
	return i !== -1 ? (argv[i + 1] ?? dflt) : dflt;
};
const num = (f: string, dflt: number): number => {
	const v = Number(val(f));
	return Number.isFinite(v) && v > 0 ? v : dflt;
};

const AS_JSON = has("--json");
const NAMESPACE = val("--namespace", "opencode-omp") as string;
const DIR = val("--dir") ?? stateDir(NAMESPACE);
const SERVICE = val("--service");

/** `--since 2h` / `24h` / `7d` → ISO timestamp. */
function sinceIso(): string | undefined {
	const raw = val("--since");
	if (!raw) return undefined;
	const m = raw.match(/^(\d+)([hdm])$/);
	if (!m) return raw; // assume the caller passed an ISO string
	const n = Number(m[1]);
	const ms = m[2] === "h" ? 3.6e6 : m[2] === "d" ? 8.64e7 : 6e4;
	return new Date(Date.now() - n * ms).toISOString();
}

function bytes(n: number): string {
	return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`;
}

function help(): void {
	console.log(`
${B}telemetry${X} ${D}— inspect locally collected plugin metrics${X}

${B}usage${X}
  omp-telemetry [command] [options]

${B}commands${X}
  ${C}summary${X}     counters, histograms, gauges per service ${D}(default)${X}
  ${C}verdict${X}     cost vs benefit, with a keep/reconsider recommendation
  ${C}sessions${X}    per-session record counts and time spans
  ${C}raw${X}         most recent raw records
  ${C}names${X}       every metric name seen, with counts
  ${C}watch${X}       follow new records as they arrive
  ${C}path${X}        sink file locations and sizes
  ${C}clear${X}       delete collected data ${D}(asks first)${X}

${B}options${X}
  --json                    machine-readable output
  --since <2h|7d|ISO>       only records newer than this
  --service <substr>        filter to one service
  --namespace <name>        state namespace ${D}(default: opencode-omp)${X}
  --dir <path>              read a specific directory
  --turns-per-session <n>   cost model input for verdict ${D}(default: 30)${X}
  -n <count>                rows for 'raw' ${D}(default: 20)${X}

${B}examples${X}
  omp-telemetry                        ${D}# what happened${X}
  omp-telemetry verdict                ${D}# is it worth keeping${X}
  omp-telemetry verdict --turns-per-session 60
  omp-telemetry summary --since 24h
  omp-telemetry raw -n 50 --service hashline
  omp-telemetry watch
`);
}

function requireData(recs: unknown[]): void {
	if (recs.length > 0) return;
	if (AS_JSON) {
		console.log("[]");
	} else {
		console.log(`\n${D}no telemetry in ${DIR}${X}`);
		console.log(`${D}the plugins write as they are used; try again after some work.${X}\n`);
	}
	process.exit(0);
}

function renderSummary(sums: ServiceSummary[]): void {
	for (const s of sums) {
		console.log(
			`\n${C}${s.service}${X}  ${D}${s.records} records · ${s.sessions} session(s)${X}`,
		);
		console.log(`${D}${s.from.slice(0, 19)} → ${s.to.slice(0, 19)}${X}\n`);

		if (s.gauges.size) {
			console.log(`  ${D}standing cost (per turn, paid whether used or not)${X}`);
			for (const [n, v] of [...s.gauges].sort()) {
				console.log(`    ${n.padEnd(48)} ${String(v).padStart(8)} chars`);
			}
			console.log("");
		}

		if (s.counters.size) {
			console.log(`  ${D}counters${X}`);
			for (const [name, m] of [...s.counters].sort()) {
				const total = [...m.values()].reduce((a, b) => a + b, 0);
				console.log(`    ${name.padEnd(48)} ${String(total).padStart(8)}`);
				if (m.size > 1 || [...m.keys()][0] !== "-") {
					for (const [attr, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
						console.log(`      ${D}${attr.padEnd(44)}${X} ${String(v).padStart(8)}`);
					}
				}
			}
			console.log("");
		}

		if (s.histograms.size) {
			console.log(`  ${D}histograms${X}`);
			console.log(
				`    ${"metric".padEnd(44)} ${"n".padStart(5)} ${"p50".padStart(10)} ${"p95".padStart(10)} ${"sum".padStart(10)}`,
			);
			for (const [name, h] of [...s.histograms].sort()) {
				console.log(
					`    ${name.padEnd(44)} ${String(h.n).padStart(5)} ${h.p50.toFixed(2).padStart(10)} ${h.p95.toFixed(2).padStart(10)} ${h.sum.toFixed(0).padStart(10)}`,
				);
			}
			console.log("");
		}
	}
	console.log(`${D}source: ${DIR}${X}\n`);
}

const records = cmd === "clear" || cmd === "path" || cmd === "watch" || cmd === "help"
	? []
	: load(DIR, { since: sinceIso(), service: SERVICE });

switch (cmd) {
	case "help":
	case "--help":
	case "-h":
		help();
		break;

	case "path": {
		const sinks = listSinks(DIR);
		if (AS_JSON) {
			console.log(JSON.stringify({ dir: DIR, sinks }, null, 2));
			break;
		}
		console.log(`\n${B}sinks${X}  ${D}${DIR}${X}\n`);
		if (sinks.length === 0) {
			console.log(`  ${D}(none yet)${X}\n`);
			break;
		}
		for (const s of sinks) {
			console.log(
				`  ${s.path.replace(DIR + "/", "").padEnd(44)} ${String(s.records).padStart(7)} records  ${bytes(s.bytes).padStart(8)}`,
			);
		}
		console.log("");
		break;
	}

	case "clear": {
		const sinks = listSinks(DIR);
		if (sinks.length === 0) {
			console.log(`\n${D}nothing to clear in ${DIR}${X}\n`);
			break;
		}
		const total = sinks.reduce((a, s) => a + s.records, 0);
		if (!has("--yes") && !has("-y")) {
			console.log(`\n${Y}about to delete${X} ${total} records across ${sinks.length} file(s):`);
			for (const s of sinks) console.log(`  ${s.path}`);
			console.log(`\n${D}re-run with --yes to confirm.${X}\n`);
			break;
		}
		for (const s of sinks) {
			try {
				rmSync(s.path);
			} catch {
				/* already gone */
			}
		}
		console.log(`\n${G}deleted${X} ${total} records\n`);
		break;
	}

	case "names": {
		requireData(records);
		const counts = new Map<string, number>();
		for (const r of records) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
		if (AS_JSON) {
			console.log(JSON.stringify(Object.fromEntries(counts), null, 2));
			break;
		}
		console.log(`\n${B}metric names${X}  ${D}${counts.size} distinct${X}\n`);
		for (const [n, c] of [...counts].sort()) {
			console.log(`  ${n.padEnd(52)} ${String(c).padStart(6)}`);
		}
		console.log("");
		break;
	}

	case "raw": {
		requireData(records);
		const n = num("-n", 20);
		const rows = records.slice(-n);
		if (AS_JSON) {
			console.log(JSON.stringify(rows, null, 2));
			break;
		}
		console.log(`\n${B}last ${rows.length} records${X}\n`);
		for (const r of rows) {
			const attrs = Object.entries(r.attributes ?? {})
				.map(([k, v]) => `${k}=${v}`)
				.join(" ");
			console.log(
				`  ${D}${r.ts.slice(11, 19)}${X} ${r.instrument.padEnd(9)} ${r.name.padEnd(44)} ${String(Math.round(r.value)).padStart(8)}  ${D}${attrs}${X}`,
			);
		}
		console.log("");
		break;
	}

	case "sessions": {
		requireData(records);
		const rows = sessionRows(records);
		if (AS_JSON) {
			console.log(JSON.stringify(rows, null, 2));
			break;
		}
		console.log(`\n${B}sessions${X}  ${D}${rows.length}${X}\n`);
		for (const r of rows) {
			console.log(
				`  ${r.session.padEnd(18)} ${r.service.padEnd(30)} ${String(r.records).padStart(6)} rec  ${D}${r.from.slice(11, 19)}→${r.to.slice(11, 19)}${X}`,
			);
		}
		console.log("");
		break;
	}

	case "verdict": {
		requireData(records);
		const tok = await loadTokeniser();
		const sums = summarise(records);
		const vs = verdict(sums, tok, { turnsPerSession: num("--turns-per-session", 30) });
		if (AS_JSON) {
			console.log(JSON.stringify(vs, null, 2));
			break;
		}
		console.log(`\n${B}is it worth keeping?${X}`);
		console.log(
			`${D}assuming ${num("--turns-per-session", 30)} turns/session · tokens ${tok.exact ? "measured" : "estimated"}${X}\n`,
		);
		for (const v of vs) {
			const col = v.confidence === "none" ? Y : v.net > 0 ? G : R;
			console.log(`${C}${v.service}${X}  ${D}${v.sessions} session(s) ≈ ${v.turns} turns${X}\n`);
			for (const [k, val_] of v.facts) console.log(`  ${k.padEnd(24)} ${val_}`);
			if (v.notes.length) {
				console.log("");
				for (const n of v.notes) console.log(`  ${D}${n}${X}`);
			}
			console.log("");
			if (v.promptTokens > 0) {
				const share = Math.round((100 * v.promptTokens) / Math.max(v.perTurnTokens, 1));
				console.log(
					`  ${D}cost is${X} ${v.perTurnTokens}/turn = ${v.promptTokens} prompt (${share}%) + ${v.toolTokens} tool def`,
				);
			}
			console.log(`  ${D}standing cost${X}  −${v.standingCostTokens} tokens ${D}(every turn, used or not)${X}`);
			console.log(`  ${D}realised gain${X}  ${v.realisedGainTokens >= 0 ? "+" : ""}${v.realisedGainTokens} tokens`);
			console.log(`  ${B}net${X}            ${col}${v.net >= 0 ? "+" : ""}${v.net} tokens${X}`);
			console.log(`  ${D}confidence${X}     ${v.confidence}`);
			console.log(`  ${col}${v.recommendation}${X}\n`);
		}
		if (!tok.exact) {
			console.log(
				`${D}token counts estimated at ${3.6} chars/token — install js-tiktoken for exact figures${X}`,
			);
		}
		console.log(`${D}source: ${DIR}${X}\n`);
		break;
	}

	case "watch": {
		const sinks = listSinks(DIR);
		console.log(`\n${B}watching${X} ${D}${DIR}${X}  ${D}(ctrl-c to stop)${X}\n`);
		const offsets = new Map<string, number>();
		for (const s of sinks) offsets.set(s.path, s.bytes);
		const drain = () => {
			for (const s of listSinks(DIR)) {
				const prev = offsets.get(s.path) ?? 0;
				if (s.bytes <= prev) {
					offsets.set(s.path, s.bytes);
					continue;
				}
				const fresh = load(DIR).filter((r) => true).slice(-5);
				offsets.set(s.path, s.bytes);
				for (const r of fresh.slice(-1)) {
					const attrs = Object.entries(r.attributes ?? {})
						.map(([k, v]) => `${k}=${v}`)
						.join(" ");
					console.log(
						`  ${D}${r.ts.slice(11, 19)}${X} ${r.instrument.padEnd(9)} ${r.name.padEnd(44)} ${String(Math.round(r.value)).padStart(7)}  ${D}${attrs}${X}`,
					);
				}
			}
		};
		try {
			fsWatch(DIR, { persistent: true }, () => drain());
		} catch {
			console.log(`  ${Y}cannot watch ${DIR} — does it exist yet?${X}\n`);
			process.exit(1);
		}
		setInterval(() => {}, 1 << 30);
		break;
	}

	case "summary":
	default: {
		if (!["summary"].includes(cmd)) {
			console.log(`\n${R}unknown command:${X} ${cmd}`);
			help();
			process.exit(1);
		}
		requireData(records);
		const sums = summarise(records);
		if (AS_JSON) {
			console.log(
				JSON.stringify(
					sums.map((s) => ({
						...s,
						counters: Object.fromEntries(
							[...s.counters].map(([k, m]) => [k, Object.fromEntries(m)]),
						),
						histograms: Object.fromEntries(s.histograms),
						gauges: Object.fromEntries(s.gauges),
					})),
					null,
					2,
				),
			);
			break;
		}
		renderSummary(sums);
		break;
	}
}
