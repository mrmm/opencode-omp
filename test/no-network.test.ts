/**
 * Enforce the "no network" guarantee.
 *
 * The telemetry README states that the default sink never transmits anything.
 * A promise in a README is worth nothing, so this greps the shipped source of
 * every package for network primitives. If someone later adds an HTTP call to
 * the default path, this fails.
 *
 * The OTel sink is exempt by design: it hands data to `@opentelemetry/api`,
 * whose exporter the host configures. Even there the transport lives in the
 * host's SDK, not in this repository — verified below.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG_DIR = join(ROOT, "packages");

/** Network primitives that would let code phone home. */
const NETWORK = [
	/\bfetch\s*\(/,
	/\bXMLHttpRequest\b/,
	/require\(\s*['"](node:)?https?['"]\s*\)/,
	/from\s+['"](node:)?https?['"]/,
	/require\(\s*['"](node:)?net['"]\s*\)/,
	/from\s+['"](node:)?net['"]/,
	/require\(\s*['"](node:)?dgram['"]\s*\)/,
	/from\s+['"](node:)?dgram['"]/,
	/\bWebSocket\b/,
	/navigator\.sendBeacon/,
];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "test") continue;
				walk(p);
			} else if (e.name.endsWith(".ts")) out.push(p);
		}
	};
	walk(dir);
	return out;
}

const packages = readdirSync(PKG_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.filter((n) => {
		try {
			return statSync(join(PKG_DIR, n, "src")).isDirectory();
		} catch {
			return false;
		}
	});

describe("no network code in shipped sources", () => {
	for (const pkg of packages) {
		test(`${pkg} contains no network primitives`, () => {
			const offenders: string[] = [];
			for (const file of sourceFiles(join(PKG_DIR, pkg, "src"))) {
				const src = readFileSync(file, "utf8");
				for (const re of NETWORK) {
					if (re.test(src)) {
						offenders.push(`${file.replace(ROOT, "")} matches ${re}`);
					}
				}
			}
			expect(offenders).toEqual([]);
		});
	}

	test("the otel sink delegates transport rather than implementing it", () => {
		const src = readFileSync(join(PKG_DIR, "telemetry/src/sink-otel.ts"), "utf8");
		// It may reference the API package, but must not open a connection itself.
		expect(src).toContain("@opentelemetry/api");
		for (const re of NETWORK) expect(re.test(src)).toBe(false);
	});

	test("no package declares a runtime HTTP client", () => {
		const banned = ["axios", "node-fetch", "got", "undici", "superagent", "request"];
		for (const pkg of packages) {
			const pj = JSON.parse(
				readFileSync(join(PKG_DIR, pkg, "package.json"), "utf8"),
			) as { dependencies?: Record<string, string> };
			for (const dep of Object.keys(pj.dependencies ?? {})) {
				expect(banned).not.toContain(dep);
			}
		}
	});
});

describe("telemetry defaults are local", () => {
	test("the default sink set is file-only", async () => {
		const { DEFAULT_TELEMETRY_CONFIG } = await import(
			"../packages/telemetry/src/index.ts"
		);
		expect(DEFAULT_TELEMETRY_CONFIG.sinks).toEqual(["file"]);
	});

	test("@opentelemetry/api is optional, never a hard dependency", () => {
		const pj = JSON.parse(
			readFileSync(join(PKG_DIR, "telemetry/package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
		};
		expect(pj.dependencies?.["@opentelemetry/api"]).toBeUndefined();
		expect(pj.peerDependenciesMeta?.["@opentelemetry/api"]?.optional).toBe(true);
	});
});
