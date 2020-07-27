# HSD Release Notes & Changelog

## unreleased

### Node API changes

- A new RPC call `validateresource` was added to validate Handshake `Resource`
JSON and will return an error message on an invalid `Resource`. The input JSON
object is the format expected by `rpc sendupdate`.

- A new RPC call `getdnssecproof` was added to build and return the DNSSEC
proof used for reserved name claims. This can be used to test if a reserved
name is ready for a CLAIM.

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
