/**
 * Pure analysis over collected records.
 *
 * Separated from rendering so the numbers are testable without parsing terminal
 * output, and reusable by anything that wants them (CLI, report, a dashboard).
 *
 * Tokenisation is optional: `js-tiktoken` is used when present for exact counts,
 * otherwise a documented character-ratio estimate is applied. Keeping it
 * optional is what lets this package stay dependency-free.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TelemetryRecord } from "./types.ts";

/** Default state directory for a namespace. */
export function stateDir(namespace = "opencode-omp"): string {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(base, namespace);
}

export interface SinkFile {
	path: string;
	bytes: number;
	records: number;
}

export function listSinks(dir: string): SinkFile[] {
	if (!existsSync(dir)) return [];
	const out: SinkFile[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.includes(".jsonl")) continue;
		const p = join(dir, f);
		try {
			const bytes = statSync(p).size;
			const records = readFileSync(p, "utf8").split("\n").filter(Boolean).length;
			out.push({ path: p, bytes, records });
		} catch {
			/* unreadable file — skip */
		}
	}
	return out.sort((a, b) => b.records - a.records);
}

export interface LoadOptions {
	/** Only records at or after this ISO timestamp. */
	since?: string;
	/** Substring match on the service name. */
	service?: string;
}

export function load(dir: string, opts: LoadOptions = {}): TelemetryRecord[] {
	const out: TelemetryRecord[] = [];
	for (const { path } of listSinks(dir)) {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line) as TelemetryRecord;
				if (opts.since && r.ts < opts.since) continue;
				if (opts.service && !r.service.includes(opts.service)) continue;
				out.push(r);
			} catch {
				/* torn final line */
			}
		}
	}
	return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── tokenisation ────────────────────────────────────────────────────────────

/**
 * Characters per token when no tokenizer is available.
 *
 * 3.6 rather than the customary 4: measured against real payloads in this
 * project, where code and JSON tokenise denser than prose. Still an estimate,
 * and labelled as one wherever it is used.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.6;

export interface Tokeniser {
	count(text: string): number;
	fromChars(chars: number): number;
	exact: boolean;
}

export async function loadTokeniser(): Promise<Tokeniser> {
	try {
		const mod = (await import(/* @vite-ignore */ "js-tiktoken")) as {
			getEncoding(name: string): { encode(s: string): unknown[] };
		};
		const enc = mod.getEncoding("o200k_base");
		return {
			count: (t) => enc.encode(t).length,
			// Chars are all we have for recorded sizes; scale by a measured ratio.
			fromChars: (c) => Math.round(c / FALLBACK_CHARS_PER_TOKEN),
			exact: true,
		};
	} catch {
		return {
			count: (t) => Math.round(t.length / FALLBACK_CHARS_PER_TOKEN),
			fromChars: (c) => Math.round(c / FALLBACK_CHARS_PER_TOKEN),
			exact: false,
		};
	}
}

// ── aggregation ─────────────────────────────────────────────────────────────

export interface HistStats {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
	sum: number;
}

export function histStats(values: number[]): HistStats {
	if (values.length === 0) {
		return { n: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0, sum: 0 };
	}
	const s = [...values].sort((a, b) => a - b);
	const at = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		n: values.length,
		min: s[0] ?? 0,
		p50: at(50),
		p95: at(95),
		max: s[s.length - 1] ?? 0,
		mean: sum / values.length,
		sum,
	};
}

export interface ServiceSummary {
	service: string;
	records: number;
	sessions: number;
	from: string;
	to: string;
	counters: Map<string, Map<string, number>>;
	histograms: Map<string, HistStats>;
	gauges: Map<string, number>;
}

export function summarise(records: TelemetryRecord[]): ServiceSummary[] {
	const byService = new Map<string, TelemetryRecord[]>();
	for (const r of records) {
		if (!byService.has(r.service)) byService.set(r.service, []);
		byService.get(r.service)?.push(r);
	}

	const out: ServiceSummary[] = [];
	for (const [service, rs] of byService) {
		const counters = new Map<string, Map<string, number>>();
		const hists = new Map<string, number[]>();
		const gauges = new Map<string, number>();

		for (const r of rs) {
			if (r.instrument === "histogram") {
				if (!hists.has(r.name)) hists.set(r.name, []);
				hists.get(r.name)?.push(r.value);
			} else if (r.instrument === "gauge") {
				// Last value wins: a gauge is a level, not an accumulation.
				gauges.set(r.name, r.value);
			} else {
				const key =
					Object.entries(r.attributes ?? {})
						.filter(([k]) => k !== "session")
						.map(([k, v]) => `${k}=${v}`)
						.sort()
						.join(" ") || "-";
				if (!counters.has(r.name)) counters.set(r.name, new Map());
				const m = counters.get(r.name)!;
				m.set(key, (m.get(key) ?? 0) + r.value);
			}
		}

		out.push({
			service,
			records: rs.length,
			sessions: new Set(rs.map((r) => r.session)).size,
			from: rs[0]?.ts ?? "",
			to: rs[rs.length - 1]?.ts ?? "",
			counters,
			histograms: new Map([...hists].map(([k, v]) => [k, histStats(v)])),
			gauges,
		});
	}
	return out;
}

/** Total of a counter across all attribute combinations. */
export function counterTotal(s: ServiceSummary, name: string): number {
	const m = s.counters.get(name);
	return m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
}

/** Counter total restricted to one attribute value. */
export function counterWhere(
	s: ServiceSummary,
	name: string,
	key: string,
	value: unknown,
): number {
	const m = s.counters.get(name);
	if (!m) return 0;
	let total = 0;
	for (const [attrs, v] of m) {
		if (attrs.split(" ").includes(`${key}=${value}`)) total += v;
	}
	return total;
}

// ── verdict ─────────────────────────────────────────────────────────────────

export type Confidence = "none" | "low" | "moderate" | "good";

export interface Verdict {
	service: string;
	sessions: number;
	turns: number;
	perTurnTokens: number;
	promptTokens: number;
	toolTokens: number;
	standingCostTokens: number;
	realisedGainTokens: number;
	net: number;
	confidence: Confidence;
	recommendation: string;
	facts: Array<[string, string]>;
	notes: string[];
}

export interface VerdictOptions {
	turnsPerSession?: number;
}

export function verdict(
	summaries: ServiceSummary[],
	tok: Tokeniser,
	opts: VerdictOptions = {},
): Verdict[] {
	const turnsPerSession = opts.turnsPerSession ?? 30;

	return summaries.map((s) => {
		const turns = s.sessions * turnsPerSession;
		const facts: Array<[string, string]> = [];
		const notes: string[] = [];

		const promptChars = s.gauges.get("hashline.standing_cost.system_prompt_chars") ?? 0;
		const toolChars =
			s.gauges.get("hashline.standing_cost.tool_def_chars") ??
			s.gauges.get("snapcompact.standing_cost.tool_def_chars") ??
			0;
		const totalChars =
			s.gauges.get("hashline.standing_cost.total_chars") ??
			s.gauges.get("snapcompact.standing_cost.total_chars") ??
			promptChars + toolChars;

		const promptTokens = tok.fromChars(promptChars);
		const toolTokens = tok.fromChars(toolChars);
		const perTurnTokens = tok.fromChars(totalChars);
		const standingCostTokens = perTurnTokens * turns;

		let realisedGainTokens = 0;
		let signal = 0;

		if (s.service.includes("hashline")) {
			const tagged = counterTotal(s, "hashline.read.tagged");
			const attempted = counterTotal(s, "hashline.patch.attempted");
			const applied = counterTotal(s, "hashline.patch.applied");
			const stale = counterTotal(s, "hashline.patch.stale_anchor");
			const overhead = s.histograms.get("hashline.read.overhead_chars")?.sum ?? 0;
			const perLine = s.histograms.get("hashline.read.per_line_would_cost")?.sum ?? 0;
			const retry = s.histograms.get("hashline.patch.retry_chars_avoided")?.sum ?? 0;
			const unique = counterWhere(s, "hashline.patch.target", "unique", true);
			const dup = counterWhere(s, "hashline.patch.target", "unique", false);

			const overheadTokens = tok.fromChars(overhead);
			const retryTokens = tok.fromChars(retry);
			realisedGainTokens = retryTokens - overheadTokens;
			signal = attempted + tagged;

			facts.push(["reads tagged", String(tagged)]);
			facts.push(["tag overhead", `${overhead} chars ≈ ${overheadTokens} tokens (a real cost)`]);
			facts.push(["vs per-line hashing", `${perLine} chars avoided — only against that design`]);
			facts.push(["patches attempted", String(attempted)]);
			facts.push(["patches applied", String(applied)]);
			facts.push([
				"stale anchors caught",
				stale ? `${stale} → ${retryTokens} tokens of corrective cycles averted` : "0",
			]);

			if (unique + dup === 0) {
				notes.push("no edit targets recorded — cannot yet tell if the built-in edit would suffice");
			} else {
				const pct = (100 * dup) / (unique + dup);
				notes.push(
					`targets whose content was NOT unique: ${dup}/${unique + dup} (${pct.toFixed(0)}%)`,
				);
				notes.push(`those are edits the built-in exact-string tool would refuse`);
				notes.push(`the other ${unique} would have worked without this plugin`);
			}
		}

		if (s.service.includes("snapcompact")) {
			const rendered = counterTotal(s, "snapcompact.render.invoked");
			const estimated = counterTotal(s, "snapcompact.estimate.invoked");
			const compacted = counterTotal(s, "snapcompact.gate.compacted");
			const declined = counterTotal(s, "snapcompact.gate.declined");
			const net = s.histograms.get("snapcompact.net_tokens_saved")?.sum ?? 0;
			const density = s.histograms.get("snapcompact.density.chars_per_token");

			realisedGainTokens = net;
			signal = rendered + estimated;

			facts.push(["render invoked", String(rendered)]);
			facts.push(["estimate invoked", String(estimated)]);
			facts.push(["gate compacted", String(compacted)]);
			facts.push(["gate declined", String(declined)]);
			facts.push(["net tokens saved", `${net >= 0 ? "+" : ""}${net}`]);

			if (density && density.n > 0) {
				notes.push(
					`observed density p50 ${density.p50.toFixed(2)} chars/token over ${density.n} sample(s)`,
				);
				notes.push(`framing pays below ~4.23 chars/token on Anthropic`);
			}
			if (rendered === 0) {
				notes.push("never actually rendered — currently pure standing cost");
			}
		}

		const confidence: Confidence =
			s.sessions < 2 || signal < 5
				? "none"
				: signal < 25
					? "low"
					: signal < 100
						? "moderate"
						: "good";

		const net = realisedGainTokens - standingCostTokens;
		const recommendation =
			confidence === "none"
				? "INSUFFICIENT DATA — keep it enabled and revisit; do not decide on this"
				: net > 0
					? "KEEP — measured gain exceeds standing cost"
					: confidence === "low"
						? "UNPROVEN — negative so far, but the sample is too small to act on"
						: "RECONSIDER — standing cost exceeds measured gain at this usage rate";

		return {
			service: s.service,
			sessions: s.sessions,
			turns,
			perTurnTokens,
			promptTokens,
			toolTokens,
			standingCostTokens,
			realisedGainTokens,
			net,
			confidence,
			recommendation,
			facts,
			notes,
		};
	});
}

/** Per-session breakdown, for spotting a session that behaved unusually. */
export interface SessionRow {
	session: string;
	service: string;
	records: number;
	from: string;
	to: string;
}

export function sessions(records: TelemetryRecord[]): SessionRow[] {
	const map = new Map<string, TelemetryRecord[]>();
	for (const r of records) {
		const k = `${r.service}\u0000${r.session}`;
		if (!map.has(k)) map.set(k, []);
		map.get(k)?.push(r);
	}
	return [...map.entries()].map(([k, rs]) => {
		const [service = "", session = ""] = k.split("\u0000");
		return {
			session,
			service,
			records: rs.length,
			from: rs[0]?.ts ?? "",
			to: rs[rs.length - 1]?.ts ?? "",
		};
	});
}
