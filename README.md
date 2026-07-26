# opencode-omp

OpenCode plugins backed by [oh-my-pi](https://github.com/can1357/oh-my-pi).

Two independently installable packages. Both **depend on the upstream libraries**
rather than reimplementing them.

| Package | What | Install size |
|---|---|---|
| [`@mrmm/opencode-omp-hashline`](packages/hashline) | File-hash-anchored patch editing | **~400 KB** (native-free) |
| [`@mrmm/opencode-omp-snapcompact`](packages/snapcompact) | Density-gated bitmap context compression | ~180 MB (needs the native rasterizer) |

Separate packages so hashline users never pull snapcompact's 139 MB native addon.

## Why this exists

The npm package `opencode-hashline@1.4.0` — unrelated to this repo, no repository or
author listed, unmaintained since 2026-05-05 — is broken. Its read hook does:

```js
const content = output.output;                    // Read's RENDERED XML string
const annotated = formatFileWithHashes(content);  // annotates the wrapper, not the file
```

`output.output` is the fully-rendered Read output — `<path>`, `<type>`, `<content>`,
`N: ` line prefixes, footer. Hashing it produces references that address *display
positions*, not file lines.

Measured against the live plugin:

| Metric | Result |
|---|---|
| Refs with a correct line number | **0 / 155,460 (0.0%)** |
| Edits succeeding with as-displayed refs | **0 / 390 (0%)** |
| Edits succeeding with oracle-computed refs | 390 / 390 (100%) |
| Read output size penalty | **+37%** |

So: a 37% token tax on every read, in exchange for references that never work.

**Root cause.** Upstream is built around an injected `Filesystem` abstraction — its
README states the goal is that "the same patcher works on disk, in memory, over the
network, or against any custom backend." The port replaced that injection with
"whatever string this hook happened to receive." The bug follows directly: with a
`Filesystem`, the annotator reads the *file* and the host's render format is irrelevant.

This repo restores the original invariants.

## Verification first

Nothing here was built on assumption. Every design decision traces to a measurement:

| Question | Result |
|---|---|
| Can a plugin inject images? | ✅ `Part` union includes `FilePart{type,mime,url}` |
| Does snapcompact install standalone? | ✅ 51 pkgs, 4.3 s |
| Does it render outside omp? | ✅ 1568×384 PNG, legible — text read back out |
| Is bitmap framing a token win? | ⚠️ **Conditional** — see below |
| Is hashline usable as a plain dep? | ✅ Two paths: 143 MB vs **400 KB** |
| Can plugins register tools + attachments? | ✅ `ToolResult.attachments[]` |
| Is the Read format known exactly? | ✅ **Proven** — predicted 8/8 hashes |
| Does omo conflict? | ✅ No clash |

### The finding that shaped the design

A bitmap frame yields a **fixed** chars-per-token rate. Text yields whatever the
tokenizer gives. Measured with `js-tiktoken`:

| Content | chars/token | Anthropic | Google | OpenAI |
|---|---|---|---|---|
| JSON | 2.24 | **+39.0%** | +79.3% | +46.6% |
| Tool output | 2.36 | **+34.9%** | +77.9% | +43.1% |
| Code | 3.57 | −17.6% | +60.0% | −2.9% |
| Prose | 5.09 | **−56.8%** | +46.7% | −37.2% |

Anthropic's frame rate is 4.23 chars/token. Denser text wins; sparser text costs
*more* than sending it plainly. Compaction happens to target the dense end, which is
why upstream's design works — but a port that renders unconditionally would make
prose-heavy sessions materially worse.

**The density gate is therefore a correctness requirement, not an optimization.**

## Install

Published to this repository's GitHub Packages registry. Point the scope at it once:

```sh
echo '@mrmm:registry=https://npm.pkg.github.com' >> ~/.npmrc
bun add @mrmm/opencode-omp-hashline
```


```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    "@mrmm/opencode-omp-hashline"
    // "@mrmm/opencode-omp-snapcompact"   // opt-in; see its README
  ]
}
```

If you are running the broken `opencode-hashline`, remove it — the two annotate the
same reads and will fight.

## Development

```sh
bun install
bun test
bun run typecheck
bun run check              # typecheck + test + version hygiene
```

Enable the hooks once per clone (also run automatically by `bun install`):

```sh
git config core.hooksPath .githooks
```

## Releases are automatic

Nobody picks a version. Push to `main`; CI reads the commit history, derives each
package's next version, writes the changelog, tags, and publishes.

| Commit | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:` `perf:` `revert:` | patch |
| `feat!:` or `BREAKING CHANGE:` footer | major (minor while `0.x`) |
| `docs:` `chore:` `ci:` `test:` … | none |

Which package moves is decided by **the files a commit touched**, not its scope —
paths cannot lie, scopes can. A `feat(ci):` that only edits `.github/` bumps nothing.

```sh
bun run release:derive     # what would release, and why
bun run release:preview    # + rendered changelog, writes nothing
```

Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Specs

Written before implementation, in [`.specs/`](.specs):

- [`.specs/hashline/spec.md`](.specs/hashline/spec.md)
- [`.specs/snapcompact/spec.md`](.specs/snapcompact/spec.md)

## Credit

The hashline concept, the patch language, and bitmap context compression are all
[Can Bölük](https://github.com/can1357)'s work in
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT). Background:
[The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/).

This repo is plugin glue. The interesting parts are upstream.

## License

MIT
