/**
 * Frame rendering over upstream `@oh-my-pi/snapcompact`.
 *
 * API shape corrected during verification: `render` is POSITIONAL and async —
 * `render(text, shape, size)`, not an options object — and returns `{ data, cols,
 * rows, chars }` where `data` is ALREADY base64. Double-encoding it yields
 * `6956424f` ("iVBO") instead of the PNG magic `89504e470d0a1a0a`.
 *
 * Verified output: 1568x384px, 2-bit colormap, 9333 bytes, visually legible —
 * JSON was read back out of a rendered frame during the verification phase.
 */
import {
	SHAPES,
	frames as countFrames,
	geometry,
	providerImageBudget,
	render,
	resolveShape,
} from "@oh-my-pi/snapcompact";

import { frameEconomics, type FrameEconomics } from "./density.ts";

export interface ModelRef {
	api?: string;
	id?: string;
}

export interface Frame {
	/** base64 PNG payload (already encoded upstream). */
	data: string;
	cols: number;
	rows: number;
	/** Characters actually rendered into this frame. */
	chars: number;
	index: number;
}

export interface ToolAttachment {
	type: "file";
	mime: string;
	url: string;
	filename?: string;
}

const PNG_MAGIC = "89504e470d0a1a0a";

/** Resolve the eval-tuned shape for a model. Matches on id, not just wire API (AC-4). */
export function shapeFor(model?: ModelRef): unknown {
	try {
		if (model && (model.api || model.id)) {
			return resolveShape(model as never);
		}
	} catch {
		/* fall through to default */
	}
	return SHAPES.anthropic;
}

/** Frame economics for a model — capacity and token cost feeding the density gate. */
export function economicsFor(model?: ModelRef): FrameEconomics {
	const shape = shapeFor(model) as { frameTokenEstimate: number };
	const geo = geometry(shape as never) as { capacity: number };
	return frameEconomics(geo.capacity, shape.frameTokenEstimate);
}

/** Provider frame budget (anthropic 90, google 200, openai 200, unknown 5). */
export function budgetFor(model?: ModelRef): number {
	try {
		return providerImageBudget(model?.api);
	} catch {
		return 5;
	}
}

/** Frame count without rendering. */
export function frameCount(text: string, model?: ModelRef): number {
	const shape = shapeFor(model);
	try {
		return countFrames(text, { shape } as never);
	} catch {
		const geo = geometry(shape as never) as { capacity: number };
		return Math.max(1, Math.ceil(text.length / geo.capacity));
	}
}

/** Split text into per-frame pages by character capacity. */
function paginate(text: string, capacity: number, maxFrames: number): string[] {
	const pages: string[] = [];
	for (let i = 0; i < text.length && pages.length < maxFrames; i += capacity) {
		pages.push(text.slice(i, i + capacity));
	}
	return pages;
}

/** Render text into PNG frames. Verifies PNG magic on every frame (AC-5). */
export async function renderFrames(
	text: string,
	model?: ModelRef,
	maxFrames?: number | null,
): Promise<Frame[]> {
	const shape = shapeFor(model) as { frameSize: number };
	const geo = geometry(shape as never) as { capacity: number };
	const cap = maxFrames ?? budgetFor(model);
	const pages = paginate(text, geo.capacity, cap);

	const out: Frame[] = [];
	for (let i = 0; i < pages.length; i++) {
		const page = pages[i] ?? "";
		const frame = (await render(page, shape as never, shape.frameSize)) as {
			data: string;
			cols: number;
			rows: number;
			chars: number;
		};

		const magic = Buffer.from(String(frame.data), "base64")
			.subarray(0, 8)
			.toString("hex");
		if (magic !== PNG_MAGIC) {
			throw new Error(
				`Frame ${i} is not a valid PNG (magic ${magic}, expected ${PNG_MAGIC}).`,
			);
		}

		out.push({
			data: String(frame.data),
			cols: frame.cols,
			rows: frame.rows,
			chars: frame.chars,
			index: i,
		});
	}
	return out;
}

/** Convert frames into OpenCode tool attachments (verified path). */
export function toAttachments(frames: Frame[]): ToolAttachment[] {
	return frames.map((f) => ({
		type: "file" as const,
		mime: "image/png",
		url: `data:image/png;base64,${f.data}`,
		filename: `snapcompact-frame-${String(f.index + 1).padStart(2, "0")}.png`,
	}));
}

/** Decoded byte size of a frame, for reporting. */
export function frameBytes(frame: Frame): number {
	return Buffer.from(frame.data, "base64").length;
}

export { SHAPES, geometry, resolveShape };
