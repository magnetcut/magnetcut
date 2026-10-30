# Contributing to MagnetCut

Thanks for wanting to help. For anything bigger than a bug fix, open an issue first so we can
agree on the approach before you write the code.

## Setup

You need [Bun](https://bun.sh). There's no server, database or environment file.

```sh
bun install
bun dev:web   # http://localhost:3000
```

Editing `rust/wasm`? The README says how to build and link it.

## Before you open a pull request

```sh
bun test
(cd apps/web && bunx tsc --noEmit)
bun run build:web
```

CI runs the same on macOS, Windows and Linux.

## Code

- Logic that isn't UI belongs in `rust/`; `apps/` are UI shells ([AGENTS.md](../AGENTS.md)).
- Read a component before using it: it may already apply classes.
- Functions take one object parameter (`fn({ a, b })`); ESLint's `magnetcut/prefer-object-params`
  checks it.
- Match the file you're in. Some files use CRLF line endings: keep them as they are.
- No new network requests, analytics or accounts. If a feature needs a download, it happens only
  when the feature is used, and the README's Privacy section says so.

## Licence

MagnetCut is under the GNU AGPL 3.0, and your contribution will be too, with this additional
permission under its section 7, which lets MagnetCut be distributed through app stores:

> As an additional permission under section 7 of the GNU Affero General Public License, version
> 3, the copyright holders of MagnetCut give you permission to convey this program, or a work
> based on it, through an application store or distribution platform (such as Apple's App
> Store) whose terms impose restrictions beyond those of this License, provided that you also
> make the Corresponding Source of what you convey available under this License, without those
> restrictions, as section 6 describes.

By opening a pull request, you agree that your contribution is licensed on those terms.
