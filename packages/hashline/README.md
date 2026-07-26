# opencode-omp-hashline

File-hash-anchored patch editing for OpenCode, backed by
[`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline).

**~400 KB. No native dependencies.**

## What it does

Every file you read gains one tag line:

```
<path>/abs/project/src/server.ts</path>
<type>file</type>
[src/server.ts#A3F2]        ← added
<content>
1: import express from "express";
2: const app = express();
...
```

`A3F2` is a 4-hex hash of the file's full content. Edits anchor on it:

```
[src/server.ts#A3F2]
SWAP 2.=2:
+const app = express({ strict: true });
```

If the file changed since your read, the tag won't match and the edit is rejected
before anything is written.

### Operations

| Op | Effect |
|---|---|
| `SWAP A.=B:` | Replace lines A–B **inclusive** with the body rows |
| `DEL A.=B` | Delete lines A–B (no body) |
| `INS.PRE A:` | Insert before line A |
| `INS.POST A:` | Insert after line A |
| `INS.HEAD:` | Insert at start of file |
| `INS.TAIL:` | Insert at end of file |

Body rows are `+TEXT`, added verbatim with leading whitespace preserved. A bare `+`
adds a blank line. Line numbers refer to the **original** file and never shift as
hunks apply.

## Why one tag per file, not one hash per line

OpenCode's Read already emits `N: ` line numbers — exactly the addressing the patch
language consumes. Adding a per-line hash buys nothing and costs a great deal:

| Approach | Overhead on a 200-line read |
|---|---|
| One file tag (this package) | **+16 chars** |
| Per-line hashes (`opencode-hashline`) | +2,329 chars (**+37%**) |

146× the cost for no additional capability.

## Duplicate lines

The case exact-string matching cannot handle:

```
Given "  }" appears 15 times in a file
When you target line 6
Then only line 6 changes
```

`edit`-style tools reject this as ambiguous. Anchoring by line number resolves it
directly.

## Install

```sh
bun add opencode-omp-hashline
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["opencode-omp-hashline"] }
```

Remove `opencode-hashline` if present — both annotate the same reads.

## Configuration

`opencode-omp-hashline.jsonc`, in your project root or `~/.config/opencode/`
(project wins):

```jsonc
{
  "enabled": true,
  "exclude": ["**/node_modules/**", "**/*.lock", "**/*.min.js"],
  "maxFileSize": 1048576,
  "injectSystemPrompt": true,
  "debug": false
}
```

## Guarantees

- **Preflight** — every section of a multi-file patch is verified before *any* file
  is written. A single stale tag aborts the batch.
- **Rollback** — a mid-batch write failure restores files already written.
- **Sandboxed** — paths resolving outside the project are refused.
- **Fail-safe annotation** — an unrecognised Read shape passes through untouched
  rather than being corrupted.

## Design notes

Upstream ships two paths. This package takes the light one:

| Path | Size | Capability |
|---|---|---|
| Full `Patcher` | 143 MB | 3-way-merge recovery on stale anchors |
| `input`+`format`+`apply` | **400 KB** | Parse, hash, apply; stale → reject |

`patcher.ts` imports `Recovery`, which pulls `@oh-my-pi/pi-natives` — 139 MB for one
`diffLineRuns` call. Rejecting a stale anchor is a safe failure; auto-merging is a
convenience that costs 350× the install size.

### Out of scope (v1)

Block ops (`SWAP.BLK`, `DEL.BLK`, `INS.BLK.POST`) need tree-sitter from the native
addon. File ops (`REM`, `MV`) and 3-way-merge recovery are likewise deferred.

## API

```ts
import { applyPatch, planPatch, computeFileHash } from "opencode-omp-hashline";

const tag = computeFileHash(await readFile(p, "utf8"));
const plans = await planPatch(patchText, projectRoot);   // preflight only
const applied = await applyPatch(patchText, projectRoot); // preflight + write
```

## Credit

Patch language, hashing, and applier by [Can Bölük](https://github.com/can1357) in
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT). This package is plugin glue.

## License

MIT
