# HSD Release Notes & Changelog

## unreleased

### Wallet API changes

- Adds new wallet rpc `getblindvalue` and HTTP endpoint `GET /wallet/:id/blindvalue/:blind`
which accept a blind (hash) and returns a `BlindValue` in JSON format if it is found in the txdb.

## v2.0.0

### Wallet API changes

- Creating a watch-only wallet now requires an `account-key` (or `accountKey`)
argument. This is to prevent hsd from generating keys and addresses the user
can not spend from.

## v0.0.0

### Notable Changes

- Initial tagged release.
