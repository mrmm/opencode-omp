# Changelog — @mrmm/telemetry

All notable changes to this package are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags are `telemetry@<version>`.

## [Unreleased]

## [0.3.0] - 2026-07-26

### Added

- `omp-telemetry` CLI, so metrics can be inspected without opening a JSONL file
  or being inside a repository. Subcommands: `summary`, `verdict`, `sessions`,
  `raw`, `names`, `watch`, `path`, `clear`. All support `--json`.
- `analyse.ts` — the aggregation and verdict logic as pure functions, separated
  from rendering so the numbers are testable without parsing terminal output.
- `js-tiktoken` as an optional peer: token figures are measured when it is
  installed and estimated otherwise, with the output stating which.

### Added

- **telemetry**: omp-telemetry CLI for inspecting metrics (4516d63d)

### Added

- `omp-telemetry` CLI, so metrics can be inspected without opening a JSONL file
  or being inside a repository. Subcommands: `summary`, `verdict`, `sessions`,
  `raw`, `names`, `watch`, `path`, `clear`. All support `--json`.
- `analyse.ts` — the aggregation and verdict logic as pure functions, separated
  from rendering so the numbers are testable without parsing terminal output.
- `js-tiktoken` as an optional peer: token figures are measured when it is
  installed and estimated otherwise, with the output stating which.
## [0.2.0] - 2026-07-26

### Fixed

- The pre-push hook now runs typecheck and tests, not only the version gate. A
  typecheck failure reached `main` because the hook validated versions while
  compiling nothing.
### Added

- `gauge` instrument for point-in-time values such as standing cost, which must
  not be summed like a counter.
- Metric-contract tests pinning the names the verdict report depends on: a
  rename in a plugin would otherwise produce a wrong verdict silently rather
  than an error.

### Fixed

- **repo**: gate pushes on typecheck and tests, not just versions (2abfffc5)

### Added

- **telemetry**: metrics that answer whether a plugin is worth keeping (c9906fa5)

### Fixed

- The pre-push hook now runs typecheck and tests, not only the version gate. A
  typecheck failure reached `main` because the hook validated versions while
  compiling nothing.
### Added

- `gauge` instrument for point-in-time values such as standing cost, which must
  not be summed like a counter.
- Metric-contract tests pinning the names the verdict report depends on: a
  rename in a plugin would otherwise produce a wrong verdict silently rather
  than an error.

## [0.1.0] - 2026-07-26

### Added

- Standalone, host-agnostic telemetry, replacing two divergent per-plugin
  implementations. Nothing in it is specific to any application: callers supply
  a service name, an optional namespace for grouping, and an optional global
  config directory.
- OpenTelemetry-shaped instruments: `count`, `histogram`, `timer`, `event`.
- `file` sink — appends JSONL to `$XDG_STATE_HOME/opencode-omp/`, with rotation.

### Breaking

- **telemetry**: make the package standalone and host-agnostic (0fb3c8e1)

### Added

- **telemetry**: shared OpenTelemetry-shaped telemetry package (3db450dc)

### Added

- Standalone, host-agnostic telemetry, replacing two divergent per-plugin
  implementations. Nothing in it is specific to any application: callers supply
  a service name, an optional namespace for grouping, and an optional global
  config directory.
- OpenTelemetry-shaped instruments: `count`, `histogram`, `timer`, `event`.
- `file` sink — appends JSONL to `$XDG_STATE_HOME/opencode-omp/`, with rotation.
  Zero dependencies, no network.
- `otel` sink — emits through `@opentelemetry/api`, resolved lazily so the
  2.6 MB package is never mandatory. The host's `MeterProvider` decides the
  destination; nothing here implements transport.
- Path redaction via a stable 8-character hash, for correlating repeated access
  without recording structure.
- Shared JSONC reader and layered config resolution
  (defaults < global file < project file < inline), previously duplicated in
  each plugin.
- Enforced no-network guarantee: a test greps every shipped source for network
  primitives, and a second asserts no package declares an HTTP client.

### Notes

- Metric names follow OTel conventions (`<service>.<subject>.<verb>`) so the
  same data is meaningful in a local file or an OTLP backend.
- JSONL was chosen over a bespoke format because an OTel collector's `filelog`
  receiver can ingest it directly — a migration path to remote collection that
  requires no change here.
- Telemetry never breaks its caller: unwritable sinks, circular payloads, and a
  missing OTel SDK all degrade to no-ops, each covered by a test.

[Unreleased]: https://github.com/mrmm/opencode-omp/compare/telemetry@0.3.0...HEAD
[0.1.0]: https://github.com/mrmm/opencode-omp/releases/tag/telemetry@0.1.0
[0.2.0]: https://github.com/mrmm/opencode-omp/releases/tag/telemetry@0.2.0
[0.3.0]: https://github.com/mrmm/opencode-omp/releases/tag/telemetry@0.3.0
