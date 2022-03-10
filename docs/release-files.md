Releasing hsd
=============

This document contains information about bundling, signing and
distributing the files.

`hsd` is distributed through several platforms: `github`, `npm`, `brew`.

<!-- markdown-toc -i release-files.md -->

<!-- toc -->

- [Deploying to github (tag)](#deploying-to-github-tag)
  * [Major, minor and patches](#major-minor-and-patches)
- [Deploying to npm](#deploying-to-npm)
  * [Deploying latest version, minor and patches included](#deploying-latest-version-minor-and-patches-included)
  * [Deploying support versions (previous and life-support)](#deploying-support-versions-previous-and-life-support)
- [Deploying to homebrew](#deploying-to-homebrew)
- [Deploying to handshake.org](#deploying-to-handshakeorg)

<!-- tocstop -->

## Deploying to github (tag)

  This does not need many additional actions as we use github as our primary
git platform. After each release we need to update INSTALL.md versions. Tags
MUST to be signed.

NOTE: `package.json` should have been updated in `v4.1.0` tag to `4.1.0`.

### Major, minor and patches
After you are [ready](./release-process.md) to publish files
(for example `v4.0.0`)
  - `git checkout 4.x` - switch to proper branch `4.x`.
  - `git tag -s v4.0.0` - tag and sign the release.
  - `git push origin v4.0.0` - publish the tag. (origin is the main repo)

## Deploying to npm
  Maintainer needs access rights to the npm repository. Releasing
on npm by default tags the release with `latest`, so releasing latest
and supporting older versions is different.

NOTE: You can use `npm publish --dry-run` to see the details before actual
release.

### Deploying latest version, minor and patches included
Major, minor and patch of the latest version deployment (for example v4.1.0):
  - `git checkout v4.1.0` - switch to the tag containing `4.1.0` updates.
  - `npm publish` - this is will be tagged as `latest`.

NOTE: `package.json` should have been updated in `v4.1.0` tag to `4.1.0`.

### Deploying support versions (previous and life-support)
Older versions can have additional tags for `previous` and `life-support`:
  - `git checkout v3.1.0` - switch to the tag for the `previous` version.
  - `npm publish --tag previous` - update appropriate npm tag for the release.
or
  - `git checkout v2.4.1` - switch to the tag for the `life-support` version.
  - `npm publish --tag life-support` - update appropriate npm tag for the
    release.

NOTE: `package.json` should have been updated in `v3.1.0` tag to `3.1.0`.

## Deploying to homebrew
  To deploy to the popular MacOS package manager [brew][homebrew], you will
need to create Pull request to the [Hombrew Core repository][homebrew-repo].
Formula for the `hsd` can be found at `homebrew-core/Formula/hsd.rb`
  - Update `homebrew-core/Formula/hsd.rb`. (e.g. [hsd 3.0.1][homebrew-update])
  - You can check the steps when formula was introduced
    [hsd formula][homebrew-new-formula] or review the
    [Guidelines][homebrew-guidelines].
  - Additionally double check if `nodejs` version needs update.

## Deploying to handshake.org
  Handshake.org website is hosted via github and can be found at
[handshake-org/handshake-web][handshake-web]. Website contains easy to install
tarball with signatures from the maintainers.

### Building tarball
  In order to build tarball, you will need [bpkg][bpkg] tool.
(We'll use `v3.0.1` as an example)
  - Checkout to the correct version you want to release.
  - Remove `node_modules/`.
  - Install deps using: `npm ci --ignore-scripts`.
  - Generate tarball: `bpkg --verbose --release --output=../hsd-3.0.1.tar.gz .`
  - You can see the tarball at `../hsd-3.0.1.tar.gz`
NOTE: Everything in the existing directory of `hsd` will be bundled, so make
sure there are no external files there. (Check `git status` there's nothing to
commit and working tree is clean)

### Signing and upload
  Now that we have tarball, we can sign and upload. Next step is to sign
and create PR with the relevant updates to the `download/index.html` and
`files/` directory.
  - Generate signature (default key):
    `gpg --detach-sign --armor project-version.tar.gz`
  - Move `.asc` and `.tar.gz` tarball files to `files/` directory and commit.
  - Update `download/index.html` with new links.
  - Create PR to the main repository.

[homebrew]: https://brew.sh/
[homebrew-repo]: https://github.com/Homebrew/homebrew-core
[homebrew-new-formula]: https://github.com/Homebrew/homebrew-core/pull/51014
[homebrew-update]: https://github.com/Homebrew/homebrew-core/pull/87779/files
[homebrew-guidelines]: https://github.com/Homebrew/homebrew-core/blob/master/CONTRIBUTING.md
[handshake-web]: https://github.com/handshake-org/handshake-web/
[bpkg]: https://github.com/chjj/bpkg
