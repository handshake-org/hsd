# HSD Release Notes & Changelog

## unreleased

### Wallet API changes

- Adds new wallet rpc `importname` that enables user to "watch" a name and track
its auction progress without bidding on it directly.

## v2.0.0

### Wallet API changes

Creating a watch-only wallet now requires an `account-key` (or `accountKey`)
argument. This is to prevent hsd from generating keys and addresses the user
can not spend from.

## v0.0.0

### Notable Changes

- Initial tagged release.
