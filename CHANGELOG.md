# HSD Release Notes & Changelog

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
