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
# These units are in HNS (1 HNS = 1,000,000 dollarydoos).
$ hwallet-cli rpc sendbid handshake 5 10
```

After the appropriate amount of time has passed, (1 day in the case of
testnet), we should reveal our bid.

``` bash
# Reveal our bid for handshake
$ hwallet-cli rpc sendreveal handshake
```

We can continue monitoring the status, now with the wallet's version of
getnameinfo:

``` bash
$ hwallet-cli rpc getnameinfo handshake
# To see other bids and reveals
$ hwallet-cli rpc getauctioninfo handshake
```

If we end up losing, we can redeem our money from the covenant with
`$ hwallet-cli rpc sendredeem handshake`.

If we won, we can now register and update the name using `sendupdate`.

``` bash
$ hwallet-cli rpc sendupdate handshake \
  '{"ttl":3600,"ns":["ns1.myserver.net.@1.2.3.4"]}'
```

Note that the `ns` field's `domain@ip` format symbolizes glue.

Expiration on testnet is around 30 days, so be sure to send a renewal soon!

``` bash
$ hwallet-cli rpc sendrenewal handshake
```

### RPC Calls

Several RPC calls have been exposed in addition to the standard bitcoind-style
RPC.

#### Node Calls

All node calls should be made with `$ hsk-cli rpc [call] [arguments...]`.

- `getnameinfo [name]` - Returns name and auction status.
- `getnameresource [name]` - Returns parsed DNS-style resource.
- `getnameproof [name]` - Returns a JSON-ified [urkel] proof of a name.
- `getnamebyhash [hex-hash]` - Returns the name hash preimage.
- `sendrawclaim [hex-string]` - Send a raw serialized claim.

#### Wallet Calls

All wallet calls should be made with `$ hwallet-cli rpc [call] [arguments...]`.

- `getbids [name]` - List own bids on a name.
- `getauctions` - List all watched auctions and their statuses.
- `getauctioninfo [name]` - Returns auction info, along with all bids and
  reveals.
- `getnameinfo [name]` - Returns name info, similar to the node call above.
- `getnameresource [name]` - Returns parsed DNS-style resource.
- `getnamebyhash [hex-hash]` - Returns the name hash preimage.
- `createclaim [name]` - Create a to-be-signed claim.
- `sendclaim [name]` - Claim a name by publishing a DNSSEC ownership proof.
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
$ hwallet-cli rpc createclaim example
{
  "name": "example",
  "target": "example.com.",
  "value": 1133761643,
  "size": 957,
  "fee": 19140,
  "block": "fb89a649e4667d8ffc4ce105faec7872ef47e0ce0e60a6a9e58e0b7cc3bb6147",
  "address": "rs1qz588tmrclt4x2v48nu4ty2dnyenusul8q5djcj",
  "txt": "hns-claim:qnPxvMRKAAAAAAAA+4mmSeRmfY/8TOEF+ux4cu9H4M4OYKap5Y4LfMO7YUcAFBUOdex4+uplMqefKrIpsyZnyHPn"
}
```

The `txt` field is what we need: it includes a commitment to a handshake
address we want the name to be associated with, along with a fee that we're
willing to pay the miner to mine our claim. This TXT record must be added to
our name's zone file and signed:

``` zone
...
example.com. 1800 IN TXT "hns-claim:qnPxvMRKAAAAAAAA+4mmSeRmfY/8TOEF+ux4cu9H4M4OYKap5Y4LfMO7YUcAFBUOdex4+uplMqefKrIpsyZnyHPn"
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

Once our proof is published on the DNS layer, we can use `sendclaim` to crawl
the relevant zones and create the proof.

``` bash
$ hwallet-cli rpc sendclaim example
```

This will create and broadcast the proof to all of your peers, ultimately
ending up in a miner's mempool. Your claim should be mined within 5-20 minutes.
Once mined, you must wait 400 blocks before your claim is considered "mature".

Once the claim has reached maturity, you are able to bypass the auction process
by calling `sendupdate` on your claimed name.

``` bash
$ hwallet-cli rpc sendupdate example \
  '{"ttl":3600,"canonical":"icanhazip.com."}'
```

#### Creating a proof by hand

If you already have DNSSEC setup, you can avoid publishing a TXT record
publicly by creating the proof locally. This requires that you have direct
access to your zone-signing keys. The private keys themselves must be stored in
BIND's private key format (v1.3) and naming convention.

We use [bns] for this task, which includes a command-line tool for creating
ownership proofs.

``` bash
$ npm install bns
$ bns-prove -x -K /path/to/keys example.com. \
  'hns-claim:qnPxvMRKAAAAAAAA+4mmSeRmfY/8TOEF+ux'
```

The above will output a hex string which can then be passed to the RPC:

``` bash
$ hsk-cli rpc sendrawclaim 'hex-string'
```

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
[urkel]: https://github.com/handshake-org/urkel
[bns]: https://github.com/bcoin-org/bns
