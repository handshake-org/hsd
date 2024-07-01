Migration data with before/after entries.

It contains generator scripts and manually assembled jsons for the migrations.

## Notes
  - wallet-4-bid-reveal.json (wallet-4-bid-reveal-gen.js)
    - `fullAfter` is db dump with new version, `after` is filtered out things
    that can not be recovered.
      - Removed not-owned BID <-> Reveal bidings, they are not possible to
      recover. We don't have transactions for those. We can't recover height of
      the bids either.
