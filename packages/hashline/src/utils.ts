/**
 * Public utility surface — importable without triggering OpenCode's plugin loader.
 *
 * OpenCode calls EVERY export of a plugin entry as a Plugin function, so a single
 * non-function export (an object, a string) aborts loading with
 * "Plugin export is not a function". Constants and helpers therefore live here
 * rather than in `index.ts`.
 *
 *   import { computeFileHash } from "opencode-omp-hashline/utils";
 */
export { DEFAULT_CONFIG, DEFAULT_EXCLUDE, loadConfig, resolveConfig } from "./config.ts";
export type { HashlineConfig, PromptStyle, TagPosition } from "./config.ts";

export {
	applyPatch,
	commitPatch,
	computeFileHash,
	planPatch,
	PatchParseError,
	StaleAnchorError,
} from "./patch.ts";
export type { AppliedSection, SectionPlan } from "./patch.ts";

export {
	formatTagLine,
	injectTag,
	isFileRead,
	parseReadOutput,
} from "./read-format.ts";
export type { ContentLine, ParsedRead } from "./read-format.ts";

export { HASHLINE_SYSTEM_PROMPT, HASHLINE_SYSTEM_PROMPT_BRIEF } from "./prompt.ts";
