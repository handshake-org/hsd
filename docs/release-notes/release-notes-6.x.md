v6.x Release notes
==================

<!-- toc -->

- [v6.0.0](#v600)
  * [How to Upgrade](#how-to-upgrade)
  * [Notable Changes](#notable-changes)
    + [Network](#network)
    + [Package](#package)
    + [Node and Wallet HTTP API](#node-and-wallet-http-api)
    + [Wallet Changes](#wallet-changes)
      - [Configuration](#configuration)
      - [Wallet API](#wallet-api)
  * [Changelog](#changelog)
- [v6.1.0](#v610)
  * [Changelog](#changelog-1)

<!-- tocstop -->

# v6.0.0
## How to Upgrade
  This version does not have any migrations, so upgrade does not need an action.

## Notable Changes
### Network
  ICANN Lockup soft fork has been included. ([#819](https://github.com/handshake-org/hsd/pull/819), [#828](https://github.com/handshake-org/hsd/pull/828), [#834](https://github.com/handshake-org/hsd/pull/834))
  Miners who want to support the soft-fork need to start signalling with `icannlockup` bit.

### Package
  [hs-client][hs-client] is now part of the `hsd`. [hs-client][hs-client] will be generated from the `hsd`. ([#796](https://github.com/handshake-org/hsd/pull/796)).

### Node and Wallet HTTP API
  Validation errors, request paremeter errors or bad HTTP requests will no
longer return (and log) `500` status code, instead will return `400`. ([#807](https://github.com/handshake-org/hsd/pull/807), [#835](https://github.com/handshake-org/hsd/pull/835))

### Wallet Changes
#### Configuration
  `hsd.conf` can now be used to define wallet options, when wallet is running as
a plugin. Configurations with `wallet-` prefix will be passed to the wallet.
`hsd.conf` wont be used if the wallet is running in standalone mode. ([#806](https://github.com/handshake-org/hsd/pull/806))

- Remove `check-lookahead` option from walletdb. ([#797](https://github.com/handshake-org/hsd/pull/797))

#### Wallet API

- HTTP Changes:
  - `/wallet/:id/open` no longer accepts `force` flag. (it was not used) ([#815](https://github.com/handshake-org/hsd/pull/815))
- RPC Changes:
  - `createopen` and `sendopen` no longer accept `force` as an argument. (was not used) ([#815](https://github.com/handshake-org/hsd/pull/815))
  - Introduce new API to modify account: `PATCH /wallet/:id/account/:account`. ([#797](https://github.com/handshake-org/hsd/pull/797))

## Changelog
  - \[[`90cdf84e`](https://github.com/handshake-org/hsd/commit/90cdf84e)] - [#819](https://github.com/handshake-org/hsd/pull/819) - **SEMVER-MAJOR chain**: Icann lockup - SOFT-FORK  (@nodech - Nodari Chkuaselidze)
  - \[[`2fab14e8`](https://github.com/handshake-org/hsd/commit/2fab14e8)] - [#834](https://github.com/handshake-org/hsd/pull/834) - **SEMVER-MAJOR chain**: icannlockup soft fork - update start time and timeout.  (@nodech - Nodari Chkuaselidze)
  - \[[`d7a7cf92`](https://github.com/handshake-org/hsd/commit/d7a7cf92)] - [#828](https://github.com/handshake-org/hsd/pull/828) - **SEMVER-MAJOR chain**: icann lockup soft fork - Add 10k alexa to the soft-fork.  (@nodech - Nodari Chkuaselidze)
  - \[[`0f2e73f5`](https://github.com/handshake-org/hsd/commit/0f2e73f5)] - [#797](https://github.com/handshake-org/hsd/pull/797) - **SEMVER-MAJOR wallet-http**: endpoint for updating account lookahead  (@nodech - Nodari Chkuaselidze)
  - \[[`b03d7007`](https://github.com/handshake-org/hsd/commit/b03d7007)] - [#807](https://github.com/handshake-org/hsd/pull/807) - **SEMVER-MAJOR http**: update validator status codes.  (@nodech - Nodari Chkuaselidze)
  - \[[`93ee4420`](https://github.com/handshake-org/hsd/commit/93ee4420)] - [#806](https://github.com/handshake-org/hsd/pull/806) - **SEMVER-MAJOR pkg**: allow plugins to inherit configurations from the hsd.conf  (@nodech - Nodari Chkuaselidze)
  - \[[`03898507`](https://github.com/handshake-org/hsd/commit/03898507)] - [#796](https://github.com/handshake-org/hsd/pull/796) - **SEMVER-MAJOR pkg**: Import `hs-client` into the project.  (@nodech - Nodari Chkuaselidze)
  - \[[`5fe70c05`](https://github.com/handshake-org/hsd/commit/5fe70c05)] - [#815](https://github.com/handshake-org/hsd/pull/815) - **SEMVER-MAJOR wallet**: remove force option from wallet.makeOpen.  (@nodech - Nodari Chkuaselidze)
  - \[[`c721c5be`](https://github.com/handshake-org/hsd/commit/c721c5be)] - [#836](https://github.com/handshake-org/hsd/pull/836) - **SEMVER-MINOR network**: Update network seeds, checkpoints and deps  (@nodech - Nodari Chkuaselidze)
  - \[[`15f74ccf`](https://github.com/handshake-org/hsd/commit/15f74ccf)] - [#824](https://github.com/handshake-org/hsd/pull/824) - **SEMVER-MINOR wallet-rpc**: Added totalSigs to JSON response for scriptToJSON (@Nathanwoodburn - Nathan Woodburn)
  - \[[`5bed384b`](https://github.com/handshake-org/hsd/commit/5bed384b)] - [#818](https://github.com/handshake-org/hsd/pull/818) - **SEMVER-MINOR wallet-http**: reveals all now can be created without broadcasting.  (@nodech - Nodari Chkuaselidze)
  - \[[`5387e3a0`](https://github.com/handshake-org/hsd/commit/5387e3a0)] - [#802](https://github.com/handshake-org/hsd/pull/802) - **SEMVER-MINOR wallet-http**: add output paths to JSON  (@pinheadmz - Matthew Zipkin)
  - \[[`32482a5c`](https://github.com/handshake-org/hsd/commit/32482a5c)] - [#746](https://github.com/handshake-org/hsd/pull/746) - **bin**: replace shell scripts with js require  (@rithvikvibhu - Rithvik Vibhu)
  - \[[`5210af2d`](https://github.com/handshake-org/hsd/commit/5210af2d)] - [#833](https://github.com/handshake-org/hsd/pull/833) - **bin**: fix config api-key alias  (@rithvikvibhu - Rithvik Vibhu)
  - \[[`fec9fddf`](https://github.com/handshake-org/hsd/commit/fec9fddf)] - [#835](https://github.com/handshake-org/hsd/pull/835) - **pkg**: update bweb.  (@nodech - Nodari Chkuaselidze)
  - \[[`81bddcd2`](https://github.com/handshake-org/hsd/commit/81bddcd2)] - [#825](https://github.com/handshake-org/hsd/pull/825) - **wallet**: fix makeBatch to generate addresses early  (@rithvikvibhu - Rithvik Vibhu)
  - \[[`ed27e7f6`](https://github.com/handshake-org/hsd/commit/ed27e7f6)] - [#826](https://github.com/handshake-org/hsd/pull/826) - **mempool**: more invalidation tests.  (@nodech - Nodari Chkuaselidze)
  - \[[`5eae8f62`](https://github.com/handshake-org/hsd/commit/5eae8f62)] - [#827](https://github.com/handshake-org/hsd/pull/827) - **docs**: Update checkpoints guide in release-process.md - @handshake-enthusiast
  - \[[`aefc311f`](https://github.com/handshake-org/hsd/commit/aefc311f)] - [#820](https://github.com/handshake-org/hsd/pull/820) - **wallet**: minor clean up  (@nodech - Nodari Chkuaselidze)
  - \[[`614bfaf5`](https://github.com/handshake-org/hsd/commit/614bfaf5)] - [#813](https://github.com/handshake-org/hsd/pull/813) - **mempool**: invalidate claims when period ends.  (@nodech - Nodari Chkuaselidze)
  - \[[`433d5e9e`](https://github.com/handshake-org/hsd/commit/433d5e9e)] - [#817](https://github.com/handshake-org/hsd/pull/817) - **chain**: clean up unused hardened option from getNameStatus.  (@nodech - Nodari Chkuaselidze)
  - \[[`61c1e057`](https://github.com/handshake-org/hsd/commit/61c1e057)] - [#816](https://github.com/handshake-org/hsd/pull/816) - **wallet**: refactor createTX to be more flexible  (@nodech - Nodari Chkuaselidze)
  - \[[`e122b127`](https://github.com/handshake-org/hsd/commit/e122b127)] - [#814](https://github.com/handshake-org/hsd/pull/814) - **test**: minor mempool test cleanup.  (@nodech - Nodari Chkuaselidze)
  - \[[`c1b2180c`](https://github.com/handshake-org/hsd/commit/c1b2180c)] - [#808](https://github.com/handshake-org/hsd/pull/808) - **test**: fix .rejects usage.  (@nodech - Nodari Chkuaselidze)
  - \[[`2bb8f0b0`](https://github.com/handshake-org/hsd/commit/2bb8f0b0)] - [#810](https://github.com/handshake-org/hsd/pull/810) - **docs**: Minor doc fix about release docs  (@nodech - Nodari Chkuaselidze)
  - \[[`6b47c3a0`](https://github.com/handshake-org/hsd/commit/6b47c3a0)] - [#805](https://github.com/handshake-org/hsd/pull/805) - **net**: update last checkpoint.  (@nodech - Nodari Chkuaselidze)
  - \[[`008374ca`](https://github.com/handshake-org/hsd/commit/008374ca)] - [#800](https://github.com/handshake-org/hsd/pull/800) - **docs**: backport v5.0.0 release notes.  (@nodech - Nodari Chkuaselidze)
  - \[[`500d638d`](https://github.com/handshake-org/hsd/commit/500d638d)] - [#838](https://github.com/handshake-org/hsd/pull/838) - **scripts**: Update hs-client generator.  (@nodech - Nodari Chkuaselidze)

[hs-client]: https://github.com/handshake-org/hs-client

# v6.1.0
Re-enable bip9 signalling that was disabled in v2. See [#842](https://github.com/handshake-org/hsd/pull/842)
- `getblocktemplate` can now start signalling soft-forks again using `rules` parameter. (e.g. `getblocktemplate '{ "rules": [ "icannlockup" ] }'`)
- `getwork` will now signal **ALL** soft-forks again.

## Changelog
  - \[[`6dc5249d`](https://github.com/handshake-org/hsd/commit/6dc5249d)] - [#842](https://github.com/handshake-org/hsd/pull/842) - **SEMVER-MINOR miner**: Fix bip9 signalling.  (@rithvikvibhu - Rithvik Vibhu)
