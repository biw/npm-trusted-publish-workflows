# npm trusted publish workflows

Reusable GitHub workflows for npm trusted publishing.

Copy this release workflow into each package repository. Its local `ci.yml`
must support `workflow_call` and test the calling workflow's commit. A maintainer's
merge into `main` is the approval to release; these workflows add no human
reviewer or release-approval gate.

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    uses: biw/npm-trusted-publish-workflows/.github/workflows/check.yml@v1

  ci:
    needs: check
    if: needs.check.outputs.should_publish == 'true'
    uses: ./.github/workflows/ci.yml

  publish:
    needs: ci
    permissions:
      contents: write
      id-token: write
    uses: biw/npm-trusted-publish-workflows/.github/workflows/publish.yml@v1
    with:
      tested-sha: ${{ github.sha }}
```

`check` reads `package.json` and skips the rest of the chain when that version is
already on npm. Registry failures stop the release; only a package-not-found
response permits a first publication.

Both reusable workflows default to Node 26 on `ubuntu-latest`. External Actions
are pinned to full commit SHAs and updated through Dependabot. For the reusable
workflow calls above, use a reviewed full commit SHA instead of `@v1` when you
need an immutable revision. `@v1` follows future releases of the shared workflows.

`publish` runs only for a push to `main` after the caller's CI job succeeds. It
checks out `tested-sha` explicitly (default: `github.sha`) and requires it to
match the calling workflow's commit and the current remote tip of `main`. It
checks again immediately before publishing, so an older queued run cannot
publish after a newer commit has reached `main` before that check. Keep the
`needs: ci` dependency: the publisher verifies commit identity, while the caller
is responsible for running CI on that commit.

Publishing is serialized per repository and uses pnpm by default. Corepack is
installed explicitly at a pinned version because Node 26 no longer bundles it.
Dependency caches are disabled for releases. npm invokes `prepublishOnly` once
as part of publishing. For packages without `prepublishOnly`, the workflow runs
an existing `prepublish` script before publishing; packages without either
script also work. The GitHub Release is created in a separate job with write
permission, and its tag targets the exact published commit.

For a non-default package manager or directory, pass inputs to `publish`:

```yaml
    with:
      package-manager: yarn
      working-directory: packages/library
```

Pass the same `working-directory` to `check` so both workflows read the same
package. `node-version` can also be overridden on both workflows.

For npm trusted publishing, configure each npm package with its **package
repository** and the **local calling workflow filename**, such as `release.yml`
from the example above. Do not enter the shared repository or its `publish.yml`.
npm authenticates the calling workflow when a reusable workflow publishes.
This is an OIDC identity setting, not a human approval step. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Your local CI workflow needs a callable trigger. Keep its `pull_request` trigger, but omit `push: main` so CI does not run twice:

```yaml
on:
  workflow_call:
  pull_request:
```

Run **Release workflows** in this repository's Actions tab with a version such as `v1.0.0` to create a GitHub Release and update its `v1` and `v1.0` tags.

Run the regression tests locally with Node 26:

```sh
node --test --test-concurrency=1 tests/*.test.mjs
```

The tests execute the workflows' shell blocks against temporary local Git
repositories, fake registry responses, and npm's offline publish dry run. They
do not publish a package or require credentials.
