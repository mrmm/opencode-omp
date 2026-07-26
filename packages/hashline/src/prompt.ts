/**
 * System-prompt fragment teaching the patch language.
 *
 * Semantics follow upstream's `prompt.md`, trimmed to the operation subset this
 * package supports. Block ops (`*.BLK`) and file ops (`REM`/`MV`) are excluded —
 * they need tree-sitter from the native addon and are out of scope for v1.
 */
export const HASHLINE_SYSTEM_PROMPT = `## hashline_patch — editing by content anchor

Every file you read carries a tag line: \`[relative/path#TAG]\`. \`TAG\` is a 4-hex
hash of the file's full content. Anchor edits on it — that is what makes stale
edits impossible.

### Shape

\`\`\`
[relative/path#TAG]
SWAP 12.=14:
+replacement line one
+replacement line two
\`\`\`

A header ending in \`:\` is followed by \`+\` body rows. \`DEL\` takes no body.

### Operations

- \`SWAP A.=B:\` — replace lines A through B **inclusive** with the body rows.
- \`DEL A.=B\` — delete lines A through B. No body.
- \`INS.PRE A:\` — insert body rows immediately before line A.
- \`INS.POST A:\` — insert body rows immediately after line A.
- \`INS.HEAD:\` — insert at the very start of the file.
- \`INS.TAIL:\` — insert at the very end of the file.

Single line: \`SWAP N.=N:\` or \`DEL N.=N\`.

### Body rows

Every body row is \`+TEXT\`, added verbatim with leading whitespace preserved.
A bare \`+\` adds a blank line. Never write \`-old\` or bare context lines — to keep
a line, simply leave it out of every range.

Literal lines beginning with \`-\` or \`+\` still take the prefix:
Markdown \`- item\` becomes \`+- item\`.

### Rules

1. Line numbers come from your most recent read and refer to the **original** file.
   They do not shift as hunks apply.
2. Ranges cover only lines whose content changes. Never widen over unchanged lines.
3. Body length is irrelevant to the range — replacing 1 line with 10 is still
   \`SWAP N.=N:\`.
4. Every applied patch mints a fresh \`#TAG\`. Anchor the next edit on the tag from
   the edit response or a fresh read.
5. On a stale-tag rejection: stop, re-read, rebuild the patch. Do not guess.
6. Multiple files in one patch: repeat the \`[path#TAG]\` header per section. All
   sections are verified before any file is written.
`;

/** Compact variant for tight system-prompt budgets. */
export const HASHLINE_SYSTEM_PROMPT_BRIEF = `## hashline_patch

Files you read carry \`[path#TAG]\` (4-hex content hash). Anchor edits on it.

\`\`\`
[path#TAG]
SWAP 12.=14:
+new line
\`\`\`

Ops: \`SWAP A.=B:\` (inclusive replace) · \`DEL A.=B\` (no body) · \`INS.PRE A:\` ·
\`INS.POST A:\` · \`INS.HEAD:\` · \`INS.TAIL:\`. Body rows are \`+TEXT\` (bare \`+\` = blank
line). Line numbers refer to the original file and never shift. Each edit mints a
fresh TAG — re-anchor from the response or a fresh read. Stale tag → re-read, never guess.
`;
