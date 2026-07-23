# Experimental HNSR proof of concept

This branch contains a deliberately bounded, regtest-only implementation of
the unnamed `HNS_NODE_V1` path from the draft **Handshake P2P Rendezvous and
Authenticated Service Relay** HIP.

It is reference code for exercising the wire shape, authorization boundaries,
and lifecycle on actual `hsd` peers. It is not a production relay, a permanent
wire assignment, or a claim that every phase of the draft HIP is implemented.

## Private assignments

| Symbol | Private value |
| --- | ---: |
| HNSR rendezvous service | `0x04000000` |
| HNSR relay service | `0x08000000` |
| HNSR packet type | `0xf3` |

The roles cannot be enabled outside regtest. Nodes on other networks do not
advertise either bit. These values are collision-prone experimental values and
must be replaced if the protocol receives assigned values.

## Implemented trial profile

The branch implements:

- the version-1 HNSR envelope and all 21 reserved opcode numbers;
- strict envelope length, flag, version, opcode, and context checks;
- regtest-only role advertisement;
- iterative `FINDNODE` / `NODES` discovery with XOR ordering, parallelism of
  three, a 32-query bound, authenticated rendezvous contacts, and connections
  to newly discovered Handshake peers;
- publisher-driven route replication with a configurable replica count and
  minimum-store quorum;
- deterministic bounded `SAMPLEROUTES` discovery for unnamed node routes;
- endpoint-signed `RESERVE`, relay-signed `OFFER`, endpoint `CONFIRM`, and
  jointly authenticated relay tickets;
- reservation `RENEW` and signed `WITHDRAW`, including retirement of replaced
  tickets;
- strict-DER, low-S secp256k1 signatures with network- and domain-separated
  digests;
- self-authorized unnamed endpoint delegations and route records for
  `HNS_NODE_V1`;
- bounded, expiring, sequence-aware in-memory route storage with global,
  per-key, and per-publishing-peer limits;
- `PUTROUTE` / `PUTRESULT` and exact-key `GETROUTE` / `ROUTES`;
- multi-relay records, renewed-record republishing, sequential relay failover,
  and failure reporting;
- `OPEN` / `INCOMING` / `ACCEPT` / `OPENED` circuit establishment;
- opaque `DATA`, directional `WINDOW`, and `CLOSE` forwarding;
- per-ticket circuit and byte limits, bounded frames, and relay-side
  directional credit enforcement;
- bounded relay queues with burst-yield scheduling, control-request admission,
  request-byte limits, and observable queue/drop counters;
- immediate local reservation invalidation when the endpoint peer disconnects;
  and
- actual inbound and outbound `Peer` objects in the ordinary HSD pool, running
  complete end-to-end Brontide and Handshake peer sessions over virtual circuit
  sockets.

The proof-of-concept handler does not forward to a requester-selected host or
port. A circuit can terminate only at the exact live peer connection bound to
the signed reservation.

## Milestone boundaries

The following groups are deliberately separated so that completion of the
unnamed-node experiment is not confused with named services, client product
work, or public-network readiness.

### Unnamed-node Phase 1: implemented here

The branch completes the directly executable unnamed `HNS_NODE_V1` slice:

- two independent relay candidates in each tested route;
- four iteratively discovered rendezvous nodes and four-copy publication;
- random unnamed-node sampling and exact-key lookup;
- reservation, renewal, replacement publication, withdrawal, disconnect, and
  stale-ticket rejection;
- rendezvous loss and first-relay failure recovery;
- real inner full-node block traffic; and
- flow-control, scheduler saturation, control admission, and zero-drop checks.

The rendezvous table is intentionally the bounded live/recently-connected
contact set for this regtest phase. It exercises iterative XOR routing but is
not yet the persistent bucket implementation required for a public network.

### Phase 1B: named service authorization and profiles

Still to implement before claiming the HIP's complete Phase 1 service surface:

- authenticated HNS authority lookup and canonical TXT root-key parsing;
- service authorizations and named endpoint delegations;
- named route-key derivation and authorization-chain validation; and
- the `HNS_WEB_V1` handler and origin rules.

These features are not prerequisites for review of the unnamed full-node
transport, but they are prerequisites for claiming named HNS service support.

### Phase 2: bounded testnet hardening

Still required before any testnet experiment:

- persistent routing buckets and optional durable route storage;
- eight-replica, multi-path churn tests over larger and adversarial topologies;
- public-address admission, routability, per-prefix, and netgroup policy;
- peer-dial budgets, topology scoring, republish/failover timers, and restart
  recovery; and
- scheduler integration that explicitly prioritizes blocks, headers, proofs,
  and transaction traffic, plus operational telemetry.

### Phase 3: node, mobile, and browser integration

Still required for user-facing adoption:

- RPCs and configuration/status APIs;
- address-manager, wallet, and SPV discovery integration;
- Android foreground/background lifecycle and network-change handling;
- HNS-aware browser navigation and named-origin behavior; and
- operator documentation, compatibility behavior, and upgrade UX.

### Public-network and production readiness

Permanent service/packet assignments, production abuse controls, reputation or
payment policy, privacy review, deployment gates, and sustained public-network
load measurements remain outside this PoC. The regtest-only feature guard stays
in place until those questions are resolved.

## Reproducible trial

From this branch:

```sh
npm ci
NODE_BACKEND=js npm run test-file -- \
  test/hnsr-test.js test/brontide-test.js test/net-test.js
NODE_BACKEND=js node scripts/run-hnsr-regtest-trial.js \
  docs/hnsr-regtest-phase1.json
```

`NODE_BACKEND=js` selects bcrypto's portable JavaScript backend and is not a
protocol requirement.

The trial starts eight independently keyed, independently prefixed FullNodes:

```text
Endpoint (no listener) ==> Relay A, Relay B, Rendezvous 0
Requester              ==> Rendezvous 0
Rendezvous 0           ==> Rendezvous 1 ==> Rendezvous 2 ==> Rendezvous 3

Requester == inner HNS peer ==> surviving relay ==> Endpoint
```

It then:

1. iteratively discovers all four rendezvous nodes from one bootstrap;
2. reserves both relays and stores one signed route at all four rendezvous
   nodes;
3. discovers the route with `SAMPLEROUTES`;
4. renews both tickets, republishes a higher sequence, and withdraws the old
   reservations;
5. issues 72 concurrent lookup requests and verifies bounded admission;
6. stops one rendezvous node and retrieves the refreshed record from the three
   survivors;
7. stops Relay A and verifies automatic fallback to Relay B;
8. constructs ordinary inbound/outbound HSD `Peer` objects over the circuit
   and verifies both inner static identities;
9. sends 1,000 ordinary Handshake pings while mining and relaying a real block;
10. proves only endpoint and requester reach height 1 while both relays and all
    four rendezvous chains remain at height 0;
11. verifies bounded queues, multiple scheduler yields, a control reservation
    during load, and zero relay drops; and
12. disconnects the endpoint, retrieves the intentionally stale route, and
    confirms the surviving relay rejects its invalid ticket.

The checked-in `docs/hnsr-regtest-phase1.json` is one passing run. It records
topology, discovery, replica survival, lifecycle transitions, selected relay,
block-only inner convergence, saturation counters, admission results, opcode
counts, and a ciphertext transcript hash. Random values change on every run.

## Configuration surface

The following illustrative flags are recognized by `FullNode`:

```text
--experimental-hnsr
--experimental-hnsr-endpoint
--experimental-hnsr-relay
--experimental-hnsr-rendezvous
--experimental-hnsr-timeout=<milliseconds>
```

The relay role also requires the ordinary peer listener. Endpoint and requester
roles advertise no HNSR service bit.
