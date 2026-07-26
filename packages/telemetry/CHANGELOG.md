# Changelog — @mrmm/telemetry

All notable changes to this package are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags are `telemetry@<version>`.

## [Unreleased]

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

[Unreleased]: https://github.com/mrmm/opencode-omp/compare/main...HEAD
