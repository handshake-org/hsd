# HSKD

**HSKD** is an implementation of the [Handshake][handshake] Protocol.

## Install

```
$ git clone git://github.com/handshake-org/hskd.git
$ cd hskd
$ npm install
$ ./bin/hskd
```

See the [Beginner's Guide][guide] for more in-depth installation instructions.

## Documentation

- API Docs: http://handshake.org/docs/
- REST Docs: http://handshake.org/api-docs/index.html
- Docs: [docs/](docs/README.md)

## Testnet

A testnet is currently running as of June 19th.

Current testnet seed nodes (`pubkey@ip`):

- `aoihqqagbhzz6wxg43itefqvmgda4uwtky362p22kbimcyg5fdp54@173.255.248.12`
- `ajdzrpoxsusaw4ixq4ttibxxsuh5fkkduc5qszyboidif2z25i362@66.175.217.103`
- `ajk57wutnhfdzvqwqrgab3wwh4wxoqgnkz4avbln54pgj5jwefcts@45.56.92.136`
- `am2lsmbzzxncaptqjo22jay3mztfwl33bxhkp7icfx7kmi5rvjaic@45.56.82.169`

Current public DNS servers:

- 173.255.248.12 - Recursive Server 1.
- 66.175.217.103 - Authoritative Server 1.
- 45.56.92.136 - Recursive Server 2.
- 45.56.82.169 - Authoritative Server 2.

Example:

``` bash
$ dig @173.255.248.12 google.com A +short
172.217.0.46
```

``` bash
$ dig @66.175.217.103 com NS
...
;; AUTHORITY SECTION:
com.                    86400   IN      NS      a.gtld-servers.net.
com.                    86400   IN      NS      b.gtld-servers.net.
com.                    86400   IN      NS      c.gtld-servers.net.
...
```

## Quickstart

### Unbound support

HSKD currently has a built-in recursive resolver written in javascript,
however, for the best performance and best DNS conformance, HSKD also includes
native bindings to `libunbound` -- to make use of this, be sure to have
`unbound` installed on your system _before_ installing `hskd`.

### Booting with a local recursive and authoritative nameserver

By default HSKD will listen on an authoritative and recursive nameserver (ports
`15359` and `15360` respectively). To configure this:

``` bash
# Have the authoritative server listen on port 5300.
$ hskd --ns-port 5300

# Have the recursive server listen on port 53.
$ hskd --rs-host 0.0.0.0 --rs-port 53 # Warning: public!
```

Your localhost should now be diggable:

``` bash
$ dig @127.0.0.1 www.ietf.org +dnssec
$ dig @127.0.0.1 -p 5300 org +dnssec
```

### Mining

To mine with getwork on a GPU, HSKD should be used in combination with
[hsk-miner] and [hsk-client].

``` bash
# HSKD must boot with a coinbase address (`$ hwallet account get default`).
$ hskd --http-host '::' --api-key 'hunter2' \
  --coinbase-address 'ts1qsu62stru80svj5xk6mescy65v0lhg8xxtweqsr'
```

Once HSKD is running, we can run [hsk-miner] on a machine with a CUDA-capable
GPU and point it at our full node.

``` bash
$ hsk-miner --rpc-host 'my-ip-address' \
  --rpc-user bitcoinrpc --rpc-pass 'hunter2'
```

### Auctions

First we should look at the current status of a name we want.

``` bash
$ hsk-cli rpc getnameinfo handshake
```

Once we know the name is biddable, we can send a bid, with a lockup-value to
conceal our true bid.

``` bash
# Send a bid of 5 coins, with a lockup value of 10 coins.
$ hwallet-cli rpc sendbid handshake 5 10
```

After the appropriate amount of time has passed, (1 day in the case of
testnet), we should reveal our bid (note, revealing early is allowed!).

``` bash
# Reveal our bid for handshake
$ hwallet-cli rpc sendreveal handshake
```

We can continue monitoring the status, now with the wallet's version of
getnameinfo:

``` bash
$ hwallet-cli getnameinfo handshake
# To see other bids and reveals
$ hwallet-cli getauctioninfo handshake
```

If we end up losing, we can redeem our money from the covenant with
`$ hwallet-cli rpc sendredeem handshake`.

If we won, we can now register and update the name using `sendupdate`.

``` bash
$ hwallet-cli sendupdate handshake \
  '{"ttl":3600,"ns":["ns1.myserver.net.@1.2.3.4"]}'
```

Note that the `ns` field's `domain@ip` format symbolizes glue.

Expiration on testnet is around 30 days, so be sure to send a renewal soon!

``` bash
$ hwallet-cli sendrenewal handshake
```

### RPC Calls

Several RPC calls have been exposed in addition to the standard bitcoind-style
RPC.

#### Node Calls

All node calls should be made with `$ hsk-cli rpc [call] [arguments...]`.

- `isnameavailable [name]` - Returns true or false.
- `getnameinfo [name]` - Returns name and auction status.
- `getnameresource [name]` - Returns parsed DNS-style resource.
- `getnameproof [name]` - Returns a JSON-ified [urkel] proof of a name.
- `getnamebyhash [hex-hash]` - Returns the name hash preimage.

#### Wallet Calls

All wallet calls should be made with `$ hwallet-cli rpc [call] [arguments...]`.

- `getbids [name]` - List own bids on a name.
- `getauctions` - List all watched auctions and their statuses.
- `getauctioninfo [name]` - Returns auction info, along with all bids and
  reveals.
- `getnameinfo [name]` - Returns name info, similar to the node call above.
- `getnameresource [name]` - Returns parsed DNS-style resource.
- `getnamebyhash [hex-hash]` - Returns the name hash preimage.
- `sendclaim [name]` - Claim a name (only possible with the claimant key).
- `sendbid [name] [bid-value] [lockup-value]` - Open a bid on a name.
- `sendreveal [name]` - Reveal bids for name.
- `sendredeem [name]` - Redeem reveals in the case of an auction loss.
- `sendupdate [name] [json-data]` - Register or update a name.
- `sendrenewal [name]` - Renew a name.
- `sendtransfer [name] [address]` - Transfer name to another address.
- `sendcancel [name]` - Cancel an in-progress transfer.
- `sendfinalize [name]` - Finalize a transfer.
- `sendrevoke [name]` - Revoke a name.
- `importnonce [name] [address] [bid-value]` - Deterministically regenerate a
  bid's nonce.

## Support

Join us on [freenode][freenode] in the [#handshake][irc] channel.

## Disclaimer

HSKD does not guarantee you against theft or lost funds due to bugs, mishaps,
or your own incompetence. You and you alone are responsible for securing your
money.

## Contribution and License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## License

- Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).

See LICENSE for more info.

[handshake]: https://handshake.org/
[guide]: https://github.com/handshake-org/hskd/blob/master/docs/Beginner's-Guide.md
[freenode]: https://freenode.net/
[irc]: irc://irc.freenode.net/handshake
[changelog]: https://github.com/handshake-org/hskd/blob/master/CHANGELOG.md
[hnsd]: https://github.com/handshake-org/hnsd
[hsk-miner]: https://github.com/handshake-org/hsk-miner
[hsk-client]: https://github.com/handshake-org/hsk-client
