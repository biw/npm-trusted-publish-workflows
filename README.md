# npm trusted publish workflows

Reusable GitHub workflows for npm trusted publishing.

Copy this release workflow into each package repository. Its local `ci.yml`
must support `workflow_call`.

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  check:
    uses: biw/npm-trusted-publish-action/.github/workflows/check.yml@v1

  ci:
    needs: check
    if: needs.check.outputs.should_publish == 'true'
    uses: ./.github/workflows/ci.yml

  publish:
    needs: ci
    permissions:
      contents: write
      id-token: write
    uses: biw/npm-trusted-publish-action/.github/workflows/publish.yml@v1
```

`check` reads `package.json` and skips the rest of the chain when that version is already on npm. `publish` serializes publishes per repository, installs with pnpm by default, runs `prepublish`, then publishes with provenance and creates a GitHub Release.

For a non-default package manager or directory, pass inputs to `publish`:

```yaml
    with:
      package-manager: yarn
      working-directory: packages/library
```

Your local CI workflow needs a callable trigger. Keep its `pull_request` trigger, but omit `push: main` so CI does not run twice:

```yaml
on:
  workflow_call:
  pull_request:
```

Run **Release workflows** in this repository's Actions tab with a version such as `v1.0.0` to create a GitHub Release and update its `v1` and `v1.0` tags.
