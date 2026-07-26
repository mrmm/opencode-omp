# Spec — `opencode-omp-snapcompact`

- **Status**: draft
- **Upstream**: `@oh-my-pi/snapcompact@17.1.3` (MIT, Can Boluk)

## 1. Context

### The idea

Instead of asking an LLM to summarize discarded conversation history — lossy, costs an API
call, adds latency — serialize it and **rasterize it into dense pixel-font PNG frames** that
vision-capable models read back directly. Local, deterministic, no LLM call, no API key.

Nothing in the OpenCode ecosystem does this. It is the genuinely unported capability.

### The catch that shapes this spec

Bitmap framing is **not a universal win**. A frame yields a *fixed* chars-per-token rate.
Text yields whatever the tokenizer gives. So the trade only pays when the text is denser
than the frame's fixed rate.

Measured (`js-tiktoken`, `o200k_base`):

| Content | chars/token | Anthropic | Google | OpenAI |
|---|---|---|---|---|
| JSON | 2.24 | **+39.0%** | +79.3% | +46.6% |
| Tool output | 2.36 | **+34.9%** | +77.9% | +43.1% |
| Code | 3.57 | **−17.6%** | +60.0% | −2.9% |
| Prose | 5.09 | **−56.8%** | +46.7% | −37.2% |

Anthropic's frame rate is **4.23 chars/token**. Denser content wins; sparser content
**actively costs more than sending the text**.

Compaction happens to target tool output and JSON — the dense end — which is why the
upstream design works in practice. But a port that renders unconditionally would make
prose-heavy sessions materially worse.

**Therefore: the density gate is a correctness requirement, not an optimization.**

## 2. Verified constraints

| Finding | Evidence |
|---|---|
| OpenCode `Part` union accepts image content | `types.gen.d.ts:345` — `FilePart { type:"file", mime, url }` |
| Upstream installs standalone | `@17.1.3`, 51 pkgs, 4.3s, 180MB (139MB = `pi-natives-darwin-arm64`) |
| Renders real PNGs outside omp | 1568×384px, 2-bit colormap, 9333 bytes, magic `89504e470d0a1a0a` |
| Output is legible | Frame rendered, read back visually, JSON recovered correctly |
| Height hugs content | 24 of 98 rows used → 384px not 1568px; blank rows never billed |
| Economics are conditional | Table above |
| Tools may return image attachments | `ToolResult.attachments[]` — path independent of message-transform |

### API shape (corrected during verification)

`render` is **positional and async** — `render(text, shape, size)`, not an options object.
It returns `{ data, cols, rows, chars }` where `data` is **already base64**.

### Provider shapes

| Provider | Shape | frameSize | cell | capacity | frameTokens | chars/token |
|---|---|---|---|---|---|---|
| anthropic | `11on16-bw` | 1568 | 11×16 | 13,916 | 3,293 | 4.23 |
| google | `8on22-bw` | 1568 | 8×22 | 13,916 | 1,120 | **12.43** |
| openai | `8on22-bw` | 1568 | 8×22 | 13,916 | 2,882 | 4.83 |

Upstream chose these by SQuAD recall evals against real billing (f1 .806 anthropic,
.934 google vs alternatives). Do not second-guess the geometry.

Image budgets: anthropic 90, google 200, openai 200, unknown 5.

## 3. Functional acceptance criteria

### AC-1 — Density gate blocks unprofitable renders

```gherkin
Given text T and a target model M
When density(T) = chars(T) / tokens(T)
And imageRate(M) = capacity(shape(M)) / frameTokens(shape(M))
Then rendering proceeds only if density(T) < imageRate(M) * (1 - margin)
And otherwise the text is returned unchanged with reason "not-dense-enough"
```

### AC-2 — Gate uses a real tokenizer

```gherkin
Given any input text
When density is computed
Then token count comes from a BPE tokenizer, never a chars/4 heuristic
```

Rationale: the 4-chars/token approximation mislabels JSON (2.24) and prose (5.09) — the
exact two cases the gate must separate.

### AC-3 — Savings are reported, not asserted

```gherkin
When a render completes
Then the result states textTokens, imageTokens, and savingPct
And savingPct is computed from the actual frame count and shape
```

### AC-4 — Provider shape resolution

```gherkin
Given a model id routed through a gateway
When the shape is resolved
Then it matches on model id, not just wire API
And a Claude model via Vertex or OpenRouter keeps the anthropic shape
```

### AC-5 — Output is a valid attachable image

```gherkin
When a frame is produced
Then it is a valid PNG (magic 89504e470d0a1a0a)
And it is exposed as { type:"file", mime:"image/png", url:"data:image/png;base64,..." }
```

### AC-6 — Frame budget respected

```gherkin
Given text requiring more frames than the provider budget
When rendering
Then frames are capped at the budget
And the overflow is reported
```

### AC-7 — Non-vision models refuse

```gherkin
Given a model without vision capability
When compaction is attempted
Then the operation declines with reason "model-not-vision-capable"
And no frames are produced
```

## 4. Non-functional

| Requirement | Target |
|---|---|
| Render latency | < 200 ms per frame |
| Determinism | Same input + shape → byte-identical PNG |
| API cost | Zero — no LLM call in the compaction path |
| Native dep | Required (rasterization); documented, not hidden |
| Default posture | **Off.** Opt-in per project. |

## 5. Interface contract

### Config — `opencode-omp-snapcompact.jsonc`

```jsonc
{
  "enabled": false,           // opt-in: economics are conditional
  "mode": "tool",             // "tool" (verified) | "auto-compact" (experimental)
  "densityMargin": 0.10,      // require 10% headroom over break-even
  "minChars": 2000,           // below this, framing isn't worth a round trip
  "maxFrames": null,          // null -> provider budget
  "shapeOverride": null       // null -> resolveShape(model)
}
```

### Tool — `snapcompact_render` (primary, verified)

```ts
{
  description: "Compress dense text into bitmap frames a vision model can read back. Declines when text is too token-sparse to profit.",
  args: {
    text: z.string().optional(),
    paths: z.array(z.string()).optional(),
    force: z.boolean().optional()   // bypass density gate, still reports the loss
  },
  execute(args, ctx): Promise<ToolResult>   // -> attachments: ToolAttachment[]
}
```

### Hook — `experimental.chat.messages.transform` (secondary, unverified at runtime)

Auto-compaction of discarded history. **Whether this hook fires and permits part
mutation at runtime — is unverified.** Therefore:

- ships behind `mode: "auto-compact"`
- defaults off
- the tool path must remain fully functional without it

### Public API

```ts
export function density(text: string): { chars: number; tokens: number; ratio: number };
export function shouldCompact(text: string, model: ModelRef, cfg?: Config): Decision;
export function renderFrames(text: string, model: ModelRef): Promise<Frame[]>;
export function toAttachments(frames: Frame[]): ToolAttachment[];
```

## 6. Risks

| Risk | Mitigation |
|---|---|
| Renders unprofitable content | Density gate (AC-1), enforced by default |
| 139MB native dep surprises users | Separate package; documented in README |
| Hook never fires | Tool path is primary and independently verified |
| Vision model misreads frames | Upstream geometry is eval-tuned; do not alter |
| Provider changes image billing | Shape table is data, not logic — updatable |

## 7. Out of scope (v1)

- Custom fonts / shapes beyond upstream's table
- Full conversation-history serialization (upstream `serializeConversation`) — v1 takes
  caller-supplied text
- Non-vision fallback summarization
