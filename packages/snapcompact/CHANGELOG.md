# Changelog — opencode-omp-snapcompact

All notable changes to this package are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags are `opencode-omp-snapcompact@<version>`.

## [Unreleased]

## [0.1.1] - 2026-07-26

### Fixed

- Entry exported constants, which would abort OpenCode's plugin loader. Helpers moved
  to `opencode-omp-snapcompact/utils`; guarded by an export-contract test.

### Added

- Inline configuration through opencode.jsonc's array form.
- New options: `shapeOverride`, `registerRenderTool`, `registerEstimateTool`,
  `toolPrefix`, `allowForce`.
- Config precedence: defaults < global file < project file < inline options.
- `./utils` subpath export.

### Fixed

- plugin entry must export only functions; add inline config (f902915b)

## [0.1.0] - 2026-07-26

Initial release. **Ships disabled** — savings are conditional on content density.

### Added

- Density gate (`shouldCompact`) that refuses to render text too token-sparse to
  profit from bitmap framing. Enforced by default.
- Real BPE measurement via `js-tiktoken` (`o200k_base`). The chars/4 heuristic is
  explicitly rejected: it misclassifies exactly the two cases the gate must
  separate — JSON at 2.24 chars/token and prose at 5.09.
- `snapcompact_render` tool returning PNG frames as OpenCode tool attachments.
- `snapcompact_estimate` tool for a dry run reporting density, frame economics, and
  the projected saving without rendering.
- Per-frame PNG magic validation (`89504e470d0a1a0a`).
- Provider-aware shape resolution matching on model id, so a Claude routed through
  Vertex or OpenRouter keeps Claude geometry.
- Frame budget enforcement (anthropic 90, google 200, openai 200).
- JSONC configuration via `opencode-omp-snapcompact.jsonc`.

### Measured

Bitmap framing yields a **fixed** chars-per-token rate; text yields whatever the
tokenizer gives. Measured with `js-tiktoken` against real provider shapes:

| Content | chars/token | Anthropic | Google | OpenAI |
| --- | --- | --- | --- | --- |
| JSON | 2.24 | +39.0% | +79.3% | +46.6% |
| Tool output | 2.36 | +34.9% | +77.9% | +43.1% |
| Code | 3.57 | −17.6% | +60.0% | −2.9% |
| Prose | 5.09 | −56.8% | +46.7% | −37.2% |

Anthropic's frame rate is 4.23 chars/token. Content denser than that wins; sparser
content costs more than sending the text plainly. This is why the gate exists and
why the package defaults to disabled.

### Notes

- Corrected upstream API usage discovered during verification: `render` is
  **positional and async** — `render(text, shape, size)` — and its `data` field is
  **already base64**. Re-encoding it produces `6956424f` ("iVBO") instead of valid
  PNG magic.
- Frame height hugs the rows actually printed, so partially filled frames never bill
  blank pixel rows (verified: 1568×384 px for 24 of 98 available rows).
- `mode: "auto-compact"` is experimental and off by default. It depends on
  `experimental.chat.messages.transform` firing at runtime, which is unverified. The
  tool path is independently verified and works standalone.
- Requires `@oh-my-pi/pi-natives` (~139 MB) for rasterization. This is why the
  package ships separately from `opencode-omp-hashline`.

[Unreleased]: https://github.com/mrmm/opencode-omp/compare/opencode-omp-snapcompact@0.1.1...HEAD
[0.1.0]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-snapcompact@0.1.0
[0.1.1]: https://github.com/mrmm/opencode-omp/releases/tag/opencode-omp-snapcompact@0.1.1
