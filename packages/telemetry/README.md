# @mrmm/telemetry

Local-first telemetry with an optional OpenTelemetry bridge.

**Local JSONL by default. No network code. OpenTelemetry when you want it.**

Standalone and host-agnostic — it knows nothing about any particular
application. Give it a service name and it works.

## Design

Instrument once with OpenTelemetry semantics; let the *sink* decide where data
goes. Nothing here reimplements metrics collection, transport, or aggregation —
that is what OTel already does well.

| Sink | Behaviour | Cost |
| --- | --- | --- |
| `file` *(default)* | Appends JSONL to a local state directory | Zero dependencies |
| `otel` | Emits through `@opentelemetry/api` | Optional peer dependency |
| `none` | Records nothing | — |

`@opentelemetry/api` is an **optional peer dependency**, imported lazily. A
plugin that never enables the `otel` sink pays nothing for it — which matters
when the consuming package is 400 KB and the OTel API is 2.6 MB on disk.

Because of OTel's API/SDK split, selecting `otel` still sends nothing until the
host application registers a `MeterProvider`. That is deliberate: this package
instruments, the host chooses the destination (OTLP, Prometheus, console…).

## No network, enforced

The default path contains no network primitives — no `fetch`, no `node:http`,
no sockets. That is not a promise in a README; a test greps every shipped source
file and fails if one appears, and a second test asserts no package declares an
HTTP client dependency.

The `otel` sink references `@opentelemetry/api` but opens no connection itself.
Transport lives entirely in the host's SDK.

## Usage

```ts
import { createTelemetry } from "@mrmm/telemetry";

const tel = createTelemetry({
  service: "my-tool",
  serviceVersion: "1.0.0",
  namespace: "my-suite",        // optional: group related services
  config: { sinks: ["file"] },
});

tel.count("my_tool.request.handled", 1, { route: "/api" });
tel.histogram("my_tool.payload_bytes", 4096, { route: "/api" });

const stop = tel.timer("my_tool.request.duration_ms");
stop({ result: "ok" });

tel.event("my_tool.cache.evicted", { key: "abc", reason: "ttl" });
```

### Instruments

| Method | OTel equivalent | Use for |
| --- | --- | --- |
| `count(name, v, attrs)` | Counter | How often something happened |
| `histogram(name, v, attrs)` | Histogram | Durations, sizes, ratios |
| `timer(name, attrs)` | Histogram | Elapsed milliseconds |
| `event(name, payload, attrs)` | Counter + payload | Detail a scalar cannot carry |

Event payloads reach the `file` sink only — they have no OTel metric equivalent.

## Configuration

```jsonc
{
  "telemetry": {
    "enabled": true,
    "sinks": ["file"],     // "file" | "otel" | "none", or an array
    "file": null,          // null → $XDG_STATE_HOME/opencode-omp/<service>.jsonl
    "maxBytes": 5000000,   // rotate past this size
    "redactPaths": false,  // hash path-like attributes
    "flushEvery": 25,
    "debug": false
  }
}
```

Shorthands: `"telemetry": false` disables it; `"sinks": "otel"` accepts a bare
string.

Unknown keys and out-of-range values are dropped rather than applied, so a
malformed config degrades to defaults instead of breaking the plugin.

### Privacy

Records carry metric names, numeric values, and small attributes such as file
extension. Paths appear only where a plugin passes one; set `redactPaths: true`
to replace them with a stable 8-character hash — enough to correlate repeat
access without recording structure.

Everything stays on disk under `$XDG_STATE_HOME/<namespace>/`. Delete the
directory to erase it; set `"enabled": false` to stop collecting.

## Reading the data

Records are plain JSONL — one object per line — so `jq` is often enough:

```sh
jq -r 'select(.instrument=="counter") | .name' ~/.local/state/<namespace>/*.jsonl | sort | uniq -c
```

This repository also ships a summariser:

```sh
bun scripts/telemetry-report.ts          # counters + percentiles
bun scripts/telemetry-report.ts --json
```

JSONL is deliberate: greppable, streamable, and directly ingestible by an OTel
collector's `filelog` receiver — the migration path to a remote backend without
changing any code here.

## Failure behaviour

Telemetry must never break its caller. Every public method swallows its own
errors: an unwritable sink, a circular payload, or a missing OTel SDK all
degrade to a no-op. Tests cover each case.

## License

MIT
