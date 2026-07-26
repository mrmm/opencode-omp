# Contributing

## Versioning

Packages version **independently**. `opencode-omp-hashline` is stable and native-free;
`opencode-omp-snapcompact` is experimental and carries a 139 MB native dependency.
Forcing them onto a shared version number would either hold the stable one back or
imply a stability the experimental one does not have.

Consequences:

- Every release targets exactly **one** package.
- Tags are **`<package>@<version>`** — e.g. `opencode-omp-hashline@0.2.0`.
- **Bare `vX.Y.Z` tags are rejected.** They are ambiguous here, and both CI and the
  pre-push hook fail on them.

[Semantic Versioning](https://semver.org/) applies per package:

| Bump | When |
| --- | --- |
| `major` | Breaking change to config, tool args, or tool output shape |
| `minor` | New capability, backwards compatible |
| `patch` | Fix, docs, or internal change with no API impact |

While a package is `0.x`, a **minor** bump signals a breaking change.

## Releasing

```sh
bun scripts/release.ts <package> <patch|minor|major|x.y.z> [--dry-run]
```

The script refuses to proceed unless:

1. the working tree is clean,
2. the target tag does not already exist,
3. the package CHANGELOG has a **non-empty** `[Unreleased]` section,
4. `bun test` passes,
5. `bun run typecheck` passes,
6. the hygiene gate passes *after* the bump.

Then it bumps `package.json`, promotes `[Unreleased]` to a dated version heading,
refreshes the changelog link refs, commits `release(<pkg>): <version>`, and creates
an annotated tag.

```sh
git push origin main --follow-tags
cd packages/<pkg> && npm publish --access public
```

Always dry-run first:

```sh
bun scripts/release.ts hashline minor --dry-run
```

## Hygiene gate

```sh
bun run check:versions          # standard
bun run check:versions:tags     # also require a tag per released version
```

Enforced:

1. Valid semver in every `package.json`.
2. A CHANGELOG entry for each package's current version.
3. An `[Unreleased]` section present.
4. Changelog versions strictly descending, no duplicates.
5. A matching `<pkg>@<version>` tag for released versions (`--tags`).
6. If HEAD is tagged, `package.json` must agree exactly.
7. Tag format is `<package>@<semver>`.
8. Workspace-internal deps point at versions that exist.

Runs in three places: locally via `bun run check`, in the pre-push hook, and in CI.

## Enabling the hook

Once per clone:

```sh
git config core.hooksPath .githooks
```

`git push --no-verify` bypasses it. Do that only when you understand what the gate
would have caught.

## Changelogs

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add to `[Unreleased]` in the
same commit as the change — the release script refuses to promote an empty section,
so an undocumented change simply cannot be released.

```markdown
## [Unreleased]

### Added
- New `foo` option for bar.

### Fixed
- Baz no longer double-encodes quux.
```

Sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run check      # typecheck + test + hygiene
```

## Upstream

Both packages wrap libraries from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, Can Bölük).

**No upstream source is vendored.** Both are consumed as published npm dependencies.
Bugs in the patch language, hashing, or rasterization belong upstream; bugs in the
OpenCode plumbing, the density gate, or the Read-format parser belong here.

When bumping an upstream dependency, verify the assumptions this repo depends on
still hold — several were discovered empirically and are not guaranteed API:

- `render(text, shape, size)` is **positional and async**, and its `data` is
  **already base64**.
- `patcher.ts` transitively pulls the native addon; `input` + `format` + `apply` do not.
- OpenCode's Read output ends with a blank line plus a footer before `</content>`.
