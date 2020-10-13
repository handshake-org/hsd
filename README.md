# HSD

[![Build Status][ci-status-img]][ci-status-url]
[![Coverage Status][coverage-status-img]][coverage-status-url]

__HSD__ is an implementation of the [Handshake][handshake] Protocol.

## Install

`hsd` requires Node.js v10 or higher


### Building From Source

```
$ git clone git://github.com/handshake-org/hsd.git
$ cd hsd
$ npm install --production
$ ./bin/hsd
```

Note that `node-gyp` must be installed. See the
[node-gyp](https://github.com/nodejs/node-gyp) documentation for more
information.

### Docker
#### Building an image

To build a Docker image with the name `hsd:<version>-<commit>`, run:

```bash
$ VERSION=$(cat package.json | grep version | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
$ COMMIT=$(git rev-parse --short HEAD)
$ docker build -t hsd:$VERSION-$COMMIT .
```

#### Running a container

To start a container named `hsd` on a `regtest` network with an exposed
node API server, run:

```bash
$ docker run --name hsd -p 14037:14037 hsd:$VERSION-$COMMIT \
    --network regtest \
    --http-host 0.0.0.0 \
    --api-key=foo
```

To test connectivity, curl the info endpoint:
```bash
$ curl http://x:foo@localhost:14037/
```

>Note: by default, none of the container's ports are exposed. Depending
on the network used for your node, you will need to expose the correct ports
for the node's various services (node http api, wallet http api, recursive
name server, authoritative name server, p2p protocol, encrypted p2p protocol).
The default ports can be found [here](./lib/protocol/networks.js). The DNS
servers must also expose a UDP port. The syntax is different from TCP and can
be found [here](https://docs.docker.com/config/containers/container-networking/#published-ports).

#### Stopping a container

To stop a container named `hsd`, run:

```bash
$ docker stop hsd
```

### npm

It is not recommended to install `hsd` from npm's repositories
but it is still possible to install with `npm` using a remote
`git` repository.

```
$ npm install -g https://github.com/handshake-org/hsd.git
```

A `git` ref can be used to install a particular version by appending
a `#` and the name of the `git` ref to the URL. For example,
`https://github.com/handshake-org/hsd.git#v2.2.0`. It is recommended
to use the [latest tagged release](https://github.com/handshake-org/hsd/releases).

If adding `hsd` as a dependency to a project, use the command:

```
$ npm install https://github.com/handshake-org/hsd.git
```

### macOS

`hsd` is available via [Homebrew](https://brew.sh). This will
install all required dependencies as well as `unbound`.

```
$ brew install hsd
```

## CLI

HSD comes with command-line interface tools `hsd-cli` (to interact with the node
server) and `hsw-cli` (to interact with the wallet server). These applications
are available in `./bin` (for example the command `./bin/hsd-cli info` returns
basic node info). CLI usage in the API docs refers to these applications.

When `hsd` is installed globally, CLI commands are available without the path:

```
$ hsd-cli info
```

RPC commands are available with `hsd-cli rpc <command>` and `hsw-cli rpc <command>`.
The shortcuts `hsd-rpc` and `hsw-rpc` are available if you install hs-client globally:

```
$ npm install -g hs-client
```

## Documentation

- Documentation Site: [https://hsd-dev.org](https://hsd-dev.org)
- API Docs: [https://hsd-dev.org/api-docs](https://hsd-dev.org/api-docs)
- JSDoc: [https://hsd-dev.org/docs](https://hsd-dev.org/docs)

## Contributing

Handshake is a community project, we welcome contributions of all kinds from
everyone. Before opening a pull request, please review the style guide and
workflow tips in [CONTRIBUTING.md](CONTRIBUTING.md).

## Quickstart

### API

Several RPC calls have been exposed in addition to the standard bitcoind-style
RPC. There is also a RESTful HTTP API with different features. The full node
and wallet node each run their own API servers on different ports.

For more details and a complete list of API calls, review the documentation
at https://hsd-dev.org/api-docs

### Unbound support

HSD currently has a built-in recursive resolver written in javascript, however,
for the best performance and best DNS conformance, HSD also includes native
bindings to `libunbound` -- to make use of this, be sure to have [unbound]
installed on your system _before_ installing `hsd`.

### Booting with a local recursive and authoritative nameserver

By default HSD will listen on an authoritative and recursive nameserver (ports
`15359` and `15360` respectively). To configure this:

``` bash
# Have the authoritative server listen on port 5300.
$ hsd --ns-port 5300

# Have the recursive server listen on port 53.
$ hsd --rs-host 0.0.0.0 --rs-port 53 # Warning: public!
```

Your localhost should now be diggable:

``` bash
$ dig @127.0.0.1 www.ietf.org +dnssec
$ dig @127.0.0.1 -p 5300 org +dnssec
```

### Accepting Inbound

To accept inbound connections, add the `--listen` flag.

```
$ hsd --listen --max-inbound 50
```

Note that this will not advertise your address on the p2p network by default.
In order to notify peers that you are accepting inbound, you _must_ pass
`--public-host`.

```
$ hsd --listen --public-host [my-public-ip-address] --max-inbound 50
```

### Mining

To mine with a CPU, HSD should be used in combination with [hs-client].

``` bash
# To boot and listen publicly on the HTTP server...
# Optionally pass in a custom coinbase address.
$ hsd --http-host '::' --api-key 'hunter2' \
  --coinbase-address 'ts1qsu62stru80svj5xk6mescy65v0lhg8xxtweqsr'
```

Once HSD is running, we can use [hs-client] to activate the miner
using the `setgenerate` RPC.

``` bash
$ hsd-rpc --http-host 'my-ip-address' \
  --api-key 'hunter2' setgenerate true 1
```

### Airdrop & Faucet

Testnet3 now implements a decentralized airdrop & faucet for open source
developers. See [hs-airdrop][airdrop] for instructions on how to redeem coins.

### Auctions

First we should look at the current status of a name we want.

``` bash
$ hsd-rpc getnameinfo handshake
```

Once we know the name is available, we can send an "open transaction", this is
necessary to start the bidding process. After an open transaction is mined,
there is a short delay before bidding begins. This delay is necessary to ensure
the auction's state is inserted into the [urkel] tree.

``` bash
# Attempt to open bidding for `handshake`.
$ hsw-rpc sendopen handshake
```

Using `getnameinfo` we can check to see when bidding will begin. Once the
auction enters the bidding state, we can send a bid, with a lockup-value to
conceal our true bid.

``` bash
# Send a bid of 5 coins, with a lockup value of 10 coins.
# These units are in HNS (1 HNS = 1,000,000 dollarydoos).
$ hsw-rpc sendbid handshake 5 10
```

After the appropriate amount of time has passed, (1 day in the case of
testnet), we should reveal our bid.

``` bash
# Reveal our bid for `handshake`.
$ hsw-rpc sendreveal handshake
```

We can continue monitoring the status, now with the wallet's version of
getnameinfo:

``` bash
$ hsw-rpc getnameinfo handshake
# To see other bids and reveals
$ hsw-rpc getauctioninfo handshake
```

If we end up losing, we can redeem our money from the covenant with
`$ hsw-rpc sendredeem handshake`.

If we won, we can now register and update the name using `sendupdate`.

``` bash
$ hsw-rpc sendupdate handshake \
  '{"records":[{"type":"GLUE4","ns":"ns1.example.com.","address":"127.0.0.1"}]}'
```

Note that the `ns` field's `domain@ip` format symbolizes glue.

Expiration on testnet is around 30 days, so be sure to send a renewal soon!

``` bash
$ hsw-rpc sendrenewal handshake
```

### Claiming a name

If you own a name in the existing root zone or the Alexa top 100k, your name is
waiting for you on the blockchain. You are able to claim it by publishing a
_DNSSEC ownership proof_ -- a cryptographic proof that you own the name on
ICANN's system.

Your name _must_ have a valid DNSSEC setup in order for the claim to be
created. If you do not have DNSSEC set up, don't worry -- you can set it up
_after_ the handshake blockchain launches and proofs will still be accepted
retroactively. Here's some useful guides for setting DNSSEC up on popular DNS
services:

- Namecheap: https://www.namecheap.com/support/knowledgebase/subcategory.aspx/2232/dnssec
- GoDaddy: https://www.godaddy.com/help/dnssec-faq-6135
- Gandi: https://wiki.gandi.net/en/domains/dnssec
- Name.com: https://www.name.com/support/articles/205439058-Managing-DNSSEC
- Hover: https://help.hover.com/hc/en-us/articles/217281647-Understanding-and-managing-DNSSEC
- Cloudflare: https://support.cloudflare.com/hc/en-us/articles/209114378

If you run your own nameserver, you're going to need some tools for managing
keys and signing your zonefile. BIND has a number of command-line tools for
accomplishing this:

- https://linux.die.net/man/8/dnssec-keygen
- https://linux.die.net/man/8/dnssec-dsfromkey
- https://linux.die.net/man/8/dnssec-signzone

---

First, we need to create a TXT record which we will sign in our zone (say we
own example.com for instance):

``` bash
$ hsw-rpc createclaim example
{
  "name": "example",
  "target": "example.com.",
  "value": 1133761643,
  "size": 3583,
  "fee": 17900,
  "address": "ts1qd6u7vhu084494kf9cejkp4qel69vsk82takamu",
  "txt": "hns-testnet:aakbvmygsp7rrhmsauhwlnwx6srd5m2v4m3p3eidadl5yn2f"
}
```

The `txt` field is what we need: it includes a commitment to a handshake
address we want the name to be associated with, along with a fee that we're
willing to pay the miner to mine our claim. This TXT record must be added to
our name's zone file and signed:

``` zone
...
example.com. 1800 IN TXT "hns-testnet:aakbvmygsp7rrhmsauhwlnwx6srd5m2v4m3p3eidadl5yn2f"
example.com. 1800 IN RRSIG TXT 5 2 1800 20190615140933 20180615131108 ...
```

The RR name of the TXT record (`example.com.` in this case) _must_ be equal
to the name shown in the `target` field output by `createclaim` (note: case
insensitive). Note that DNSSEC ownership proofs are a stricter subset of DNSSEC
proofs: your parent zones must operate through a series of typical `DS->DNSKEY`
referrals. No CNAMEs or wildcards are allowed, and each label separation (`.`)
must behave like a zone cut (with an appropriate child zone referral).

The ZSK which signs our TXT record must be signed by our zone's KSK. As per the
typical DNSSEC setup, our zone's KSK must be committed as a DS record in the
parent zone.

The final proof is an aggregation of all signed DNS referrals plus our signed
TXT record ([example here][proof]).

Once our proof is published on the DNS layer, we can use `sendclaim` to crawl
the relevant zones and create the proof.

``` bash
$ hsw-rpc sendclaim example
```

This will create and broadcast the proof to all of your peers, ultimately
ending up in a miner's mempool. Your claim should be mined within 5-20 minutes.
Once the transaction is mined, you must wait about 30 days (4,320 blocks) before your claim is considered
"mature".

Once the claim has reached maturity, you are able to bypass the auction process
by calling `sendupdate` on your claimed name.

``` bash
$ hsw-rpc sendupdate example \
  '{"ttl":3600,"canonical":"icanhazip.com."}'
```

#### Creating a proof by hand

If you already have DNSSEC setup, you can avoid publishing a TXT record
publicly by creating the proof locally. This requires that you have direct
access to your zone-signing keys. The private keys themselves must be stored in
BIND's private key format and naming convention.

We use [bns] for this task, which includes a command-line tool for creating
ownership proofs.

``` bash
$ npm install bns
$ bns-prove -b -K /path/to/keys example.com. \
  'hns-testnet:aakbvmygsp7rrhmsauhwlnwx6srd5m2v4m3p3eidadl5yn2f'
```

The above will output a base64 string which can then be passed to the RPC:

``` bash
$ hsd-rpc sendrawclaim 'base64-string'
```

## Support

Join us on [freenode][freenode] in the [#handshake][irc] channel.

## Disclaimer

HSD does not guarantee you against theft or lost funds due to bugs, mishaps,
or your own incompetence. You and you alone are responsible for securing your
money.

## Contribution and License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## License

MIT License.

### Bcoin

- Copyright (c) 2014-2015, Fedor Indutny (https://github.com/indutny)
- Copyright (c) 2014-2018, Christopher Jeffrey (https://github.com/chjj)
- Copyright (c) 2014-2018, Bcoin Contributors (https://github.com/bcoin-org)

### HSD

- Copyright (c) 2017-2018, Christopher Jeffrey (https://github.com/chjj)
- Copyright (c) 2018, Handshake Contributors (https://github.com/handshake-org)

See LICENSE for more info.

[handshake]: https://handshake.org/
[freenode]: https://freenode.net/
[irc]: irc://irc.freenode.net/handshake
[hnsd]: https://github.com/handshake-org/hnsd
[hs-miner]: https://github.com/handshake-org/hs-miner
[hs-client]: https://github.com/handshake-org/hs-client
[urkel]: https://github.com/handshake-org/urkel
[bns]: https://github.com/chjj/bns
[proof]: https://github.com/handshake-org/hsd/blob/master/test/data/ownership-cloudflare.zone
[unbound]: https://www.nlnetlabs.nl/projects/unbound/download/
[hnsd]: https://github.com/handshake-org/hnsd
[airdrop]: https://github.com/handshake-org/hs-airdrop
[coverage-status-img]: https://coveralls.io/repos/github/handshake-org/hsd/badge.svg?branch=master
[coverage-status-url]: https://coveralls.io/github/handshake-org/hsd?branch=master
[ci-status-img]: https://github.com/handshake-org/hsd/workflows/Build/badge.svg
[ci-status-url]: https://github.com/handshake-org/hsd/tree/master
