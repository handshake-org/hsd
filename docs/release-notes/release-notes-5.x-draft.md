v5.x Release notes
==================

<!-- toc -->

- [v5.0](#v50)
  * [How to Upgrade](#how-to-upgrade)
  * [Notable Changes](#notable-changes)
    + [Node changes](#node-changes)
    + [Wallet changes](#wallet-changes)
  * [Changelog](#changelog)

<!-- tocstop -->

# v5.0
## How to Upgrade
  When upgrading to this version from **hsd v4.x** you must pass `--wallet-migrate=2` when you run it for the first time (**MAJOR** [#769](https://github.com/handshake-org/hsd/pull/769)).

## Notable Changes
### Node changes
  - HTTP API endpoint `/` (`hsd-cli getinfo`) now includes "public" networking settings ([#696](https://github.com/handshake-org/hsd/pull/696)).

  - RPCs `getnameinfo` `getnameresource` `verifymessagewithname` and `getnamebyhash`
  now accept an additional boolean parameter `safe` which will resolve the name from the Urkel
  tree at the last "safe height" (committed tree root with > 12 confirmations). SPV
  nodes can use this option and retrieve Urkel proofs from the p2p network to respond
  to these calls. ([#647](https://github.com/handshake-org/hsd/pull/647))

  - New RPC methods:
    - `decoderesource` like `decodescript` accepts hex string as input and returns
    JSON formatted DNS records resource. ([#719](https://github.com/handshake-org/hsd/pull/719))

### Wallet changes
  - HTTP Changes:
    - Wallet and account create methods now accept `lookahead` values up to `2^32 - 1` (**MAJOR** [#769](https://github.com/handshake-org/hsd/pull/769)).

  - New RPC methods:
    - `createbatch` and `sendbatch` create batch transactions with any number
    of outputs with any combination of covenants. ([#686](https://github.com/handshake-org/hsd/pull/686))

  - Updates related to nonces and blinds (**MAJOR** [#767](https://github.com/handshake-org/hsd/pull/767))
    - Multisig wallets will compute nonces based on the LOWEST public key in the group.
    This makes multiparty bidding and revealing more deteministic. Older versions would
    always use the wallet's OWN public key. To preserve compatability with older software:
      - RPC method `importnonce` now returns an array of blinds instead of a single blind.
      - HTTP endpoint `/wallet/:id/nonce/:name`'s response replaces 2 string fields (`nonce`, `blind`) with arrays of the same type (`nonces`, `blinds`)


## Changelog
  - \[[`7d00f353`](https://github.com/handshake-org/hsd/commit/7d00f353)] - [#769](https://github.com/handshake-org/hsd/pull/769) - **SEMVER-MAJOR wallet**: increase lookahead configuration to 2 ** 32. (@nodech - Nodari Chkuaselidze)
  - \[[`b456147e`](https://github.com/handshake-org/hsd/commit/b456147e)] - [#767](https://github.com/handshake-org/hsd/pull/767) - **SEMVER-MAJOR wallet**: derive all keys in generateNonce for multisig (@rithvikvibhu - Rithvik Vibhu)
  - \[[`bc4a6796`](https://github.com/handshake-org/hsd/commit/bc4a6796)] - [#768](https://github.com/handshake-org/hsd/pull/768) - **SEMVER-MINOR mempool**: reject TXs that exceed consensus covenant block limits (@pinheadmz - Matthew Zipkin)
  - \[[`455bf60f`](https://github.com/handshake-org/hsd/commit/455bf60f)] - [#785](https://github.com/handshake-org/hsd/pull/785) - **SEMVER-MINOR net**: update seeds and checkpoint for 5.x (@pinheadmz - Matthew Zipkin)
  - \[[`a747dc8d`](https://github.com/handshake-org/hsd/commit/a747dc8d)] - [#686](https://github.com/handshake-org/hsd/pull/686) - **SEMVER-MINOR wallet**: create batch transactions with any combination of covenants (@pinheadmz - Matthew Zipkin)
  - \[[`3fd74e0d`](https://github.com/handshake-org/hsd/commit/3fd74e0d)] - [#696](https://github.com/handshake-org/hsd/pull/696) - **SEMVER-MINOR node-http**: Clarify ports / public ports in node HTTP getinfo (@pinheadmz - Matthew Zipkin)
  - \[[`49bf5f49`](https://github.com/handshake-org/hsd/commit/49bf5f49)] - [#647](https://github.com/handshake-org/hsd/pull/647) - **SEMVER-MINOR rpc/pool**: use urkel proofs for namestate in spv mode (@pinheadmz - Matthew Zipkin)
  - \[[`5a23a5b5`](https://github.com/handshake-org/hsd/commit/5a23a5b5)] - [#719](https://github.com/handshake-org/hsd/pull/719) - **SEMVER-MINOR node-rpc**: decoderesource (@pinheadmz - Matthew Zipkin)
  - \[[`6f112121`](https://github.com/handshake-org/hsd/commit/6f112121)] - [#764](https://github.com/handshake-org/hsd/pull/764) - **wallet**: Follow-up improvements to sendbatch API, renew all (@pinheadmz - Matthew Zipkin)
  - \[[`6314c1aa`](https://github.com/handshake-org/hsd/commit/6314c1aa)] - [#788](https://github.com/handshake-org/hsd/pull/788) - **mempool**: Mempool reorg covenants (@pinheadmz - Matthew Zipkin)
  - \[[`bf614e0d`](https://github.com/handshake-org/hsd/commit/bf614e0d)] - [#706](https://github.com/handshake-org/hsd/pull/706) - **pool/wallet/spvnode**: test imported names are added to filter and sent (@pinheadmz - Matthew Zipkin)
  - \[[`b19d0017`](https://github.com/handshake-org/hsd/commit/b19d0017)] - [#790](https://github.com/handshake-org/hsd/pull/790) - **pkg**: Update package dependencies. (@nodech - Nodari Chkuaselidze)
  - \[[`99f43d21`](https://github.com/handshake-org/hsd/commit/99f43d21)] - [#739](https://github.com/handshake-org/hsd/pull/739) - **docs**: Update release process. (@nodech - Nodari Chkuaselidze)
  - \[[`185b459a`](https://github.com/handshake-org/hsd/commit/185b459a)] - [#789](https://github.com/handshake-org/hsd/pull/789) - **docs**: Backport v4 release docs (@nodech - Nodari Chkuaselidze)
  - \[[`862cba0d`](https://github.com/handshake-org/hsd/commit/862cba0d)] - [#771](https://github.com/handshake-org/hsd/pull/771) - **test**: Chain reset/reorg tests for tree/txn state (@nodech - Nodari Chkuaselidze)
  - \[[`309df94a`](https://github.com/handshake-org/hsd/commit/309df94a)] - [#787](https://github.com/handshake-org/hsd/pull/787) - **pkg**: Update minimum required Node.js version to 14 - (@handshake-enthusiast)
  - \[[`234a5974`](https://github.com/handshake-org/hsd/commit/234a5974)] - [#784](https://github.com/handshake-org/hsd/pull/784) - **wallet**: use correct fee in rpc gettransaction (@rithvikvibhu - Rithvik Vibhu)
  - \[[`eb5e6a82`](https://github.com/handshake-org/hsd/commit/eb5e6a82)] - [#778](https://github.com/handshake-org/hsd/pull/778) - **wallet**: Remove Coinselector.MAX_FEE (@pinheadmz - Matthew Zipkin)
  - \[[`e07ba542`](https://github.com/handshake-org/hsd/commit/e07ba542)] - [#781](https://github.com/handshake-org/hsd/pull/781) - **wallet**: Ignore unknown bids during reveal (@pinheadmz - Matthew Zipkin)
  - \[[`1326351c`](https://github.com/handshake-org/hsd/commit/1326351c)] - [#779](https://github.com/handshake-org/hsd/pull/779) - **hostlist**: only return MANUAL addrs in getLocal() for all networks (@pinheadmz - Matthew Zipkin)
  - \[[`9cf8cb83`](https://github.com/handshake-org/hsd/commit/9cf8cb83)] - [#776](https://github.com/handshake-org/hsd/pull/776) - **docker/docs**: Fix npm warning (@NetOpWibby)
  - \[[`395878a0`](https://github.com/handshake-org/hsd/commit/395878a0)] - [#775](https://github.com/handshake-org/hsd/pull/775) - **docs**: fix doc (@Falci - Fernando Falci)
  - \[[`fb5501c5`](https://github.com/handshake-org/hsd/commit/fb5501c5)] - [#765](https://github.com/handshake-org/hsd/pull/765) - **chore(BIP39)**: added Portuguese wordlist (@Falci - Fernando Falci)
