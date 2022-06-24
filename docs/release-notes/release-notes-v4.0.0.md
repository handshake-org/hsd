v4.0.0 Release notes
==================

<!-- toc -->

- [v4.0](#v40)
  * [How to Upgrade](#how-to-upgrade)
  * [Notable Changes](#notable-changes)
    + [Node and Chain](#node-and-chain)
    + [Wallet changes](#wallet-changes)
    + [DNS](#dns)
  * [Changelog](#changelog)

<!-- tocstop -->

# v4.0
## How to Upgrade
  When upgrading to this version from **hsd v3.x** you must pass `--chain-migrate=3` when you run it for the first time.
  If you are upgrading from **hsd v2.x**, then you also need to pass `--wallet-migrate=1`.

## Notable Changes
### Urkel Tree Compaction
  `FullNode` parses new configuration option `--compact-tree-on-init` and `--compact-tree-init-interval` which will compact the Urkel Tree when the node first opens, by deleting historical data. It will try to compact it again after `tree-init-interval` has passed. Compaction will keep up to the last 288 blocks worth of tree data on disk (7-8 tree intervals) exposing the node to a similar deep reorganization vulnerability as a chain-pruning node. [#669](https://github.com/handshake-org/hsd/pull/669)
  
  This feature is disabled by default. Similar to `prune` option of the FullNode, **this will limit the reorganization ability of the node** but will save disk space. Different from `prune`, this does not happen retroactively given the nature of the Urkel Tree, that's why it is called `compaction` which is better term for it. If enabled, compaction will only happen when node starts/restarts. To enable use `--compact-tree-on-init`.
  
  After compaction next compaction will run after `--compact-tree-init-interval` blocks have passed and it will also only trigger after start/restart. By default it is set to `10 000` blocks.  
  Example: `hsd --compact-tree-on-init --compact-tree-init-interval=10000` - this is tree compaction enabled handshake node.
  
| Height  | Full Tree Size(no reorg) | Compacted Size |
| ------  | ------------------------ | -------------- |
| 100 000 | 6.73 GB                  | 511.37 MB      |
| 105 000 | 8.04 GB                  | 597.22 MB      |
| 110 000 | 9.89 GB                  | 727.02 MB      |
| 115 000 | 11.78 GB                 | 859.22 MB      |
| 120 000 | 13.40 GB                 | 976.03 MB      |

*Note: Compaction time depends on the compacted size, not the full tree size.*
  

### Node and Chain
  - `FullNode` and `SPVNode` now accept the option `--agent` which **adds** a string to the user-agent of the node (which will already contain hsd version) and is sent to peers in the version packet. Strings must not contain slashes and total user-agent string must be less than 255 characters. [#710](https://github.com/handshake-org/hsd/pull/710)
    - Example: `hsd --agent=example` will give you node with agent: `/hsd:4.0.0-rc.1/example/`
  - Fix SPV node reorg sync issue. SPV will also check `MTP` and `time-too-new`. [#721](https://github.com/handshake-org/hsd/pull/721)
  - `hsd` will critically shutdown on Disk write failure or corruption. `FullNode` and `SPVNode` will emit `abort` event on these failures so embedders can use these events to clean up before shutdown. [#650](https://github.com/handshake-org/hsd/pull/650)
  - `hsd` will recover tree root cache to maintain consistent look up times later for the proof requests. (Making startup time slightly slower) [#726](https://github.com/handshake-org/hsd/pull/726)
  - Checkpoints up to `100000` block. [#734](https://github.com/handshake-org/hsd/pull/734)
  - Fix blockstore atomicity issue, resolves rare **Block not found** issue when process is killed during write. [#688](https://github.com/handshake-org/hsd/pull/688)
  - remove inflation bug softfork covert signaling. [#654](https://github.com/handshake-org/hsd/pull/654)

### Wallet changes
  - WalletDB will emit `block connect` events with chainEntry and txs. Note: txs don't belong to specific wallet but walletdb. It will also emit `block disconnect` events with chainEntry. [#707](https://github.com/handshake-org/hsd/pull/707)
  - Fix `signmessage` during REVEAL [#679](https://github.com/handshake-org/hsd/pull/679)

### DNS
  - fix negative answers & add non-existence proofs for _synth. [#673](https://github.com/handshake-org/hsd/pull/673)
      
## Changelog
 - \[[`ba949f34`](https://github.com/handshake-org/hsd/commit/ba949f34)] - [#669](https://github.com/handshake-org/hsd/pull/669) - **SEMVER-MAJOR chain**:[consensus] Enable Urkel Tree compaction. (@pinheadmz - Matthew Zipkin & @nodech - Nodari Chkuaselidze)
 - \[[`c1f90eb6`](https://github.com/handshake-org/hsd/commit/c1f90eb6)] - [#726](https://github.com/handshake-org/hsd/pull/726) - **SEMVER-MAJOR chain**: Update urkel and recover root cache on start. (@nodech - Nodari Chkuaselidze)
 - \[[`89077ba9`](https://github.com/handshake-org/hsd/commit/89077ba9)] - [#721](https://github.com/handshake-org/hsd/pull/721) - **SEMVER-MAJOR chain**: SPV Updates. (@pinheadmz - Matthew Zipkin & @nodech - Nodari Chkuaselidze)
 - \[[`03a306b9`](https://github.com/handshake-org/hsd/commit/03a306b9)] - [#734](https://github.com/handshake-org/hsd/pull/734) - **SEMVER-MINOR protocol**: add checkpoint at height 100000 (Dec 2021) (@pinheadmz - Matthew Zipkin)
 - \[[`febc91c8`](https://github.com/handshake-org/hsd/commit/febc91c8)] - [#707](https://github.com/handshake-org/hsd/pull/707) - **SEMVER-MINOR wallet**: emit 'block connect' events. (@rithvikvibhu - Rithvik Vibhu)
 - \[[`dfccf4ef`](https://github.com/handshake-org/hsd/commit/dfccf4ef)] - [#650](https://github.com/handshake-org/hsd/pull/650) - **SEMVER-MINOR chain**: Gracefully shut down node on critical errors like full disk. (@pinheadmz - Matthew Zipkin & @nodech - Nodari Chkuaselidze)
 - \[[`7822f572`](https://github.com/handshake-org/hsd/commit/7822f572)] - [#743](https://github.com/handshake-org/hsd/pull/743) - **SEMVER-MAJOR chain**: Continue compaction on restart if node quit. (@nodech - Nodari Chkuaselidze)
 - \[[`925db38a`](https://github.com/handshake-org/hsd/commit/925db38a)] - [#735](https://github.com/handshake-org/hsd/pull/735) - **ci**: add macos to the test matrix. (@nodech - Nodari Chkuaselidze)
 - \[[`e33ed104`](https://github.com/handshake-org/hsd/commit/e33ed104)] - [#733](https://github.com/handshake-org/hsd/pull/733) - **net**: update seeds. (@pinheadmz - Matthew Zipkin)
 - \[[`e77546c9`](https://github.com/handshake-org/hsd/commit/e77546c9)] - [#710](https://github.com/handshake-org/hsd/pull/710) - **net**: propagate the user agent from node to pool. (@Falci - Fernando Falci & @pinheadmz - Matthew Zipkin)
 - \[[`a53f8775`](https://github.com/handshake-org/hsd/commit/a53f8775)] - [#723](https://github.com/handshake-org/hsd/pull/723) - **net**: default host update. (@nodech - Nodari Chkuaselidze)
 - \[[`f28fb9ed`](https://github.com/handshake-org/hsd/commit/f28fb9ed)] - [#715](https://github.com/handshake-org/hsd/pull/715) - **ci(tests)**: Update nodejs versions (@Falci - Fernando Falci)
 - \[[`35ea46d8`](https://github.com/handshake-org/hsd/commit/35ea46d8)] - [#709](https://github.com/handshake-org/hsd/pull/709) - **docs**: Removed browser folder and minor JSDoc changes. (@Anunayj - Anunay Jain)
 - \[[`62134608`](https://github.com/handshake-org/hsd/commit/62134608)] - [#692](https://github.com/handshake-org/hsd/pull/692) - **net**: Network tests & updates. (@nodech Nodari Chkuaselidze, @rsmarples - Roy Marples & @kilpatty - Sean Kilgarriff)
 - \[[`084b3f01`](https://github.com/handshake-org/hsd/commit/084b3f01)] - [#663](https://github.com/handshake-org/hsd/pull/663) - **docs**: Release process. (@nodech - Nodari Chkuaselidze)
 - \[[`107ed2be`](https://github.com/handshake-org/hsd/commit/107ed2be)] - [#693](https://github.com/handshake-org/hsd/pull/693) - **test**: wallet unit tests. (@pinheadmz - Matthew Zipkin & @nodech - Nodari Chkuaselidze)
 - \[[`888228a5`](https://github.com/handshake-org/hsd/commit/888228a5)] - [#691](https://github.com/handshake-org/hsd/pull/691) - **test**: Added more tests to NOINPUT implementation. (@Anunayj - Anunay Jain)
 - \[[`a7e937cc`](https://github.com/handshake-org/hsd/commit/a7e937cc)] - [#688](https://github.com/handshake-org/hsd/pull/688) - **blockstore**: separate write and prune batches. (@nodech - Nodari Chkuaselidze)
 - \[[`3f8ab846`](https://github.com/handshake-org/hsd/commit/3f8ab846)] - [#685](https://github.com/handshake-org/hsd/pull/685) - **http**: add localhost to no-auth list. (@lukeburns - Luke Burns)
 - \[[`df997a4c`](https://github.com/handshake-org/hsd/commit/df997a4c)] - [#687](https://github.com/handshake-org/hsd/pull/687) - **test**: use fixed size 2 for workerpool. (@nodech - Nodari Chkuaselidze)
 - \[[`34a3b00e`](https://github.com/handshake-org/hsd/commit/34a3b00e)] - [#683](https://github.com/handshake-org/hsd/pull/683) - **wallet, covenants**: refactor: Use namestate methods for state comparison. (@Falci - Fernando Falci)
 - \[[`64e39a5c`](https://github.com/handshake-org/hsd/commit/64e39a5c)] - [#679](https://github.com/handshake-org/hsd/pull/679) - **node-rpc, wallet-rpc**: Can't sign/verify with name before auction is closed. (@Falci - Fernando Falci)
 - \[[`f3e7f810`](https://github.com/handshake-org/hsd/commit/f3e7f810)] - [#656](https://github.com/handshake-org/hsd/pull/656) - **lint**: Cleanup test eslint configs. (@nodech - Nodari Chkuaselidze)
 - \[[`b47b0296`](https://github.com/handshake-org/hsd/commit/b47b0296)] - [#671](https://github.com/handshake-org/hsd/pull/671) - **mempool**: reflect spent coins in mempool coinview. (@nodech - Nodari Chkuaselidze)
 - \[[`cadfa244`](https://github.com/handshake-org/hsd/commit/cadfa244)] - [#681](https://github.com/handshake-org/hsd/pull/681) - **ci**: Update coveralls action. (@Falci - Fernando Falci)
 - \[[`06aabfff`](https://github.com/handshake-org/hsd/commit/06aabfff)] - [#673](https://github.com/handshake-org/hsd/pull/673) - **dns**: fix negative answers & add non-existence proofs for _synth. (@buffrr - Buffrr)
 - \[[`1568a5c8`](https://github.com/handshake-org/hsd/commit/1568a5c8)] - [#678](https://github.com/handshake-org/hsd/pull/678) - **node-rpc**: clean up hex32 method. (@nodech - Nodari Chkuaselidze)
 - \[[`e99ad30e`](https://github.com/handshake-org/hsd/commit/e99ad30e)] - [#556](https://github.com/handshake-org/hsd/pull/556) - **chain**: fix consensus errors and comments. (@pinheadmz - Matthew Zipkin)
 - \[[`b8928ea7`](https://github.com/handshake-org/hsd/commit/b8928ea7)] - [#668](https://github.com/handshake-org/hsd/pull/668) - **chain**: Additional Logging During Tree Sync. (@dills122 - Dylan Steele)
 - \[[`e1d3969a`](https://github.com/handshake-org/hsd/commit/e1d3969a)] - [#670](https://github.com/handshake-org/hsd/pull/670) - **wallet-http**: Export HTTP.TransactionOptions. (@wi-ski - Will Dembinski)
 - \[[`eea15c2f`](https://github.com/handshake-org/hsd/commit/eea15c2f)] - [#657](https://github.com/handshake-org/hsd/pull/657) - **test**: Wallet record tests. (@nodech - Nodari Chkuaselidze)
 - \[[`c62293f1`](https://github.com/handshake-org/hsd/commit/c62293f1)] - [#654](https://github.com/handshake-org/hsd/pull/654) - **node/miner**: remove inflation bug softfork covert signaling. (@pinheadmz - Matthew Zipkin)
 - \[[`b77fc54e`](https://github.com/handshake-org/hsd/commit/b77fc54e)] - [#634](https://github.com/handshake-org/hsd/pull/634) - **README**: switch IRC link to libera. (@pinheadmz - Matthew Zipkin)
 - \[[`b5b70e84`](https://github.com/handshake-org/hsd/commit/b5b70e84)] - [#655](https://github.com/handshake-org/hsd/pull/655) - **net**: Add net tests and fix unknown packets. (@nodech - Nodari Chkuaselidze)
 - \[[`a4dcbdac`](https://github.com/handshake-org/hsd/commit/a4dcbdac)] - [#661](https://github.com/handshake-org/hsd/pull/661) - **docs**: Update security.md (@nodech - Nodari Chkuaselidze)
 - \[[`3b83199e`](https://github.com/handshake-org/hsd/commit/3b83199e)] - [#653](https://github.com/handshake-org/hsd/pull/653) - **test**: sighash_noinput is not implemented correctly. (@pinheadmz - Matthew Zipkin)
 - \[[`e8c9632c`](https://github.com/handshake-org/hsd/commit/e8c9632c)] - [#652](https://github.com/handshake-org/hsd/pull/652) - **dockerfile**: upgrade use node v14. (@skottler - Sam Kottler)
 - \[[`37731e63`](https://github.com/handshake-org/hsd/commit/37731e63)] - [#640](https://github.com/handshake-org/hsd/pull/640) - **ci**: Add node v16 to ci matrix, and remove v10. (@Anunayj - Anunay Jain)
 - \[[`7c00f019`](https://github.com/handshake-org/hsd/commit/7c00f019)] - [#742](https://github.com/handshake-org/hsd/pull/742) - **test**: Update urkel and fix grindName tests. (@nodech - Nodari Chkuaselidze)
