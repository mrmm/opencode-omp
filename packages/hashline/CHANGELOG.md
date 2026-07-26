# Changelog — opencode-omp-hashline

All notable changes to this package are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags are `opencode-omp-hashline@<version>`.

## [Unreleased]

### Changed

- **`promptStyle` now defaults to `brief`.** The full grammar text cost ~476
  tokens on every turn against ~154 for brief, and accounted for 85% of this
  plugin's standing cost. A live session confirmed the model still drives the
  tool correctly from the brief version, including a multi-hunk patch, so the
  extra ~322 tokens/turn bought nothing measurable. Set `"promptStyle": "full"`
  to restore the long form.

### Added

- Decision metrics, so the plugin can be judged rather than assumed:
  standing cost split into system prompt versus tool definition; per-target
  uniqueness (whether the built-in exact-string edit would have worked anyway);
  corrective-cycle cost averted by each stale-anchor catch; patch attempt count.

### Fixed

- The package version is read from `package.json` instead of a duplicated
  literal. The copy had already drifted to 0.2.0 against a released 0.3.0,
  behind a comment claiming release tooling kept it current — nothing did.

## [0.3.0] - 2026-07-26

### Breaking

- **telemetry**: make the package standalone and host-agnostic (0fb3c8e1)

### Added

- **telemetry**: shared OpenTelemetry-shaped telemetry package (3db450dc)

## [0.2.0] - 2026-07-26

### Breaking

- **repo**: scope packages to @mrmm and publish from CI (8a6cbc97)

### Documentation

- **repo**: remove private process metadata from a public repo (32b283f8)

## [0.1.1] - 2026-07-26

### Fixed

- **Plugin failed to load in a live OpenCode session** with `Plugin export is not a
  function`. OpenCode's loader calls every export of a plugin entry as a Plugin
  factory, so the constant exports (`DEFAULT_CONFIG`, `HASHLINE_SYSTEM_PROMPT`)
  aborted loading. Entry now exports only Plugin-compatible values; helpers moved to
  `opencode-omp-hashline/utils`. Guarded by a test asserting every entry export is a
  function.

### Added

- Inline configuration through opencode.jsonc's array form, so behaviour is tunable
  without editing plugin source:
  `["opencode-omp-hashline", { "debug": true, "promptStyle": "brief" }]`
- New options: `annotateReads`, `registerTool`, `toolName`, `includeOnly`,
  `maxLines`, `promptStyle` (full|brief|none), `tagPosition`
  (after-type|before-content|top).
- Config precedence: defaults < global file < project file < inline options.
- `./utils` subpath export.

### Fixed

- plugin entry must export only functions; add inline config (f902915b)

## [0.1.0] - 2026-07-26

Initial release.

### Added

- Read hook that injects one `[path#TAG]` line per file, where `TAG` is a 4-hex
  hash computed from the **raw file bytes** — never from the rendered tool output.
- `hashline_patch` tool supporting `SWAP A.=B:`, `DEL A.=B`, `INS.PRE A:`,
  `INS.POST A:`, `INS.HEAD:`, `INS.TAIL:` with `+TEXT` body rows.
- Multi-section preflight: every section is hash-verified before any file is
  written, so a single stale tag aborts the whole batch.
- Best-effort rollback when a write fails mid-batch.
- Path sandboxing — sections resolving outside the project directory are refused.
- System-prompt injection describing the patch language.
- JSONC configuration via `opencode-omp-hashline.jsonc` (project overrides global).
- Fail-safe annotation: an unrecognised Read shape passes through untouched rather
  than being corrupted.

### Fixed

Addresses the defects measured in npm `opencode-hashline@1.4.0` (unrelated package,
unmaintained since 2026-05-05):

- **Refs addressed display positions, not file lines.** That package annotated
  `output.output` — the already-rendered Read XML — so every reference was offset by
  the wrapper. Measured 0 / 155,460 refs with a correct line number.
- **Edits with as-displayed refs failed 100% of the time** (0 / 390). Oracle-computed
  refs succeeded 390 / 390, confirming the applier was fine and the annotator was not.
- **Reads grew 37%** from per-line hash prefixes. One file tag costs under 64
  characters regardless of file length.
- **Trailing footer corruption.** The real Read format ends with a blank line plus
  `(End of file - total N lines)` (or the paginated variant) before `</content>`. A
  splice assuming `</content>` follows the last content row damages final-line edits.

### Notes

- Uses the native-free upstream path (`input` + `format` + `apply`). The full
  `Patcher` transitively requires `@oh-my-pi/pi-natives` — 139 MB for a single
  `diffLineRuns` call — so stale anchors are rejected rather than 3-way merged.
  Install size stays ~400 KB.
- Block ops (`SWAP.BLK`, `DEL.BLK`, `INS.BLK.POST`) and file ops (`REM`, `MV`) are
  out of scope for v1; they require tree-sitter from the native addon.

[Unreleased]: https://github.com/mrmm/opencode-omp/compare/opencode-omp-hashline@0.3.0...HEAD
[0.1.0]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-hashline@0.1.0
[0.1.1]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-hashline@0.1.1
[0.2.0]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-hashline@0.2.0
[0.3.0]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-hashline@0.3.0
