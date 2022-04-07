# Versioning and branching strategy

Table of Contents
-----------------

<!-- markdown-toc -i release-process.md -->

<!-- toc -->

- [Release schedule and release candidates](#release-schedule-and-release-candidates)
- [Versioning (Semver)](#versioning-semver)
- [Support period](#support-period)
- [Changelog and release notes](#changelog-and-release-notes)
- [Branching strategy](#branching-strategy)
  * [General](#general)
  * [master branch and package.json version](#master-branch-and-packagejson-version)
  * [Release candidate and major release](#release-candidate-and-major-release)
    + [Next release candidate](#next-release-candidate)
    + [Release the major version](#release-the-major-version)
  * [Release minor and patches](#release-minor-and-patches)

<!-- tocstop -->

This document describes the release process and branching strategy
for hsd.

## Release schedule and release candidates
  We release 2 major versions of the hsd per year (October and April). We
release the `release candidate` for the next major version one month early to
allow others to join the testing of the `hsd`. `Release candidates` can be
released several times until the final release date.

## Versioning (Semver)
Releases can be categorized according to the semver:
  - Major release, we included backwards incompatible changes.
  - Minor release, we made backwards compatible changes.
  - Patch release, we just fixed the bugs.

This document uses following definitions for the versions:
  - `latest` version (`major.x.x`) - Last released major version where
    we push the minor and patch updates actively.
  - `next` version (`major+1.x.x`) - The version that will be released
    on the next major release date.
  - `previous` version (`major-1.x.x`).
  - `life-support` version (`major-2.x.x`).

Some useful tips for PRs:
  - Does it need database migration ? - major upgrade.
  - Does it change RPC or HTTP API in backwards incompatible way ? - major
    upgrade.
  - Consensus changes - major upgrade.
  - Soft fork is deployed to the `latest` first, if activation fails it will
    get removed from the `next` release.

## Support period
  We release 2 major version per year and we want to support each version at
least for a year. This means that we will support 2 more versions on top of the
`latest` version. For example current version `3.x.x` will get at least security
fixes, until version `6.x.x` is released. Support types:
  - `latest` version (`major.x.x`) - active minor and patche releases.
  - `previous` version (`major-1.x.x`) - backport patches and minor fixes
    only if it improves performance or has high impact.
  - `life-support` version (`major-2.x.x`)- only backport security fixes.
  - Anything prior to these is discontinued.

NOTE: We should also collect stats for the active node versions in the network.

## Changelog and release notes
  CHANGELOG will only report backwards-incompatible API changes and actions
users need to take to upgrade.  
 Each version release should be accompanied by a new release-note file for that
version, which will contain detailed information of the update. This includes
`Pull Requests` list (titles and links), CHANGELOG information related to this
version.

## Branching strategy
### General
  `master` branch is not associated with any released versions and should not
be used in production. Each released version lives in a separate branch:
  - `latest` in `major.x` branch.
  - `previous` in `major-1.x` branch.
  - `life-support` in `major-2.x` branch.

Minor and patch releases of these versions are released from these branches and
updates are backported from the `master`. Merges to the released version
branches must happen via Pull Requests to give other maintainers and reviewers
time to review and verify what will be released.

Process below will be described as procedures for the situations:
  - release `next` major version candidate.
  - release `next` major version. (becomes `latest`)
  - release `latest` minor and patch versions.
  - release `previous` minor and patch versions.
  - release `life-support` minor and patch versions.

Process for the `latest` and `previous` minor/patch releases is the same.
At the same time only these branches should exist in the repo
(Example we have just released `v4.0.0`):
  - `master` - active development.
  - `v4.x` - just become `latest` version.
  - `v4.x-proposal` - active backport and PR base.
  - `v3.x` - just become `previous` version.
  - `v3.x-proposal` - import minor/patch backport and PR base.
  - `v2.x` - just become `life-support` version.
  - `v2` does not have proposal, because it only supports critical fixes, which
    wont go through standard PR release process.

### master branch and package.json version
  `master` branch only accumulates changes from PRs and is mostly untested(other
than PR testing). `next` release candidate will branch off from the master.
Package version in the `master` branch will always be set to the `latest` but
will have `minor` version set to `99` to signify the unsafe version
(`latestMajor.99.0`).

### Release candidate and major release
  `master` branch already contains everything that needs to be released
with the `next` version. Instead of directly creating branch to the
`next` version, we create `branch-proposal` to allow brief review
of the contents of the release. The purpose of proposal branches is to allow
other maintainers and reviewers to suggest including something else.
Proposal should not get dragged out and take max 2-3 days before moving on.
At this point we don't want to add more complex things to the release candidate,
only `patch`es until release(feature lock).

Process example (e.g. `latest` was `3.1.0` and we are releasing `4.0.0-rc.1`):
  - create branch `4.x` from the `master`.
  - create branch `4.x-proposal` from the `master`.
  - update `package.json` version to `4.99.0` in `master` branch.
  - update `package.json` version to `4.0.0-rc.1` in `4.x-proposal` branch.
  - optional: In case we want to omit some changes from the `master`,
    you can also rebase and discard those commits.
  - Create Release doc file for the
    `docs/release-notes/release-notes-4.0.0-draft.md`.
  - Update CHANGELOG file with the incompatibilities and actions to take.
  - Update network seeds.
  - Add new checkpoint. Last checkpoint + 6 months.
  - Create PR: `Release v4.0.0-rc.1` from branch `4.x-proposal` to `4.x`.
    - PR description containing list of PRs (similar to release notes)
    - We can discuss if we want to add something the release candidate for
      testing.

After discussion and review (this should be relatively quick) of the proposal
we do the release of the `release candidate`:
  - Merge proposal PR to the `4.x` branch.
  - Create the [release files][release-files] for the `4.0.0-rc.1`.

#### Next release candidate
  After `release-candidate` is released, we can use `next.x-proposal` branch to
accumulate `backport`s for the `patch`es that are found during testing period.

Process example:
  - backport `patch`(es) from the `master` to the `4.x-proposal`.
  - update `package.json` version to `4.0.0-rc.2` in the `4.x-proposal`.
  - Update Release doc file for the
    `docs/release-notes/release-notes-4.0.0-draft.md`.
  - Update CHANGELOG file with the incompatibilities and actions to take.
    (should not be any)
  - Create PR `Release v4.0.0-rc.2` from branch `4.x-proposal` to `4.x`.
    - PR lists new PRs that are being added.
  - Quick review and merge
  - Create the [release files][release-files] for the `4.0.0-rc.2`.
  - Next release candidate does not need to update main version tags.
    (see release below)

#### Release the major version
Above process continues until last week where we do the actual release:
  - update `package.json` version to `4.0.0` in the `4.x-proposal` branch.
  - Rename relase doc file from
    `docs/release-notes/release-notes-4.0.0-draft.md` to
    `docs/release-notes/release-notes-4.0.0.md`
  - CHANGELOG should be up to date.
  - Create PR `Release v4.0.0` from the branch `4.x-proposal` to `4.x`.
    - PR list from prev PRs.
  - Final review before release
  - [Release files][release-files] for the `4.0.0`
  - Update [schedule][schedule] if necessary
  - Update `latest` tag.
  - Update `previous` tag.
  - Update `life-support` tag.

### Release minor and patches
  This applies to all minor and patches that are being backported to the
`latest`, `previous` versions. Example `v4.0.0` is `latest` and we want to
release minor(process is the same for `previous` minor and patch releases):
  - update `package.json` version to `4.1.0` in the `4.x-proposal` branch.
  - Create Release doc file `docs/release-notes/release-notes-4.1.0.md`.
  - NO CHANGES TO CHANGELOG - this is minor.
  - Create PR `Release v4.1.0` from the branch `4.x-proposal` to `4.x`.
    - PR description containing list of PRs (similar to release notes)
    - We can discuss if we want to add something the release candidate for
      testing.
  - Review and merge.
  - Tag `v4.1.0` from the `4.x`.
  - [Release files][release-files] for the `4.1.0`.
  - Depending on the version we are upgrading, update relevant tag:
    - `latest` if we are releasing from the last `major`.
    - `previous` if we are updating `previous` versions `minor`.
    - `life-support` if we are updating `life-support` versions `minor`.

[release-files]: ./release-files.md
[schedule]: ./release-schedule.md
