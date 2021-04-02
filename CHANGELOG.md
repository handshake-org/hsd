# HSD Release Notes & Changelog

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

### Node API changes

- Adds new wallet HTTP endpoint `/deeprescan` that requires a parameter
`I_HAVE_BACKED_UP_MY_WALLET=true`. This action wipes out balance and transaction
history in the wallet DB but retains key hashes and name maps. It should be used
only if the wallet state has been corrupted by issues like the
[reserved name registration bug](https://github.com/handshake-org/hsd/issues/454)
or the
[locked coins balance after FINALIZE bug](https://github.com/handshake-org/hsd/pull/464).

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
