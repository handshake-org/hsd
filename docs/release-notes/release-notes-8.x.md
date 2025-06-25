v8.x Release notes
==================

<!-- toc -->

- [v8.0.0](#v800)
  * [How to Upgrade](#how-to-upgrade)
  * [Notable Changes](#notable-changes)
    + [Network](#network)
    + [Wallet Changes](#wallet-changes)
      - [Wallet HTTP API](#wallet-http-api)
      - [Wallet/WalletDB API](#walletwalletdb-api)
    + [hs-client Wallet](#hs-client-wallet)
  * [Changelog](#changelog)

<!-- tocstop -->

# v8.0.0
## How to Upgrade
**When upgrading to this version of hsd, you must pass `--chain-migrate=4`
and `--wallet-migrate=7` when you run it for the first time.
It is strongly recommended to back up your wallet before proceeding with the upgrade
([#925](https://github.com/handshake-org/hsd/pull/925),
 [#928](https://github.com/handshake-org/hsd/pull/928))**.

## Notable Changes

### Network

**End Airdrop soft fork has been included. ([#927](https://github.com/handshake-org/hsd/pull/927))
Miners who want to support the soft-fork need to start signalling with `airstop` bit.**

### Wallet Changes

#### Wallet HTTP API
  - `POST /wallet/:id/zap` response object has a new property: `zapped: number`,
    indicating the number of transactions that were zapped
    ([#920](https://github.com/handshake-org/hsd/pull/920)).
  - `GET /wallet/:id/name/:name` now accepts an `own` parameter and only returns
    the namestate when the wallet owns the name
    ([#922](https://github.com/handshake-org/hsd/pull/922)).
  - Introduce admin `POST /recalculate-balances`, useful if the post-migration
    recalculation was not triggered and wallet balances are not correct
    ([#926](https://github.com/handshake-org/hsd/pull/926)).
  - The TX creation HTTP Endpoints now supports new values for the `selection`
    property. These new strategies use database iterators instead of loading all
    coins into RAM ([#928](https://github.com/handshake-org/hsd/pull/928)).
    - `db-value` - This is a database alternative to `value` and new default.
    - `db-age` - A database alternative `age`.
    - `db-all` - A database alternative `all`.
    - `db-sweepdust` - Select smallest coins first.
      - Add `sweepdustMinValue` option for TX creation endpoints, default 1.

#### Wallet/WalletDB API
  - `Wallet.zap` now returns the number of transactions zapped instead of their hashes
    ([#920](https://github.com/handshake-org/hsd/pull/920)).

### hs-client Wallet
  - `getName` now accepts an `options` object with an `own` property
    ([#922](https://github.com/handshake-org/hsd/pull/922)).

## Changelog

 - \[[`82cacf38`](https://github.com/handshake-org/hsd/commit/82cacf38)] - [#933](https://github.com/handshake-org/hsd/pull/933) - **SEMVER-MAJOR net/pkg**: Update network seeds, checkpoints and deps - (@nodech - Nodari Chkuaselidze)
 - \[[`dee79a3c`](https://github.com/handshake-org/hsd/commit/dee79a3c)] - [#927](https://github.com/handshake-org/hsd/pull/927) - **SEMVER-MAJOR chain**: add airstop soft fork - (@rithvikvibhu - Rithvik Vibhu)
 - \[[`f0a81dac`](https://github.com/handshake-org/hsd/commit/f0a81dac)] - [#928](https://github.com/handshake-org/hsd/pull/928) - **SEMVER-MAJOR wallet**: - Wallet coinselection - (@nodech - Nodari Chkuaselidze)
 - \[[`5f11d622`](https://github.com/handshake-org/hsd/commit/5f11d622)] - [#925](https://github.com/handshake-org/hsd/pull/925) - **SEMVER-MAJOR migrations**: Add in progress data to migration - (@nodech - Nodari Chkuaselidze)
 - \[[`e19f9fb4`](https://github.com/handshake-org/hsd/commit/e19f9fb4)] - [#930](https://github.com/handshake-org/hsd/pull/930) - **SEMVER-MINOR seeder**: allow passing custom prefix dir - (@rithvikvibhu - Rithvik Vibhu)
 - \[[`18dcc5e1`](https://github.com/handshake-org/hsd/commit/18dcc5e1)] - [#926](https://github.com/handshake-org/hsd/pull/926) - **SEMVER-MINOR wallet**: recalculate-balances endpoint. - (@nodech - Nodari Chkuaselidze)
 - \[[`31009340`](https://github.com/handshake-org/hsd/commit/31009340)] - [#922](https://github.com/handshake-org/hsd/pull/922) - **SEMVER-MINOR wallet-http**: Add own parameter to the getName. - (@nodech - Nodari Chkuaselidze)
 - \[[`77e22dae`](https://github.com/handshake-org/hsd/commit/77e22dae)] - [#920](https://github.com/handshake-org/hsd/pull/920) - **SEMVER-MINOR wallet-http**: Return total number of transactions zapped. - (@nodech - Nodari Chkuaselidze)
 - \[[`343525aa`](https://github.com/handshake-org/hsd/commit/343525aa)] - [#916](https://github.com/handshake-org/hsd/pull/916) - **SEMVER-MINOR wallet-http:** Wallet http fixes clean - (@nodech - Nodari Chkuaselidze)
 - \[[`827769d4`](https://github.com/handshake-org/hsd/commit/827769d4)] - [#932](https://github.com/handshake-org/hsd/pull/932) - **wallet-http**: validate timeouts and make default explicit. - (@nodech - Nodari Chkuaselidze)
 - \[[`85a1ada0`](https://github.com/handshake-org/hsd/commit/85a1ada0)] - [#929](https://github.com/handshake-org/hsd/pull/929) - **ci**: add nodejs v24 to the matrix. - (@nodech - Nodari Chkuaselidze)
 - \[[`8df0724a`](https://github.com/handshake-org/hsd/commit/8df0724a)] - [#924](https://github.com/handshake-org/hsd/pull/924) - **net**: remove easyhandshake from mainnet seed nodes - (@pinheadmz - Matthew Zipkin)
 - \[[`73533cdf`](https://github.com/handshake-org/hsd/commit/73533cdf)] - [#923](https://github.com/handshake-org/hsd/pull/923) - **misc**: update chain types - (@nodech - Nodari Chkuaselidze)
 - \[[`ab2f5f84`](https://github.com/handshake-org/hsd/commit/ab2f5f84)] - [#921](https://github.com/handshake-org/hsd/pull/921) - **misc**: don't use public class fields usage. - (@nodech - Nodari Chkuaselidze)
 - \[[`dd7249f6`](https://github.com/handshake-org/hsd/commit/dd7249f6)] - [#919](https://github.com/handshake-org/hsd/pull/919) - **docs**: backport release notes. - (@nodech - Nodari Chkuaselidze)
 - \[[`886f6515`](https://github.com/handshake-org/hsd/commit/886f6515)] - [#918](https://github.com/handshake-org/hsd/pull/918) - **wallet-misc**: clean up types - (@nodech - Nodari Chkuaselidze)
 - \[[`11bd81f5`](https://github.com/handshake-org/hsd/commit/11bd81f5)] - [#917](https://github.com/handshake-org/hsd/pull/917) - **ci**: Update ci and add node v22 - (@nodech - Nodari Chkuaselidze)
