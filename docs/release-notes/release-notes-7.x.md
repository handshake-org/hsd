v7.x Release notes
==================

<!-- toc -->

- [v7.0.0](#v700)
  * [How to Upgrade](#how-to-upgrade)
  * [Notable Changes](#notable-changes)
    + [Primitives](#primitives)
    + [Node Changes](#node-changes)
      - [Node HTTP API](#node-http-api)
    + [hs-client node](#hs-client-node)
    + [Wallet Changes](#wallet-changes)
      - [Wallet Configuration](#wallet-configuration)
      - [Wallet API](#wallet-api)
        * [Wallet HTTP API](#wallet-http-api)
        * [Examples](#examples)
        * [Wallet RPC](#wallet-rpc)
        * [Wallet CLI (hsw-cli)](#wallet-cli-hsw-cli)
    + [hs-client wallet](#hs-client-wallet)
  * [Changelog](#changelog)
- [v7.0.1](#v701)
  * [Changelog](#changelog-1)

<!-- tocstop -->

# v7.0.0
## How to Upgrade
  When upgrading to this version, you must use the `--wallet-migrate=5` flag
the first time you run it. It is strongly recommended to back up your wallet
before proceeding with the upgrade
([#782](https://github.com/handshake-org/hsd/pull/782),
 [#896](https://github.com/handshake-org/hsd/pull/896),
 [#888](https://github.com/handshake-org/hsd/pull/888)).

## Notable Changes
### Primitives
- TX
  - tx.test no longer updates the filter,
    instead `.testAndMaybeUpdate` is used for testing and potentially updating
    ([#856](https://github.com/handshake-org/hsd/pull/856)).

### Node Changes
  Add support for the interactive rescan, that allows more control over
rescan process and allows parallel rescans
([#856](https://github.com/handshake-org/hsd/pull/856)).

#### Node HTTP API
- `GET /` or `getInfo()` now has more properties
([#869](https://github.com/handshake-org/hsd/pull/869)):
  - `treeRootHeight` - height at which the block txns are accumulated
    in the current branch.
  - `indexers`
    - `indexTX` - is tx indexer enabled.
    - `indexAddress` - is addr indexer enabled.
  - `options`
    - `spv` is the Node SPV?
    - `prune` does node have pruning enabled.
  - `treeCompaction`
    - `compacted` - whethere tree is compacted or not.
    - `compactOnInit` - is tree compaction on init enabled.
    - `compactInterval` - what is the current compaction interval config.
    - `nextCompaction` - when will the next compaction trigger after restart.
    - `lastCompaction` - when was the last compaction run.
- Introduce `scan interactive` hook (start, filter, fullLock)
([#883](https://github.com/handshake-org/hsd/pull/883)).
- Add `get median time` hook to get median time past for a blockhash
([#888](https://github.com/handshake-org/hsd/pull/888)).
- Add `get entries` hook to get entries. Similar to `get hashes`, but
returns encoded entries
([#888](https://github.com/handshake-org/hsd/pull/888)).

### hs-client node
- Introduce `scanInteractive` method that starts interactive rescan
  ([#856](https://github.com/handshake-org/hsd/pull/856)).
  - expects ws hook for `block rescan interactive` params `rawEntry, rawTXs`
    that returns scanAction object.
  - expects ws hook for `block rescan interactive abort` param `message`.
- Add `getMempoolRejectionFilter` and `checkMempoolRejectionFilter` NodeClient
  aliases. ([#882](https://github.com/handshake-org/hsd/pull/882)).
- Add `getFee`, an HTTP alternative to estimateFee socket call
  ([#882](https://github.com/handshake-org/hsd/pull/882)).
- Adds `getEntries(start, end)` that returns encoded chain entries
  ([#882](https://github.com/handshake-org/hsd/pull/882)).

### Wallet Changes
- Add migration that recalculates txdb balances to fix any inconsistencies
  ([#782](https://github.com/handshake-org/hsd/pull/782)).
- Wallet will now use `interactive scan` for initial sync(on open) and rescan
  ([#883](https://github.com/handshake-org/hsd/pull/883)).

#### Wallet Configuration
- Wallet now has option `wallet-migrate-no-rescan`/`migrate-no-rescan` if you
  want to disable rescan when migration recommends it. It may result in the
  incorrect txdb state, but can be useful if you know the issue does not affect
  your wallet or is not critical ([#859](https://github.com/handshake-org/hsd/pull/859)).
- Add `--wallet-preload-all` (or `--preload-all` for standalone wallet node)
  that will open all wallets before starting other services (e.g. HTTP).
  By default this is set to `false` ([#803](https://github.com/handshake-org/hsd/pull/803)).
- Add `--wallet-max-history-txs` (or `--max-history-txs` for standalone wallet
  node) that will be the hard limit of confirmed and unconfirmed histories
  ([#888](https://github.com/handshake-org/hsd/pull/888)).

#### Wallet API

- WalletNode now emits `open` and `close` events
  ([#883](https://github.com/handshake-org/hsd/pull/883)).
- WalletDB Now emits events for: `open`, `close`, `connect`, `disconnect`
  ([#859](https://github.com/handshake-org/hsd/pull/859)).
- WalletDB
  - `open()` no longer calls `connect` and needs separate call `connect`
    ([#859](https://github.com/handshake-org/hsd/pull/859)).
  - `open()` no longer calls scan, instead only rollbacks and waits for
    sync to do the rescan
    ([#859](https://github.com/handshake-org/hsd/pull/859)).
  - emits events for: `open`, `close`, `connect`, `disconnect`, `sync done`
    ([#859](https://github.com/handshake-org/hsd/pull/859)).
  - Wallet now has additional methods for quering history
    ([#888](https://github.com/handshake-org/hsd/pull/888)):
    - `listUnconfirmed(acc, { limit, reverse })` - Get first or last `limit`
      unconfirmed transactions.
    - `listUnconfirmedAfter(acc, { hash, limit, reverse })` - Get first or last `limit`
      unconfirmed transactions after/before tx with hash: `hash`.
    - `listUnconfirmedFrom(acc, { hash, limit, reverse })` - Get first or last `limit`
      unconfirmed transactions after/before tx with hash `hash`, inclusive.
    - `listUnconfirmedByTime(acc, { time, limit, reverse })` - Get first or last
      `limit` unconfirmed transactions after/before `time`, inclusive.
    - `listHistory(acc, { limit, reverse })` - Get first or last `limit`
      unconfirmed/confirmed transactions.
    - `listHistoryAfter(acc, { hash, limit, reverse })` - Get first or last `limit`
      unconfirmed/confirmed transactions after/before tx with hash `hash`.
    - `listHistoryFrom(acc, { hash, limit, reverse })` - Get first or last `limit`
      confirmed/unconfirmed transactions after/before tx with hash `hash`, inclusive.
    - `listUnconfirmedByTime(acc, { time, limit, reverse })` - Get first or last
      `limit` confirmed/unconfirmed transactions after/before `time`, inclusive.
    - NOTE: Default is ascending order, from the oldest.

##### Wallet HTTP API
- All transaction creating endpoints now accept `hardFee` for specifying the
  exact fee ([#845](https://github.com/handshake-org/hsd/pull/845)).
- All transaction sending endpoints now fundlock/queue tx creation. (no more
  conflicting transactions)
  ([#845](https://github.com/handshake-org/hsd/pull/845))
- Add options to `getNames` for passing `own`
  ([#882](https://github.com/handshake-org/hsd/pull/882)).
- Rename `createAuctionTxs` to `createAuctionTXs`
  ([#899](https://github.com/handshake-org/hsd/pull/899)).
- All `bid` serializations will include `height` of the bid. (`-1` if
  it was migrated not-owned bid)
  ([#896](https://github.com/handshake-org/hsd/pull/896))
  - `GET /wallet/:id/auction` (`getAuctions`)
  - `GET /wallet/:id/auction/:name` (`getAuctionByName`)
  - `GET /wallet/:id/bid` (`getBids`)
  - `GET /wallet/:id/bid/:name` (`getBidsByName`)
- All `reveal` serializations will include `bidPrevout` of the bid. (`null` if
it was migrated not-owned reveal)
  ([#896](https://github.com/handshake-org/hsd/pull/896))
  - `GET /wallet/:id/auction` (`getAuctions`)
  - `GET /wallet/:id/auction/:name` (`getAuctionByName`)
  - `GET /wallet/:id/reveal` (`getReveals`)
  - `GET /wallet/:id/reveal/:name` (`getRevealsByName`)
- `GET /wallet/:id/tx/history` - The params are now `time`, `after`,
`limit`, and `reverse`.
  ([#888](https://github.com/handshake-org/hsd/pull/888))
- `GET /wallet/:id/tx/unconfirmed` - The params are are same as above.
  ([#888](https://github.com/handshake-org/hsd/pull/888))

These endpoints have been deprecated
([#888](https://github.com/handshake-org/hsd/pull/888)):
- `GET /wallet/:id/tx/range` - Instead use the `time` param for the history and
  unconfirmed endpoints.
- `GET /wallet/:id/tx/last` - Instead use `reverse` param for the history and
  unconfirmed endpoints.

##### Examples

Pagination examples ([#888](https://github.com/handshake-org/hsd/pull/888)):

```
GET /wallet/:id/tx/history?after=<txid>&limit=50&reverse=false
GET /wallet/:id/tx/history?after=<txid>&limit=50&reverse=true
```
By using `after=<txid>` we can anchor pages so that results will not shift
when new blocks and transactions arrive. With `reverse=true` we can change
the order the transactions are returned as _latest to genesis_. The
`limit=<number>` specifies the maximum number of transactions to return
in the result.

```
GET /wallet/:id/tx/history?time=<median-time-past>&limit=50&reverse=false
GET /wallet/:id/tx/history?time=<median-time-past>&limit=50&reverse=true
```
The param `time` is in epoch seconds and indexed based on median-time-past
(MTP) and `date` is ISO 8601 format. Because multiple transactions can share
the same time, this can function as an initial query, and then switch to the
above `after` format for the following pages.

```
GET /wallet/:id/tx/unconfirmed?after=<txid>&limit=50&reverse=false
GET /wallet/:id/tx/unconfirmed?after=<txid>&limit=50&reverse=true
GET /wallet/:id/tx/unconfirmed?time=<time-received>&limit=50&reverse=false
```
The same will apply to unconfirmed transactions. The `time` is in epoch
seconds and indexed based on when the transaction was added to the wallet.

##### Wallet RPC
The following new methods have been added
([#888](https://github.com/handshake-org/hsd/pull/888)):
  - `listhistory` - List history with a limit and in reverse order.
  - `listhistoryafter` - List history after a txid _(subsequent pages)_.
  - `listhistorybytime` - List history by giving a timestamp in epoch seconds
    _(block median time past)_.
  - `listunconfirmed` - List unconfirmed transactions with a limit and in
    reverse order.
  - `listunconfirmedafter` - List unconfirmed transactions after a txid
    _(subsequent pages)_.
  - `listunconfirmedbytime` - List unconfirmed transactions by time they
    where added.

The following methods have been deprecated
([#888](https://github.com/handshake-org/hsd/pull/888)):
  - `listtransactions` - Use `listhistory` and the related methods and the
    `after` argument for results that do not shift when new blocks arrive.

##### Wallet CLI (hsw-cli)
  - `history` now accepts new args on top of `--account`: `--reverse`,
    `--limit`, `--after`, `--after`
    ([#888](https://github.com/handshake-org/hsd/pull/888)).
  - `pending` now accepts new args, same as above
    ([#888](https://github.com/handshake-org/hsd/pull/888)).


### hs-client wallet
  - `getHistory` and `Wallet.getHistory` no longer accept `account`,
    instead accepts object with properties: `account`, `time`, `after`,
    `limit`, and `reverse`
    ([#888](https://github.com/handshake-org/hsd/pull/888)).

  - `getPending` and `Wallet.getPending` have the same changes as
    `getHistory` above
    ([#888](https://github.com/handshake-org/hsd/pull/888)).

## Changelog
  - \[[`0a4cc496`](https://github.com/handshake-org/hsd/commit/0a4cc496)] - [#888](https://github.com/handshake-org/hsd/pull/888) - **SEMVER-MAJOR wallet**: Wallet TX Count and time indexing - (@nodech - Nodari Chkuaselidze and @braydonf - Braydon Fuller)
  - \[[`5294be7e`](https://github.com/handshake-org/hsd/commit/5294be7e)] - [#896](https://github.com/handshake-org/hsd/pull/896) - **SEMVER-MAJOR wallet**: Link bid and reveal - (@nodech - Nodari Chkuaselidze)
  - \[[`d754b863`](https://github.com/handshake-org/hsd/commit/d754b863)] - [#899](https://github.com/handshake-org/hsd/pull/899) - **SEMVER-MAJOR wallet-client**: rename createAuctionTxs to createAuctionTXs. - (@nodech - Nodari Chkuaselidze)
  - \[[`9ddb69e2`](https://github.com/handshake-org/hsd/commit/9ddb69e2)] - [#883](https://github.com/handshake-org/hsd/pull/883) - **SEMVER-MAJOR wallet**: Wallet Sync Updates - (@nodech - Nodari Chkuaselidze)
  - \[[`fc23f410`](https://github.com/handshake-org/hsd/commit/fc23f410)] - [#782](https://github.com/handshake-org/hsd/pull/782) - **SEMVER-MAJOR txdb**: Txdb tests and updates - (@nodech - Nodari Chkuaselidze and @pinheadmz - Matthew Zipkin)
  - \[[`bb7da60e`](https://github.com/handshake-org/hsd/commit/bb7da60e)] - [#859](https://github.com/handshake-org/hsd/pull/859) - **SEMVER-MAJOR wallet**: Add open/close and connect/disconnect events. - (@nodech - Nodari Chkuaselidze)
  - \[[`509ffe5f`](https://github.com/handshake-org/hsd/commit/509ffe5f)] - [#882](https://github.com/handshake-org/hsd/pull/882) - **SEMVER-MINOR clients**: Update wallet and node clients - (@nodech - Nodari Chkuaselidze)
  - \[[`f749f5cc`](https://github.com/handshake-org/hsd/commit/f749f5cc)] - [#885](https://github.com/handshake-org/hsd/pull/885) - **SEMVER-MINOR wallet**: set icannlockup to true for wallets. - (@nodech - Nodari Chkuaselidze)
  - \[[`419924b2`](https://github.com/handshake-org/hsd/commit/419924b2)] - [#856](https://github.com/handshake-org/hsd/pull/856) - **SEMVER-MINOR chain**: Fullnode interactive rescan. - (@nodech - Nodari Chkuaselidze)
  - \[[`79994774`](https://github.com/handshake-org/hsd/commit/79994774)] - [#803](https://github.com/handshake-org/hsd/pull/803) - **SEMVER-MINOR wallet**: --preload-all option to load all wallet on open. - (@nodech - Nodari Chkuaselidze)
  - \[[`aac7fa7b`](https://github.com/handshake-org/hsd/commit/aac7fa7b)] - [#869](https://github.com/handshake-org/hsd/pull/869) - **SEMVER-MINOR node-http**: Add node/chain parameters to the getInfo (`/`) - (@nodech - Nodari Chkuaselidze)
  - \[[`7bd2078c`](https://github.com/handshake-org/hsd/commit/7bd2078c)] - [#866](https://github.com/handshake-org/hsd/pull/866) - **SEMVER-MINOR covenant**: set methods on covenant. - (@nodech - Nodari Chkuaselidze)
  - \[[`7aeb668b`](https://github.com/handshake-org/hsd/commit/7aeb668b)] - [#845](https://github.com/handshake-org/hsd/pull/845) - **SEMVER-MINOR wallet-http**: put send transaction endpoints behind fund locks. - (@nodech - Nodari Chkuaselidze)
  - \[[`ceab2a81`](https://github.com/handshake-org/hsd/commit/ceab2a81)] - [#900](https://github.com/handshake-org/hsd/pull/900) - **migrations**: Update migrations - (@nodech - Nodari Chkuaselidze)
  - \[[`53780989`](https://github.com/handshake-org/hsd/commit/53780989)] - [#906](https://github.com/handshake-org/hsd/pull/906) - **net**: Remove offline seed node - (@Falci - Fernando Falci)
  - \[[`dc4f4f42`](https://github.com/handshake-org/hsd/commit/dc4f4f42)] - [#884](https://github.com/handshake-org/hsd/pull/884) - **net**: add nathan.woodburn nodes to seed - (@Nathanwoodburn - Nathan Woodburn)
  - \[[`1b331eed`](https://github.com/handshake-org/hsd/commit/1b331eed)] - [#904](https://github.com/handshake-org/hsd/pull/904) - **wallet**: Add more specific error when linked inputs are pending. - (@nodech - Nodari Chkuaselidze)
  - \[[`45c6ac1d`](https://github.com/handshake-org/hsd/commit/45c6ac1d)] - [#902](https://github.com/handshake-org/hsd/pull/902) - **types**: Update types - (@nodech - Nodari Chkuaselidze)
  - \[[`e88734fb`](https://github.com/handshake-org/hsd/commit/e88734fb)] - [#901](https://github.com/handshake-org/hsd/pull/901) - **mtx**: - Resolve coins from coinview as well during coinselection. - (@nodech - Nodari Chkuaselidze)
  - \[[`e93bd53e`](https://github.com/handshake-org/hsd/commit/e93bd53e)] - [#898](https://github.com/handshake-org/hsd/pull/898) - **wallet**: Add nowFn to wdb options and txdb. - (@nodech - Nodari Chkuaselidze)
  - \[[`680a9da7`](https://github.com/handshake-org/hsd/commit/680a9da7)] - [#897](https://github.com/handshake-org/hsd/pull/897) - **pkg**: Update bdb and other deps. - (@nodech - Nodari Chkuaselidze)
  - \[[`1daebd8a`](https://github.com/handshake-org/hsd/commit/1daebd8a)] - [#895](https://github.com/handshake-org/hsd/pull/895) - **test**: change ownership resolver from google to cloudflare. - (@nodech - Nodari Chkuaselidze)
  - \[[`fe336aec`](https://github.com/handshake-org/hsd/commit/fe336aec)] - [#893](https://github.com/handshake-org/hsd/pull/893) - **test**: disable dns-test until c-ares fix. - (@nodech - Nodari Chkuaselidze)
  - \[[`0a4f24bd`](https://github.com/handshake-org/hsd/commit/0a4f24bd)] - [#887](https://github.com/handshake-org/hsd/pull/887) - **pkg**: update lint and docs. - (@nodech - Nodari Chkuaselidze)
  - \[[`5f943173`](https://github.com/handshake-org/hsd/commit/5f943173)] - [#881](https://github.com/handshake-org/hsd/pull/881) - **test**: Test cleanup - (@nodech - Nodari Chkuaselidze)
  - \[[`349d203b`](https://github.com/handshake-org/hsd/commit/349d203b)] - [#875](https://github.com/handshake-org/hsd/pull/875) - **test**: Cover reorg for double open index - (@nodech - Nodari Chkuaselidze)
  - \[[`c9e39855`](https://github.com/handshake-org/hsd/commit/c9e39855)] - [#879](https://github.com/handshake-org/hsd/pull/879) - **test**: add in memory dns cache. - (@nodech - Nodari Chkuaselidze)
  - \[[`5955e913`](https://github.com/handshake-org/hsd/commit/5955e913)] - [#870](https://github.com/handshake-org/hsd/pull/870) - **wallet**: add tests for the chain state and fix markState - (@nodech - Nodari Chkuaselidze)
  - \[[`b6778c4b`](https://github.com/handshake-org/hsd/commit/b6778c4b)] - [#876](https://github.com/handshake-org/hsd/pull/876) - **pkg**: update to es2020. Use latest bslint - (@nodech - Nodari Chkuaselidze)
  - \[[`b01d39c2`](https://github.com/handshake-org/hsd/commit/b01d39c2)] - [#858](https://github.com/handshake-org/hsd/pull/858) - **net**: add a new permanently hard-coded seed node - @handshake-enthusiast
  - \[[`43e13006`](https://github.com/handshake-org/hsd/commit/43e13006)] - [#871](https://github.com/handshake-org/hsd/pull/871) - **wallet**: fix batch styles and jsdocs. - (@nodech - Nodari Chkuaselidze)
  - \[[`e3e5e01c`](https://github.com/handshake-org/hsd/commit/e3e5e01c)] - [#873](https://github.com/handshake-org/hsd/pull/873) - **chain**: remove unnecessary critical error. - (@nodech - Nodari Chkuaselidze)
  - \[[`64468280`](https://github.com/handshake-org/hsd/commit/64468280)] - [#861](https://github.com/handshake-org/hsd/pull/861) - **wallet**: don't add coinbase txs to the pending list. - (@nodech - Nodari Chkuaselidze)
  - \[[`bc3c1728`](https://github.com/handshake-org/hsd/commit/bc3c1728)] - [#868](https://github.com/handshake-org/hsd/pull/868) - **wallet**: rescan deadlock fix - (@nodech - Nodari Chkuaselidze)
  - \[[`0690c6f3`](https://github.com/handshake-org/hsd/commit/0690c6f3)] - [#860](https://github.com/handshake-org/hsd/pull/860) - **pkg**: clean up unused params. - (@nodech - Nodari Chkuaselidze)
  - \[[`4a70d700`](https://github.com/handshake-org/hsd/commit/4a70d700)] - [#863](https://github.com/handshake-org/hsd/pull/863) - **test**: add unit tests for cipher state - (@nodech - Nodari Chkuaselidze and @kilpatty - Sean Kilgarriff)
  - \[[`5582e791`](https://github.com/handshake-org/hsd/commit/5582e791)] - [#865](https://github.com/handshake-org/hsd/pull/865) - **test**: abstract some mining heights - (@nodech - Nodari Chkuaselidze and @tynes - Mark Tyneway)
  - \[[`5c287c9d`](https://github.com/handshake-org/hsd/commit/5c287c9d)] - [#853](https://github.com/handshake-org/hsd/pull/853) - **net**: Delete duplicates from seed nodes - @handshake-enthusiast
  - \[[`e4245e53`](https://github.com/handshake-org/hsd/commit/e4245e53)] - [#852](https://github.com/handshake-org/hsd/pull/852) - **txdb**: fix conflict event bug. - (@nodech - Nodari Chkuaselidze and @braydonf - Braydon Fuller)
  - \[[`7fe7ce41`](https://github.com/handshake-org/hsd/commit/7fe7ce41)] - [#555](https://github.com/handshake-org/hsd/pull/555) - **namestate**: improve "stats" object for transfers, expiry and revoke - (@pinheadmz - Matthew Zipkin and @nodech - Nodari Chkuaselidze)
  - \[[`2ede2c29`](https://github.com/handshake-org/hsd/commit/2ede2c29)] - [#851](https://github.com/handshake-org/hsd/pull/851) - **pkg**: update bdb to 1.5.1 and use @handshake-org/bfilter. - (@nodech - Nodari Chkuaselidze)
  - \[[`4e87fb1d`](https://github.com/handshake-org/hsd/commit/4e87fb1d)] - [#850](https://github.com/handshake-org/hsd/pull/850) - **script**: add redundant tests to math ops. - (@nodech - Nodari Chkuaselidze)
  - \[[`ab611036`](https://github.com/handshake-org/hsd/commit/ab611036)] - [#849](https://github.com/handshake-org/hsd/pull/849) - **pkg**: ci no longer update npm on build. - (@nodech - Nodari Chkuaselidze)
  - \[[`61ae19c2`](https://github.com/handshake-org/hsd/commit/61ae19c2)] - [#844](https://github.com/handshake-org/hsd/pull/844) - **docs**: backport release schedule and v6.x notes. - (@nodech - Nodari Chkuaselidze)
  - \[[`9b70c294`](https://github.com/handshake-org/hsd/commit/9b70c294)] - [#910](https://github.com/handshake-org/hsd/pull/910) - **net**: remove unstable seed. (@nodech - Nodari Chkuaselidze)

# v7.0.1
## Changelog
  - \[[`36899e2a`](https://github.com/handshake-org/hsd/commit/9b70c294)] - [#914](https://github.com/handshake-org/hsd/pull/914) - **net**: Add checkpoint between 160k and 225k. (@nodech - Nodari Chkuaselidze)
