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

## Releasing — automatic

**You never pick a version, and you never run a release command.**

Push to `main`. CI reads the commit history, derives each package's next version,
bumps it, writes the changelog, tags, and publishes the GitHub release. A release
you have to remember to run is a ritual, not a process.

The commit message *is* the release input:

| Commit | Bump |
| --- | --- |
| `feat: …` | **minor** |
| `fix: …` · `perf: …` · `revert: …` | **patch** |
| `feat!: …` or a `BREAKING CHANGE:` footer | **major** (minor while `0.x`) |
| `docs:` `style:` `refactor:` `test:` `build:` `ci:` `chore:` | none |

Which package gets bumped is decided by **the files a commit touched**, not by its
scope. `fix(hashline):` that only edits snapcompact files releases snapcompact —
paths cannot lie, scopes can.

While a package is `0.x`, a breaking change moves the **minor**. Semver §4 says
anything may change in `0.y.z`, so burning `1.0.0` on the first breaking change
would falsely signal stability. Reaching `1.0.0` is a deliberate act, never derived.

### Previewing

```sh
bun run release:derive     # what would be released, and why
bun run release:preview    # + rendered changelog, writes nothing
```

### Changelogs

Generated from commits, so nothing that shipped can be silently omitted. Anything
you write under `[Unreleased]` is **preserved and placed above** the generated list —
use it when a commit subject cannot carry the necessary context.

### Manual override

`workflow_dispatch` on the Release workflow, with `dry_run` toggleable. Reserved for
recovering from a bad automated run.

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

## Commit messages

Enforced by the `commit-msg` hook, because versions are derived from them. A
malformed message means a release that silently does not happen, or happens at the
wrong level.

```
<type>(<scope>): <subject>
```

- **types** — `feat` `fix` `perf` `revert` `docs` `style` `refactor` `test` `build` `ci` `chore`
- **scopes** (optional) — `hashline` `snapcompact` `repo` `ci` `docs` `deps` `release`
- subject: lowercase, imperative, no trailing period, header under 100 chars

```
feat(hashline): support INS.BLK.POST
fix(snapcompact): stop double-encoding frame data
refactor!: drop the legacy tag position
```

Breaking changes take a `!` before the colon, or a `BREAKING CHANGE:` footer.

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
