# Spec — `opencode-omp-hashline`

- **Status**: draft
- **Upstream**: `@oh-my-pi/hashline@17.1.3` (MIT, Can Boluk)

## 1. Context

### Problem

The npm package `opencode-hashline@1.4.0` (no repository, no author, unmaintained since
2026-05-05) is broken. Its `createFileReadAfterHook` does:

```js
const content = output.output;                    // Read's RENDERED XML string
const annotated = formatFileWithHashes(content);  // annotates the wrapper, not the file
```

`output.output` is the fully-rendered Read tool output — `<path>`, `<type>`, `<content>`,
`N: line` prefixes, and a footer. Annotating it produces refs that address *display
positions*, not file lines.

Measured on the live plugin:

| Metric | Value |
|---|---|
| Refs with correct line number | **0 / 155,460 (0.0%)** |
| Hashes matching a file-content oracle | 30 / 155,460 (0.02%, coincidental) |
| Edits succeeding with as-displayed refs | **0 / 390 (0%)** |
| Edits succeeding with oracle-computed refs | 390 / 390 (100%) |
| Read output size penalty | **+37%** (4308 → 6698 chars for 205 lines) |

Net effect: a 37% token tax on every file read, in exchange for references that fail
100% of the time.

### Root cause

The upstream design is built around an **injected `Filesystem` abstraction** — the README
states its purpose is that "the same patcher works on disk, in memory, over the network,
or against any custom backend". The port replaced that injection with "whatever string
this hook happened to receive". The bug is the direct consequence of dropping that
abstraction: with a `Filesystem`, the annotator reads the *file* and the host's render
format is irrelevant.

### Approach

Depend on the upstream package; do not reimplement. Restore the original's two invariants:

1. **Anchor on file content, never on rendered output.**
2. **One 4-hex tag per file** + plain line numbers — not a hash per line.

## 2. Verified constraints

| Finding | Evidence |
|---|---|
| Upstream installs + works as a normal npm dep; stale-tag rejection fires | `tag: 2172`, `op: update`, `"hash #0000 is not from this session"` |
| `Patcher` transitively requires a 139MB native addon | `patcher.ts:41` imports `Recovery` → `@oh-my-pi/pi-natives` |
| **Native-free path exists at ~400KB** | `input` + `format` + `apply` import no natives |
| Native-free path applies SWAP + INS.POST + DEL correctly in one patch | `FEEF` → 4 edits → expected output byte-exact |
| Plugins may register tools with zod args and return attachments | `tool.d.ts` `ToolDefinition` / `ToolResult` |
| **Pre-hook Read format proven, not inferred** | Predicted 8/8 hashes exactly: `428 866 cbe f10 b50 9eb 150 9c0` |

### Exact Read output format

```
<path>{absolutePath}</path>
<type>file</type>
<content>
{N}: {line}
...
                                      ← blank line
(End of file - total {N} lines)       ← complete read
(Showing lines {A}-{B} of {N}. Use offset={C} to continue.)   ← paginated read
</content>
```

The blank line + footer are **always present**. A naive splice that assumes `</content>`
directly follows the last content line corrupts every final-line edit.

### Size decision

| Path | Size | Capability | Chosen |
|---|---|---|
| Full `Patcher` | 143 MB | 3-way-merge recovery on stale anchors | ✗ |
| `input`+`format`+`apply` | **400 KB** | parse, hash, apply; stale → reject | **✓ default** |

Rejecting a stale anchor is a safe failure. Auto-merging is a *convenience* that costs
350× the install size. Recovery may be added later as an opt-in extra.

## 3. Functional acceptance criteria

### AC-1 — Read annotation is file-anchored

```gherkin
Given a file with content C at path P
When the agent reads P
Then the output carries exactly one tag line [<relPath>#<TAG>]
And TAG equals computeFileHash(C) computed from the raw file bytes
And no per-line hash prefix is added to any line
And the added overhead is < 64 characters regardless of file length
```

### AC-2 — Line numbers are file-relative at any offset

```gherkin
Given a 500-line file
When the agent reads it at offset 200
Then the displayed line numbers are 200..204 (the true file lines)
And a patch anchored on line 200 targets file line 200
```

### AC-3 — Fresh tag applies

```gherkin
Given a read that returned tag T for path P
And P has not changed since
When the agent submits [P#T] with SWAP 2.=2:
Then line 2 is replaced and the file is written
```

### AC-4 — Stale tag is rejected before any write

```gherkin
Given a read that returned tag T for path P
And P has since been modified
When the agent submits a patch anchored on [P#T]
Then the edit is rejected with a stale-anchor error
And P is left byte-identical to its pre-edit state
```

### AC-5 — Multi-section patches are atomic

```gherkin
Given a patch touching files A and B
And A's tag is fresh but B's tag is stale
When the patch is applied
Then neither A nor B is modified
And the error names B
```

### AC-6 — Duplicate lines are addressable

```gherkin
Given a file where the line "  }" occurs 15 times
When the agent targets the occurrence at line 6
Then only line 6 changes and the other 14 are untouched
```

### AC-7 — Operation coverage

`SWAP A.=B:`, `DEL A.=B`, `INS.PRE A:`, `INS.POST A:`, `INS.HEAD:`, `INS.TAIL:` behave per
the upstream grammar. Block ops (`SWAP.BLK`, `DEL.BLK`, `INS.BLK.POST`) and file ops
(`REM`, `MV`) are **out of scope for v1** — they need tree-sitter, which lives in the
native addon.

### AC-8 — Line endings preserved

```gherkin
Given a file using CRLF
When any operation is applied
Then unmodified lines keep CRLF
And the file does not silently convert to LF
```

## 4. Non-functional

| Requirement | Target |
|---|---|
| Install size | < 1 MB (no native addon) |
| Read overhead | < 64 chars/file, independent of length |
| Edit latency | < 50 ms p95 for files ≤ 12k lines |
| Failure mode | Reject and explain; never partial-write |
| Provenance | Consume upstream; zero copied source |

## 5. Interface contract

### Config — `opencode-omp-hashline.jsonc`

```jsonc
{
  "enabled": true,
  "exclude": ["**/node_modules/**", "**/*.lock", "**/*.min.js"],
  "maxFileSize": 1048576,
  "tagFormat": "bracket",   // "bracket" -> [path#TAG]
  "injectSystemPrompt": true
}
```

### Hook — `tool.execute.after`

Fires for file-read tools. Reads the raw file from `args.filePath`, computes
`computeFileHash`, injects one tag line. Content lines are left untouched: OpenCode's
native `N: ` numbering is already what the patch language consumes.

### Tool — `hashline_patch`

```ts
{
  description: "Apply a hashline patch. Anchor every section on the [PATH#TAG] from your most recent read.",
  args: { patch: z.string() },
  execute(args, ctx): Promise<ToolResult>
}
```

Algorithm:
1. `Patch.parse(args.patch)`
2. **Preflight** — for every section: resolve path, read file, verify
   `computeFileHash(content) === section.fileHash`. Any mismatch aborts the whole patch.
3. Apply — `applyEdits(content, section.edits)` per section.
4. Write all sections.
5. Return resolved ranges and the fresh tag per file.

### System prompt injection

`experimental.chat.system.transform` appends a compact grammar reference. Sourced from
upstream's `prompt.md` semantics, trimmed to v1's op subset.

## 6. Out of scope (v1)

- Block ops (`*.BLK`) — require tree-sitter from the native addon
- File ops (`REM`, `MV`)
- 3-way-merge recovery — needs `Patcher` + 139MB
- Overriding OpenCode's built-in `edit` tool — coexist instead

## 7. Open questions

- **Deferred**: upstream `SnapshotStore` records tags per path for recovery. v1 is
  stateless — recompute the hash on edit and compare. Equivalent for staleness detection;
  only recovery is lost. Revisit if recovery is added.
