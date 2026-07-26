# @mrmm/opencode-omp-snapcompact

Density-gated bitmap context compression for OpenCode, backed by
[`@oh-my-pi/snapcompact`](https://www.npmjs.com/package/@oh-my-pi/snapcompact).

> **Off by default.** The savings are conditional — see below before enabling.

## The idea

Rather than asking an LLM to summarize discarded context — lossy, costs a call, adds
latency — rasterize the text into dense pixel-font PNG frames that vision models read
back directly. Local, deterministic, **no LLM call, no API cost**.

It genuinely works. Here is a frame rendered by this package, read back by a model:

```
[0] {"id":0,"ok":true,"name":"item_0"}█[1] {"id":1,"ok":true,"name":"item_1"}█[2] ...
```

1568×384 px, 2-bit colormap, 9,333 bytes, holding 3,329 characters.

## Read this before enabling

A frame yields a **fixed** chars-per-token rate. Text yields whatever the tokenizer
gives. Measured with `js-tiktoken` (`o200k_base`):

| Content | chars/token | Anthropic | Google | OpenAI |
|---|---|---|---|---|
| JSON | 2.24 | **+39.0%** | +79.3% | +46.6% |
| Tool output | 2.36 | **+34.9%** | +77.9% | +43.1% |
| Code | 3.57 | −17.6% | +60.0% | −2.9% |
| Prose | 5.09 | **−56.8%** | +46.7% | −37.2% |

Anthropic's frame rate is **4.23 chars/token**. Denser content wins. Sparser content
costs *more* than just sending the text — framing prose is a 57% penalty.

Google is the outlier: it bills a fixed budget per image, so a frame yields 12.43
chars/token and effectively always wins.

**This package refuses to render unprofitable content by default.** That gate is the
reason it exists as a separate implementation rather than a thin passthrough.

## Install

```sh
bun add @mrmm/opencode-omp-snapcompact
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["@mrmm/opencode-omp-snapcompact"] }
```

```jsonc
// @mrmm/opencode-omp-snapcompact.jsonc
{ "enabled": true }
```

⚠️ Pulls `@oh-my-pi/pi-natives` (~139 MB) for rasterization. That is why it ships
separately from `@mrmm/opencode-omp-hashline`.

## Tools

### `snapcompact_estimate`

Dry run. Reports measured density and whether framing would pay:

```
chars        36308
tokens       16202
density      2.24 chars/token
frame rate   4.23 chars/token
capacity     13916 chars/frame @ 3293 tokens

WOULD COMPACT — projected +39.0% across 3 frame(s)
```

### `snapcompact_render`

Renders and attaches frames, or declines with a reason:

```
snapcompact: declined (not-dense-enough)

Text is 5.09 chars/token; a frame yields 4.23 chars/token (threshold 3.81 at
10% margin). Framing would change cost by -56.8% — sending the text is cheaper.
```

Args: `text`, `paths` (project-relative files), `force` (bypass the gate, still
reports the loss).

## Configuration

```jsonc
{
  "enabled": false,        // opt-in
  "mode": "tool",          // "tool" (verified) | "auto-compact" (experimental)
  "densityMargin": 0.10,   // required headroom over break-even
  "minChars": 2000,        // below this, not worth a round trip
  "maxFrames": null,       // null → provider budget (anthropic 90, google 200)
  "debug": false
}
```

## Provider shapes

Upstream tuned these by SQuAD recall evals against real billing (f1 .806 Anthropic,
.934 Google versus alternatives). The geometry is **data, not guesswork** — don't
alter it.

| Provider | Shape | Cell | Capacity | Tokens/frame | chars/token |
|---|---|---|---|---|---|
| anthropic | `11on16-bw` | 11×16 | 13,916 | 3,293 | 4.23 |
| google | `8on22-bw` | 8×22 | 13,916 | 1,120 | **12.43** |
| openai | `8on22-bw` | 8×22 | 13,916 | 2,882 | 4.83 |

Shape resolution matches on **model id**, not just wire API — a Claude routed through
Vertex or OpenRouter keeps Claude geometry.

Frame height hugs the rows actually printed, so partially filled frames never bill
blank pixel rows.

## Status

| Path | State |
|---|---|
| `mode: "tool"` | ✅ Verified end-to-end |
| `mode: "auto-compact"` | ⚠️ Experimental — depends on `experimental.chat.messages.transform` firing at runtime, which is unverified |

The tool path works standalone; auto-compaction is additive.

## API

```ts
import { density, shouldCompact, renderFrames, toAttachments, economicsFor }
  from "@mrmm/opencode-omp-snapcompact";

const econ = economicsFor({ api: "anthropic", id: "claude-opus-4-6" });
const decision = shouldCompact(text, econ);
if (decision.compact) {
  const attachments = toAttachments(await renderFrames(text, { api: "anthropic" }));
}
```

## Credit

Bitmap context compression, the shape table, and the eval methodology are
[Can Bölük](https://github.com/can1357)'s work in
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT). This package adds the density
gate and OpenCode plumbing.

## License

MIT
