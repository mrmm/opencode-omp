/**
 * Local JSONL sink.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ NO NETWORK CODE. Records append to a file on this machine.               │
 * │ A test greps the shipped source for network primitives, so the guarantee │
 * │ is enforced rather than promised.                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * One JSON object per line: greppable, streamable, and trivially loadable by
 * anything that reads JSONL — including an OTel collector's filelog receiver,
 * which is the migration path to a remote backend without changing this code.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Sink, TelemetryRecord } from "./types.ts";

/** XDG state dir, falling back to the conventional location. */
export function defaultSinkPath(service: string): string {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	const leaf = service.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/gi, "-");
	return join(base, "opencode-omp", `${leaf}.jsonl`);
}

export class FileSink implements Sink {
	readonly kind = "file" as const;

	constructor(
		private readonly path: string,
		private readonly maxBytes: number,
		private readonly onError?: (e: unknown) => void,
	) {}

	get filePath(): string {
		return this.path;
	}

	write(records: TelemetryRecord[]): void {
		if (records.length === 0) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			this.rotateIfNeeded();
			appendFileSync(
				this.path,
				`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
				"utf8",
			);
		} catch (e) {
			// Losing telemetry is always preferable to failing the operation
			// that produced it.
			this.onError?.(e);
		}
	}

	private rotateIfNeeded(): void {
		try {
			if (statSync(this.path).size > this.maxBytes) {
				renameSync(this.path, `${this.path}.1`);
			}
		} catch {
			/* absent or unrotatable — nothing to do */
		}
	}
}
