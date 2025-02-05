# HSD Release Notes & Changelog

## Unreleased

### Wallet Changes

#### Wallet HTTP API
  - `POST /wallet/:id/zap` response object has a new property: `zapped: number`,
    indicating the number of transactions that were zapped.
  - `GET /wallet/:id/name/:name` now accepts an `own` parameter and only returns
    the namestate when the wallet owns the name.

#### Wallet/WalletDB API
  - `Wallet.zap` now returns the number of transactions zapped instead of their hashes.

#### hs-client Wallet
  - `getName` now accepts an `options` object with an `own` property.


## v7.0.0

**When upgrading to this version of hsd, you must pass `--wallet-migrate=5` when
you run it for the first time.**

### Primitives
- TX Changes:
  - tx.test no longer updates the filter.
  - Introduce TX.testAndMaybeUpdate method for potentially updating filter while
    testing. (old tx.test)

### Node Changes
  Add support for the interactive rescan, that allows more control over rescan
process and allows parallel rescans.

#### Node HTTP API
  - `GET /` or `getInfo()` now has more properties:
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
  - Add `get median time` hook to get median time past for a blockhash.
  - Add `get entries` hook to get entries. Similar to `get hashes`, but returns
    encoded entries.

### hs-client Node
  - Introduce `scanInteractive` method that starts interactive rescan.
    - expects ws hook for `block rescan interactive` params `rawEntry, rawTXs`
      that returns scanAction object.
    - expects ws hook for `block rescan interactive abort` param `message`.
  - Add `getMempoolRejectionFilter` and `checkMempoolRejectionFilter` NodeClient
  aliases.
  - Add `getFee`, an HTTP alternative to estimateFee socket call.
  - Adds `getEntries(start, end)` that returns encoded chain entries.

### Wallet Changes
- Add migration that recalculates txdb balances to fix any inconsistencies.
- Wallet will now use `interactive scan` for initial sync(on open) and rescan.

#### Configuration
- Wallet now has option `wallet-migrate-no-rescan`/`migrate-no-rescan` if you
  want to disable rescan when migration recommends it. It may result in the
  incorrect txdb state, but can be useful if you know the issue does not affect
  your wallet or is not critical.
- Add `--wallet-preload-all` (or `--preload-all` for standalone wallet node)
  that will open all wallets before starting other services (e.g. HTTP).
  By default this is set to `false`.
- Add `--wallet-max-history-txs` (or `--max-history-txs` for standalone wallet
  node) that will be the hard limit of confirmed and unconfirmed histories.

#### Wallet API

- WalletNode now emits `open` and `close` events.
- WalletDB Now emits events for: `open`, `close`, `connect`, `disconnect`.
- WalletDB
  - `open()` no longer calls `connect` and needs separate call `connect`.
  - `open()` no longer calls scan, instead only rollbacks and waits for
    sync to do the rescan.
  - emits events for: `open`, `close`, `connect`, `disconnect`, `sync done`.
  - Wallet now has additional methods for quering history:
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
    exact fee.
  - All transaction sending endpoints now fundlock/queue tx creation. (no more
    conflicting transactions)
  - Add options to `getNames` for passing `own`.
  - Rename `createAuctionTxs` to `createAuctionTXs`.
  - All `bid` serializations will include `height` of the bid. (`-1` if
    it was migrated not-owned bid)
    - `GET /wallet/:id/auction` (`getAuctions`)
    - `GET /wallet/:id/auction/:name` (`getAuctionByName`)
    - `GET /wallet/:id/bid` (`getBids`)
    - `GET /wallet/:id/bid/:name` (`getBidsByName`)
  - All `reveal` serializations will include `bidPrevout` of the bid. (`null` if
  it was migrated not-owned reveal)
    - `GET /wallet/:id/auction` (`getAuctions`)
    - `GET /wallet/:id/auction/:name` (`getAuctionByName`)
    - `GET /wallet/:id/reveal` (`getReveals`)
    - `GET /wallet/:id/reveal/:name` (`getRevealsByName`)
  - `GET /wallet/:id/tx/history` - The params are now `time`, `after`,
  `limit`, and `reverse`.
  - `GET /wallet/:id/tx/unconfirmed` - The params are are same as above.

These endpoints have been deprecated:
  - `GET /wallet/:id/tx/range` - Instead use the `time` param for the history and
    unconfirmed endpoints.
  - `GET /wallet/:id/tx/last` - Instead use `reverse` param for the history and
    unconfirmed endpoints.

##### Examples

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

The following new methods have been added:
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

The following methods have been deprecated:

- `listtransactions` - Use `listhistory` and the related methods and the
  `after` argument for results that do not shift when new blocks arrive.

##### Wallet CLI (hsw-cli)
  - `history` now accepts new args on top of `--account`: `--reverse`,
    `--limit`, `--after`, `--after`.
  - `pending` now accepts new args, same as above.


### Client changes
#### Wallet HTTP Client

  - `getHistory` and `Wallet.getHistory` no longer accept `account`,
    instead accepts object with properties: `account`, `time`, `after`,
    `limit`, and `reverse`.
  - `getPending` and `Wallet.getPending` have the same changes as
    `getHistory` above.

## v6.0.0

### Node and Wallet HTTP API
  Validation errors, request paremeter errors or bad HTTP requests will no
longer return (and log) `500` status code, instead will return `400`.

### Wallet Changes
#### Configuration
  `hsd.conf` can now be used to define wallet options, when wallet is running as
a plugin. Configurations with `wallet-` prefix will be passed to the wallet.
`hsd.conf` wont be used if the wallet is running in standalone mode.

- Remove `check-lookahead` option from walletdb.

#### Wallet API

- HTTP Changes:
  - `/wallet/:id/open` no longer accepts `force` flag. (it was not used)
- RPC Changes:
  - `createopen` and `sendopen` no longer accept `force` as an argument. (was not used)
  - Introduce new API to modify account: `PATCH /wallet/:id/account/:account`.

## v5.0.0

**When upgrading to this version of hsd, you must pass `--wallet-migrate=2` when
you run it for the first time.**

### Node API changes

- HTTP API endpoint `/` (`hsd-cli getinfo`) now includes "public" networking settings.

- RPCs `getnameinfo` `getnameresource` `verifymessagewithname` and `getnamebyhash`
now accept an additional boolean parameter `safe` which will resolve the name
from the Urkel tree at the last "safe height" (committed tree root with > 12
confirmations). SPV nodes can use this option and retrieve Urkel proofs from the
p2p network to respond to these calls.

- New RPC methods:
  - `decoderesource` like `decodescript` accepts hex string as input and returns
  JSON formatted DNS records resource.

### Wallet changes

- HTTP Changes:
  - Wallet and account create methods now accept `lookahead` values up to `2^32 - 1`.

- New RPC methods:
  - `createbatch` and `sendbatch` create batch transactions with any number
  of outputs with any combination of covenants.

- Updates related to nonces and blinds
  - Multisig wallets will compute nonces based on the LOWEST public key in the
  group.
  This makes multiparty bidding and revealing more deteministic. Older versions
  would always use the wallet's OWN public key. To preserve compatability with
  older software:
    - RPC method `importnonce` now returns an array of blinds instead of a
    single blind.
    - HTTP endpoint `/wallet/:id/nonce/:name`'s response replaces 2 string
    fields (`nonce`, `blind`) with arrays of the same type (`nonces`, `blinds`)

## v4.0.0

**When upgrading to this version of hsd you must pass
`--chain-migrate=3` when you run it for the first time.**

### Node changes
 - `FullNode` and `SPVNode` now accept the option `--agent` which adds a string
  to the user-agent of the node (which will already contain hsd version) and is
  sent to peers in the version packet. Strings must not contain slashes and
  total user-agent string must be less than 255 characters.

  - `FullNode` parses new configuration option `--compact-tree-on-init` and
  `--compact-tree-init-interval` which will compact the Urkel Tree when the node
  first opens, by deleting historical data. It will try to compact it again
  after `tree-init-interval` has passed. Compaction will keep up to the last 288
  blocks worth of tree data on disk (7-8 tree intervals) exposing the node to a
  similar deep reorganization vulnerability as a chain-pruning node.

## v3.0.0

**When upgrading to this version of hsd you must pass
`--chain-migrate=2 --wallet-migrate=1` when you run it for the first time.**

### Database changes
  - Updated database versions and layout.
  - Separated migrations from WalletDB and ChainDB: [lib/migrations/README.md](./lib/migrations/README.md)
  - Blockstore update: The way that block data is stored has changed for greater
  performance, efficiency, reliability and portability. To upgrade to the new
  disk layout it's necessary to move block data from LevelDB
  (e.g. `~/.hsd/chain`) to a new file based block storage
  (e.g. `~./.hsd/blocks`). That will happen automatically with the migration
  flags.

### Wallet API changes

- New RPC methods:
  - `signmessagewithname`: Like `signmessage` but uses a name instead of an
    address. The owner's address will be used to sign the message.
  - `verifymessagewithname`: Like `verifymessage` but uses a name instead of an
    address. The owner's address will be used to verify the message.

- New wallet creation accepts parameter `language` to generate the mnemonic phrase.

- `rpc getbids` accepts a third parameter `unrevealed` _(bool)_ which filters the response by checking
the wallet's unspent coins database for each bid. If an unspent coin is found, the output address
of that coin is added to the JSON response. This is useful for wallet recovery scenarios
when users need to call `rpc importnonce` to repair unknown blinds. The complete usage is now
`rpc getbids name (own) (unrevealed)` so for example a wallet-recovering user would execute
`rpc getbids null true true`.

- Wallet RPC `getnames` (and HTTP endpoint `/wallet/:id/name`) now accept a
boolean parameter "own" (default: `false`) that filters out names the wallet does not own.

### DNS changes

- DNSSEC proofs from the root name server were fixed, particularly around non-existent
domains. The empty zone proofs were replaced with minimally covering NSEC records.

- `FullNode` and `SPVNode` parse new option `--no-sig0` which disables SIG0 signing
in the root nameserver and recursive resolver. The current SIG0 algorithm uses Blake2b
and is identified as `PRIVATEDNS` which is incompatible with most legacy DNS software.

### Other changes

- The logging module `blgr` has been updated. Log files will now be rolled over
at around 20 MB and timestamped. Only the last 10 log files will be kept on disk
and older log files will be purged. These values can be configured by passing
`--log-max-file-size` (in MB) and `--log-max-files`.

## v2.4.0

### Chain & Consensus changes

- A consensus inflation bug has been fixed. Non-upgraded miners should upgrade
  as soon as possible. See
  https://handshake.org/notice/2020-04-02-Inflation-Bug-Disclosure.html for
  more information.
- A new chain value migration is necessary (related to the above fix). This
  migration will automatically run on boot and should only take 2-3 minutes.
  Pruned nodes _cannot_ run this migration. Note that pruned nodes may have an
  incorrect chain value until they re-sync.

### Mining changes

- `getwork` has been fixed and improved. See
  https://github.com/handshake-org/hsd/pull/583.

### Wallet changes

- Fixes a bug that caused rescans to fail if a name being "watched" was ever
`TRANSFER`ed. A `deepclean` plus `rescan` may be required to fix affected wallets.

### DNS changes

- Root server DNSSEC has been fixed. It is only authoritative over DS and TXT records,
and only returns TXT if no NS (referral) is present in the zone.

### Node changes

- `FullNode` and `SPVNode` accept configuration parameter `--no-dns` (or `no-dns: true` in
`hsd.conf`) which launches the node without either DNS server (the root authoritative
server and the recursive resolver). This avoids some port collisions with other HNS resolvers
like hnsd running locally, and generally separates and reduces security concerns around
running unneeded servers when a node is just used for transactions and blocks.
`--no-rs` is also accepted to disable the recursive DNS resolver (but keep the root server).

### Wallet API changes

- Adds new wallet HTTP endpoint `/wallet/:id/auction` based on `POST /wallet/:id/bid`.
It requires an additional parameter `broadcastBid` set to either true or false.
This action returns a bid and its corresponding reveal, the reveal being prepared in advance.
The bid will be broadcasted either during the creation (`broadcastBid=true`) or at a later time
(`broadcastBid=false`).
The reveal will have to be broadcasted at a later time, during the REVEAL phase.
The lockup must include a blind big enough to ensure the BID will be the only input of the REVEAL
transaction.

- Now parses option `--wallet-check-lookahead` (or `--check-lookahead` for standalone
wallet node) that will check every account of every wallet in the DB and ensure
the lookahead value is the current default and maximum of `200`. A rescan is
recommended after this action.

### Node & Wallet API changes

- The `stats` field included in `namestate.toJSON()` includes extra data if the name
is in a TRANSFER state.

## v2.3.0

### Node changes

- `FullNode` now parses option `--min-weight=<number>` (`min-weight: <number>` in
hsd.conf or `minWeight: <number>` in JavaScript object instantiation).
When assembling a block template, if there are not enough fee-paying transactions available,
the miner will add transactions up to the minimum weight that would normally be
ignored for being "free" (paying a fee below policy limit). The default value is
raised from `0` to `5000` (a 1-in, 2-out BID transaction has a weight of about `889`).

- Transactions that have sat unconfirmed in the mempool for 3 days will be evicted.
This is the default `MEMPOOL_EXPIRY_TIME` value set in `policy.js` but can be
configured (in seconds) with the `FullNode` option `--mempool-expiry-time`.

### Wallet API changes

- Adds new wallet HTTP endpoint `/deepclean` that requires a parameter
`I_HAVE_BACKED_UP_MY_WALLET=true`. This action wipes out balance and transaction
history in the wallet DB but retains key hashes and name maps. It should be used
only if the wallet state has been corrupted by issues like the
[reserved name registration bug](https://github.com/handshake-org/hsd/issues/454)
or the
[locked coins balance after FINALIZE bug](https://github.com/handshake-org/hsd/pull/464).
After the corrupt data has been cleared, **a walletDB rescan is required**.

### Wallet changes

- Fixes a bug that ignored the effect of sending or receiving a FINALIZE on a
wallet's `lockedConfirmed` and `lockedUnconfirmed` balance.

## v2.2.0

### Upgrading

This version fixes a bug in the wallet that would corrupt the database if a user
manually generated change addresses using API commands. Upon running the updated
software for the first time, hsd will check for corruption and if there is none,
proceed with normal operation (no user interaction is required, although this
process may take a few minutes for a "busy" wallet). If the bug is detected,
hsd will throw an error and quit. To repair the wallet, the user must launch hsd
with an extra command-line flag, in addition to whatever parameters
they normally use:

`$ hsd --wallet-migrate=0` (for most users)

or `$ hs-wallet --migrate=0` (for remote wallet node)

These flags may be added to environment variables or a config file if desired,
following the pattern described in the
[configuration guide](https://hsd-dev.org/guides/config.html).

The repair may take a few minutes **and will automatically initiate a rescan**.
For this reason, the user's wallet MUST be connected to a full node (not a
pruned node or SPV node).

### Node API changes

- Adds a new node rpc `resetrootcache` that clears the root name server cache.

- A new RPC call `validateresource` was added to validate Handshake `Resource`
JSON and will return an error message on an invalid `Resource`. The input JSON
object is the format expected by `rpc sendupdate`.

- A new RPC call `getdnssecproof` was added to build and return the DNSSEC
proof used for reserved name claims. This can be used to test if a reserved
name is ready for a CLAIM.

- RPC calls that return tx outputs in JSON now include output addresses as a string
in addition to the version/hash pair.

- RPC methods `getblock` and `getblockheader` now return `confirmations: -1` if
the block is not in the main chain.

- A new HTTP endpoint `/header/:block` was added to retrieve a block header
by its hash or height.

### Wallet API changes

- Adds new wallet rpc `importname` that enables user to "watch" a name and track
its auction progress without bidding on it directly.

### Wallet changes

- A bug was fixed that prevented reserved names that had been CLAIMed from
REGISTERing. If unpatched software was used to CLAIM a name already, that wallet
database is irreversibly corrupted and must be replaced.
See https://github.com/handshake-org/hsd/issues/454

## v2.0.0

### Wallet API changes

Creating a watch-only wallet now requires an `account-key` (or `accountKey`)
argument. This is to prevent hsd from generating keys and addresses the user
can not spend from.

## v0.0.0

### Notable Changes

- Initial tagged release.
