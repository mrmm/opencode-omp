/**
 * Public utility surface — importable without triggering OpenCode's plugin loader.
 *
 * OpenCode calls EVERY export of a plugin entry as a Plugin function, so a single
 * non-function export aborts loading with "Plugin export is not a function".
 * Constants and helpers therefore live here rather than in `index.ts`.
 *
 *   import { density, shouldCompact } from "opencode-omp-snapcompact/utils";
 */
export { DEFAULT_CONFIG, loadConfig, resolveConfig, sanitize } from "./config.ts";
export type { SnapcompactConfig, SnapcompactMode } from "./config.ts";

export {
	approximateDensity,
	density,
	frameEconomics,
	shouldCompact,
} from "./density.ts";
export type {
	Decision,
	DeclineReason,
	DensityReading,
	FrameEconomics,
	GateOptions,
} from "./density.ts";

export {
	budgetFor,
	economicsFor,
	frameBytes,
	frameCount,
	renderFrames,
	shapeFor,
	toAttachments,
} from "./render.ts";
export type { Frame, ModelRef, ToolAttachment } from "./render.ts";
