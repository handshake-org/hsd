# Experimental P2P DNS relay

This document describes a private proof-of-concept extension. It is disabled by
default and does not claim Handshake protocol assignments.

The temporary capability is service bit `0x40000000`; the temporary request and
response packet types are `0xf0` and `0xf1`. Version services occupy eight bytes
on the wire (the current JavaScript codec uses the low 32-bit word). Frames use
the existing four-byte magic, one-byte type, and four-byte payload length.
Legacy peers decode other one-byte types as unknown packets and continue the
connection.

The payloads and limits are defined in the sibling browser repository's
`docs/experimental-hns-p2p-dns-relay.md` and duplicated in the deterministic
fixtures under `fixtures/experimental-dns-relay/`. In short, requests contain a
nonzero little-endian u64 ID, little-endian u16 query length, and at most 4,096
raw DNS bytes. Responses contain that ID, a one-byte transport status,
little-endian u16 response length, and at most 65,535 raw DNS bytes. Packets
reject trailing data. Canonical responses with an unassigned nonzero status are
preserved as unusable exchange results with an empty body, rather than treated
as malformed peer frames.

The node option is `--experimental-dns-relay`. Advertisement requires the flag,
a synchronized chain, an initialized/ready recursive server, and available
global capacity. The service exists only on an established HNS peer connection;
it creates no DNS, HTTP, or management listener.

Requests must be standard recursive IN queries with one HNS-rooted question,
RD and EDNS DO, bounded EDNS, and no ECS. ANY, AXFR, IXFR, UPDATE, NOTIFY,
TKEY/TSIG abuse, malformed input, ICANN roots, private infrastructure names, and
names absent from current HNS state are refused. No destination address or port
is accepted. A dedicated, bounded relay resolver follows the node's local HNS
root stub, always sets Checking Disabled on its authority queries so locally
validatable DNSSEC material is not suppressed, keeps its own cache, and permits
only public port-53 authority endpoints throughout recursion. Its own AD result
is advisory and never trusted by the requester. The ordinary node resolver and
cache are not modified or exposed to relay requests.

The test-only `--experimental-dns-relay-allow-private-authorities` option may
be combined with `--experimental-dns-relay` on regtest only. It admits RFC1918
IPv4 authority endpoints on port 53 so an isolated regtest topology can serve a
delegated zone without pretending its Docker address is public. The dedicated
resolver remains IPv4-only. The option still rejects loopback, link-local,
carrier-grade NAT, metadata, benchmarking/documentation, multicast,
unspecified, IPv6, and non-port-53 endpoints. Supplying the option on another
network, or without enabling the experimental relay, aborts node construction.
It is not a canary or production option.

Allowed types are A, AAAA, CNAME, DNAME, NS, SOA, DS, DNSKEY, RRSIG, NSEC,
NSEC3, NSEC3PARAM, TLSA, SVCB, HTTPS, TXT, MX, SRV, and CAA.

Default bounds are 20 request attempts per second per peer connection with a
burst of 40, 200 attempts per second across all peer connections with a burst
of 400, 50 outbound requests per second per external authority address with a
burst of 100, 16 in-flight per peer, 64 globally, and a three-second backend
deadline. Authority buckets are capped at 1,024 entries.
Disconnect, timeout, success, and every error path release logical pending
state. Timed-out or disconnected physical resolver work remains charged to its
originating peer and to the global bound until it actually settles. Concurrency
backpressure returns `BUSY`. Rate-limit `BUSY` notices are capped at one per peer
per second; further over-limit attempts in that interval are dropped without a
response.

Controlled tests may override these through
`--experimental-dns-relay-timeout`, `--experimental-dns-relay-rate`,
`--experimental-dns-relay-burst`, `--experimental-dns-relay-global-rate`,
`--experimental-dns-relay-global-burst`,
`--experimental-dns-relay-peer-inflight`, and
`--experimental-dns-relay-global-inflight`.

Normal logs do not contain qnames or raw DNS. They may contain aggregate status,
size/latency buckets, accepted/invalid/refused/rate-limited/busy/timeout/backend
failure/success/oversized counts. The ordinary P2P listener is plaintext;
Brontide is encrypted. Operators must not describe the one-hop design as ODoH.
Explicit spam-level DNS message logging can reveal queries and must remain off
for a privacy-preserving canary.

For regtest and public-canary cautions, topology, rollback, future `hnsd` work,
and future HIP subjects, see the complete sibling design document. Do not enable
this service as a general public resolver or deploy a canary automatically.
