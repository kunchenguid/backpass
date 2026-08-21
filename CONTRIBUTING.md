# Contributing

Thanks for wanting to contribute.

## Workflow

1. Fork the repo and create a branch.
2. Make your changes and run `pnpm run check` until it is green.
3. Push your branch and open a pull request against `main`.

CI runs lint, format:check, typecheck, and the test suite on every PR; a guard also
rejects hand-edits to release-please-generated files.

## Repo Conventions

- Node 22.5+, ESM-only JavaScript with zero runtime dependencies, and TypeScript `checkJs` validation.
- Run `pnpm run check` before pushing.
- Every transcript adapter under `src/discovery/adapters/` is pinned by a golden fixture in `test/fixtures/`; change the adapter and its fixture together, and keep adapters fail-soft.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- Releases are cut by the maintainer merging a release-please release PR; see [RELEASING.md](RELEASING.md).

## Questions

Open an issue.
