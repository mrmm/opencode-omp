/**
 * Density gate — the correctness core of this package.
 *
 * A bitmap frame yields a FIXED chars-per-token rate. Text yields whatever the
 * tokenizer gives. The trade only pays when the text is denser than the frame.
 *
 * Measured during verification (js-tiktoken, o200k_base) against real shapes:
 *
 *   content      chars/token   anthropic   google   openai
 *   JSON              2.24       +39.0%    +79.3%   +46.6%
 *   tool output       2.36       +34.9%    +77.9%   +43.1%
 *   code              3.57       -17.6%    +60.0%    -2.9%
 *   prose             5.09       -56.8%    +46.7%   -37.2%
 *
 * Anthropic's frame rate is 4.23 chars/token. Rendering prose at 5.09 chars/token
 * costs 57% MORE than sending the text. So this gate is not an optimization — a
 * port without it actively degrades prose-heavy sessions.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

export interface DensityReading {
	chars: number;
	tokens: number;
	/** chars per token — higher means the text is token-cheap already. */
	ratio: number;
}

export interface FrameEconomics {
	/** Characters one full frame can hold. */
	capacity: number;
	/** Token cost of one full frame. */
	frameTokens: number;
	/** capacity / frameTokens — the fixed rate a frame buys you. */
	imageRatio: number;
}

export type DeclineReason =
	| "not-dense-enough"
	| "too-short"
	| "model-not-vision-capable"
	| "disabled";

export type Decision =
	| {
			compact: true;
			density: DensityReading;
			economics: FrameEconomics;
			estimatedFrames: number;
			estimatedImageTokens: number;
			estimatedSavingPct: number;
	  }
	| {
			compact: false;
			reason: DeclineReason;
			density?: DensityReading;
			economics?: FrameEconomics;
			estimatedSavingPct?: number;
			detail: string;
	  };

let encoder: Tiktoken | null = null;

/**
 * o200k_base — the modern BPE used by GPT-4o/5. Anthropic's tokenizer is not
 * public; o200k is the closest available proxy and is far more accurate than the
 * chars/4 heuristic, which mislabels exactly the two cases this gate separates
 * (JSON at 2.24 and prose at 5.09).
 */
function getEncoder(): Tiktoken {
	if (!encoder) encoder = getEncoding("o200k_base");
	return encoder;
}

/** Measure real token density. Never a heuristic (AC-2). */
export function density(text: string): DensityReading {
	const chars = text.length;
	const tokens = getEncoder().encode(text).length;
	return { chars, tokens, ratio: tokens > 0 ? chars / tokens : 0 };
}

/** Cheap approximation for pre-filtering only — never for the gate itself. */
export function approximateDensity(text: string): DensityReading {
	const chars = text.length;
	const tokens = Math.max(1, Math.ceil(chars / 4));
	return { chars, tokens, ratio: chars / tokens };
}

export function frameEconomics(capacity: number, frameTokens: number): FrameEconomics {
	return {
		capacity,
		frameTokens,
		imageRatio: frameTokens > 0 ? capacity / frameTokens : 0,
	};
}

export interface GateOptions {
	/** Fractional headroom required over break-even. Default 0.10. */
	margin?: number;
	/** Below this length, a round trip isn't worth it. Default 2000. */
	minChars?: number;
	/** Cap on frames; usually the provider image budget. */
	maxFrames?: number | null;
	/** Bypass the gate but still report the (likely negative) result. */
	force?: boolean;
	/** Vision capability of the target model. */
	visionCapable?: boolean;
}

/**
 * Decide whether framing this text actually saves tokens.
 *
 * Compacts only when `density.ratio < imageRatio * (1 - margin)` (AC-1).
 */
export function shouldCompact(
	text: string,
	economics: FrameEconomics,
	opts: GateOptions = {},
): Decision {
	const {
		margin = 0.1,
		minChars = 2000,
		maxFrames = null,
		force = false,
		visionCapable = true,
	} = opts;

	if (!visionCapable) {
		return {
			compact: false,
			reason: "model-not-vision-capable",
			detail: "Target model cannot read images; bitmap framing is not applicable.",
		};
	}

	if (text.length < minChars && !force) {
		return {
			compact: false,
			reason: "too-short",
			detail: `Input is ${text.length} chars; below the ${minChars}-char floor where framing pays for itself.`,
		};
	}

	const d = density(text);
	let frames = Math.ceil(text.length / economics.capacity);
	if (maxFrames != null && frames > maxFrames) frames = maxFrames;

	const imageTokens = frames * economics.frameTokens;
	const savingPct = d.tokens > 0 ? 100 * (1 - imageTokens / d.tokens) : 0;
	const threshold = economics.imageRatio * (1 - margin);

	if (d.ratio >= threshold && !force) {
		return {
			compact: false,
			reason: "not-dense-enough",
			density: d,
			economics,
			estimatedSavingPct: savingPct,
			detail:
				`Text is ${d.ratio.toFixed(2)} chars/token; a frame yields ` +
				`${economics.imageRatio.toFixed(2)} chars/token (threshold ` +
				`${threshold.toFixed(2)} at ${(margin * 100).toFixed(0)}% margin). ` +
				`Framing would change cost by ${savingPct >= 0 ? "+" : ""}${savingPct.toFixed(1)}% — ` +
				`sending the text is cheaper.`,
		};
	}

	return {
		compact: true,
		density: d,
		economics,
		estimatedFrames: frames,
		estimatedImageTokens: imageTokens,
		estimatedSavingPct: savingPct,
	};
}
