Releasing hsd and hs-client
===========================

This document contains information about bundling, signing and
distributing the files.

`hsd/hs-client` is distributed through several platforms: `github`, `npm`.

<!-- markdown-toc -i release-files.md -->

<!-- toc -->

- [hsd](#hsd)
  * [Deploying to github (tag)](#deploying-to-github-tag)
    + [Major, minor and patches](#major-minor-and-patches)
      - [Major](#major)
      - [Minor, Patch](#minor-patch)
  * [Deploying to npm](#deploying-to-npm)
    + [Deploying latest version, minor and patches included](#deploying-latest-version-minor-and-patches-included)
  * [Deploying to handshake.org](#deploying-to-handshakeorg)
    + [Building tarball](#building-tarball)
    + [Signing and upload](#signing-and-upload)
- [hs-client](#hs-client)

<!-- tocstop -->

# hsd
## Deploying to github (tag)

  This does not need many additional actions as we use github as our primary
git platform. Tags MUST to be signed.

### Major, minor and patches
After you are [ready](./release-process.md) to publish files (for example
`v4.0.0`)
  - `git checkout 4.x` - switch to proper branch `4.x`.
  - `git tag -s v4.0.0` - tag and sign the release.
  - `git push origin v4.0.0` - publish the tag. (origin is the main repo)
  - Add release to `github` on the `releases` page.

#### Major
  When updating major version, we need to move forward all tags.
  - `git checkout v4.0.0` - latest version.
  - `git tag --force -s latest` - Tag `v4.0.0` as `latest`.
  - `git checkout v3.x.x` - latest `v3` version.
  - `git tag --force -s previous` - Tag latest `v3` as `previous`.

#### Minor, Patch
  If we are updating minor/patch versions, regardless of the `major`, we
need to update tag related to it. E.g. `latest` minor/patch release will
retag the `latest`. If `previous` major version got minor/patch update
it will update `previous` tag. We will have full example with `major`:
  - `git checkout v4.x.x` - Checkout the `latest` tagged version we just tagged
    with minor/patch.
  - `git tag --force -s latest` - Update `latest` tag with the major/minor
    update.

## Deploying to npm
  Maintainer needs access rights to the npm repository. Releasing
on npm by default tags the release with `latest`.
`previous` tag is not released on npm.

NOTE: You can use `npm publish --dry-run` to see the details before actual
release.

### Deploying latest version, minor and patches included
Major, minor and patch of the latest version deployment (for example v4.1.0):
  - `git checkout v4.1.0` - switch to the tag containing `4.1.0` updates.
  - `npm publish` - this is will be tagged as `latest`.

NOTE: `package.json` should have been updated in `v4.1.0` tag to `4.1.0`.

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

# hs-client
  Since hsd v6 `hs-client` is part of the `hsd`. Original [hs-client repo][hsclient] is now used to
publish generated content. `hs-client` version will now be strictly tied to
the `hsd` version. It is then generated from `hsd` code to release separately on
`git` and `npm`. Most of the process is done by the introduced helper script
`scripts/gen-hsclient.js`. It can help you setup `hs-client` that just needs
publishing on `git` and `npm`. It also gives instructions how to do both.
  After `hsd` has been released we can also release `hs-client` from the same
commit/tag, just run: `./scripts/gen-hsclient.js` which will generate `hs-client`
package with `git` setup in `tmp` directory. You can alternatively pass
`DIRECTORY` as argument for custom path. If generating git failed for some
reason, it will list commands that needs executing and you can proceed manually
or fix the issues and rerun the script. NOTE, that the script will never try to
publish by itself, only generate files to review locally.
  - `./scripts/gen-hsclient.js /tmp/hs-client` - script will also list the commands,
    that needs running for publishing to the git and npm.
  - `cd /tmp/hs-client`
  - `git push -f origin master` - rewrite whole `hs-client` repo with the new content.
  - `git push -f origin vVersion` - push newly generated tag to the `hs-client`.
    - You can check the `gen-hsclient` output for the proper version or
    - `git tag -l` to list.
  - `npm publish` - this will also tag it as `latest`. If you want to tag it differently
    you can do so, same as above hsd `npm publish`.
    - NOTE: You can use `npm publish --dry-run` to see the details before actual
      release.


[handshake-web]: https://github.com/handshake-org/handshake-web/
[bpkg]: https://github.com/chjj/bpkg
[hsclient]: https://github.com/handshake-org/hs-client
