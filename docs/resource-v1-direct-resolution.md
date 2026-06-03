# Resource v1 direct-resolution proposal

Status: draft

This document sketches a resource version `1` design for direct on-chain
resolution records. It is intended as a successor discussion to the narrow
HIP018 / Rerecord A and AAAA prototype in
https://github.com/handshake-org/hsd/pull/955.

## Motivation

Handshake resources currently serve delegation-oriented use cases well. They
can publish `NS`, `DS`, glue, synthetic address records, and `TXT` data in the
existing version `0` format.

Adding more direct-resolution records to version `0` is possible, but it creates
long-term compatibility pressure. Older parsers stop at the first unknown record
type, so every new record type needs careful ordering behavior to avoid hidden
records and resolver disagreements.

Resource version `1` should instead define a clean direct-resolution format
that does not depend on extending the version `0` record-ordering behavior.

## Goals

- Keep version `0` behavior unchanged for existing resources.
- Define version `1` as a direct-resolution resource format.
- Separate delegation records from direct-resolution records.
- Support owner labels so records can represent names below the TLD apex.
- Define TTL handling explicitly.
- Include record types that are useful for secure direct deployment.
- Keep resolver behavior lightweight and predictable.
- Provide a durable base for future record types without adding permanent
  version `0` parsing complexity.

## Non-goals

- This proposal does not change supply, locked funds, foundation funding, or
  tokenomics.
- This proposal does not change the tree interval.
- This proposal does not require increasing `MAX_RESOURCE_SIZE`.
- This proposal does not define arbitrary zone-file hosting on chain.
- This proposal does not replace delegated DNS for large or frequently changing
  zones.

## Version model

Version `0` remains the existing resource format. Implementations should not
change version `0` semantics as part of this proposal.

Version `1` is a direct-resolution format. It should not include delegation
records such as:

- `NS`
- `DS`
- `GLUE4`
- `GLUE6`

A name owner should choose either delegation using version `0`, or direct
resolution using version `1`. Resolvers should not need to merge delegation
state and direct-resolution state from the same resource.

## Record model

Each version `1` record should have:

- an owner label;
- a DNS type;
- a TTL;
- record-specific data.

The owner label identifies the name relative to the Handshake TLD:

```txt
""              example.
"www"           www.example.
"_443._tcp"     _443._tcp.example.
```

The empty label represents the TLD apex.

Labels must be canonicalized before serialization. The exact canonical form
needs a separate validation pass, but it should reject invalid DNS label syntax
and preserve deterministic encoding.

## Initial record types

The first version `1` record set should be small enough to review carefully, but
useful enough for serious deployments.

Recommended initial set:

- `A`
- `AAAA`
- `TLSA`
- `HTTPS`

Possible additional set:

- `SVCB`
- `MX`

`TLSA` is important because direct `A` and `AAAA` records alone do not provide a
complete security story for clients that require authenticated service binding.
TLSA also motivates owner-label support, since common TLSA usage needs names
like `_443._tcp.example.`

`HTTPS` and `SVCB` should be considered because they are forward-looking service
binding records and can carry ECH-related parameters. Their exact encoding and
client behavior should be reviewed carefully before adoption.

`MX` is useful for mail routing, but it may be separable from the first secure
web-resolution use case.

## TTL handling

Version `1` should encode TTL explicitly per record or define one resource-level
TTL that applies to all contained records.

Open design choice:

1. Per-record TTL gives the most DNS-like behavior.
2. Resource-level TTL is smaller and simpler.
3. Fixed TTL avoids extra encoding but is less expressive.

The chosen rule should be deterministic and should not depend on client-local
defaults.

## Serialization sketch

This section is intentionally a sketch, not a final wire format.

```txt
u8 version = 1
repeated record:
  label
  rrtype
  ttl
  rdata
```

Important requirements for the final format:

- deterministic encoding;
- bounded parsing cost;
- clear duplicate-record behavior;
- clear maximum label and data lengths;
- stable ordering rules if order affects binary equality;
- explicit behavior for malformed records.

Unlike version `0`, version `1` should not rely on older clients parsing a known
prefix before stopping at an unknown type. Unknown version `1` record types
should have a defined handling rule inside the version `1` parser.

## DNS behavior

If a resolver supports resource version `1`, it may answer supported DNS queries
from the direct-resolution resource.

Examples:

```txt
example.          A      203.0.113.10
example.          AAAA   2001:db8::10
_443._tcp.example TLSA   ...
example.          HTTPS  ...
```

Resolvers should return negative answers with correct denial behavior for
supported names and types that are absent.

Resolvers that do not support version `1` will reject or ignore the resource
according to their existing unknown-version behavior.

## Compatibility and rollout

Version `1` is intentionally not a silent extension of version `0`.

The rollout path should be:

1. Agree on this design in a HIP or equivalent specification.
2. Add version `1` parsing and serialization tests.
3. Add DNS-answer tests for each supported record type.
4. Add compatibility tests for old-node unknown-version behavior.
5. Add wallet and RPC safeguards so users do not hand-write invalid resources.
6. Add Bob Wallet / LearnHNS UX only after the hsd behavior is stable.

The narrow A and AAAA implementation in PR #955 can remain useful as a prototype
and test reference, but a version `1` proposal should supersede it if maintainers
prefer the cleaner direct-resolution design.

## Open questions

- Should version `1` use per-record TTLs or one resource-level TTL?
- Which record types are required for the first version `1` release?
- Should `HTTPS` imply `SVCB` support because of their shared wire model?
- How should duplicate records be ordered and compared?
- What label grammar should be accepted for owner labels?
- Should version `1` allow only a small approved record-type set?
- What denial/NSEC behavior is required for sub-label direct records?
- How should wallets display the difference between delegated DNS and direct
  on-chain DNS?

