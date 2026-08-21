# Releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please) and
publish to npm tokenless via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(GitHub Actions OIDC, `npm publish --provenance`). No npm token is stored anywhere.

**Nothing auto-publishes.** release-please only opens a release PR on `main`; a release is
cut - and the publish step runs - solely when the maintainer merges that release PR. Merging
ordinary PRs never publishes.

## Steady state

1. Conventional commits land on `main` (via merged PRs).
2. release-please opens or updates a release PR that bumps the version, updates
   `CHANGELOG.md`, and updates `.release-please-manifest.json`.
3. The maintainer reviews and merges the release PR. That is the go decision.
4. `.github/workflows/release-please.yml` tags the release, re-runs lint, format:check,
   typecheck, and tests at the tag, and runs `npm publish --access public --provenance`,
   authenticating via OIDC against the trusted publisher configured on npm.

## One-time bootstrap (before the first release)

npm only allows configuring a trusted publisher on a package that already exists, and
`backpass` has never been published. So the very first publish is manual, done once by the
maintainer:

1. **Manual first publish.** From a clean checkout of the release tag (or `main` at the
   release commit), run `npm publish --access public` as the npm user that will own the
   package.
2. **Configure the trusted publisher.** On npmjs.com, open the `backpass` package →
   Settings → Trusted Publisher → GitHub Actions, and set:
   - Organization or user: `kunchenguid`
   - Repository: `backpass`
   - Workflow filename: `release-please.yml`
3. **Done.** From then on, step 4 of the steady state publishes tokenless via OIDC with
   provenance whenever the maintainer merges a release PR. No secret to create, rotate,
   or leak.

Until the bootstrap is completed, a merged release PR will tag the release but its publish
step will fail authentication; re-run the workflow after the bootstrap, or publish that
tag manually.
