## HSD Migration
### Motivation
  Previously, bcoin used to have **external** scripts that would do
  the migration of the state, mostly changing layout and version of the db.
  After [PR 415][pr415] and discussions around it, database state **fix**es
  (that don't change layout/version of the db)
  have moved inside of the chaindb/walletdb instead.
  So, in summary, there are two different type of migrations,
  state fixes and layout changes.

### Migration differences
  There are several modes that chaindb operates in:
    - Full
    - Pruned
    - SPV

  Some migrations may be applicable to all three or any combination of these.  
  And there are two type of migrations (mentioned above):
    - Fixes: Bug or Chain state fix that does not modify the layout of the
      database and does not need DB version change.
    - Upgrades: Changes that modify database layout and need to change the
      version of the database.

  Different migrations may have different effects to the users depending on
  the above combination:
    - Migration may not apply to your database.
    - Migration may apply to your database, but can't be done. (PRUNE)
    - Migration applies to your database.

  Concrete example we can use here is Chain State migration:
    - It applies to FULL Nodes.
    - It applies to Pruned Nodes, but can't be run because of the lack of data.
    - It does not apply to SPV nodes. (they don't have the chain state)

  For each of these situations migration will do different things:
    - If it applies - throw error for the `migrationFlag`.
    - If it applies, but can't be fixed - SKIP migration and keep showing warning.
    - It it does not apply - do `fake migration`.
        
### Migration flags
  We don't want to run migrations without notifying users about them first. The
  main reason is the time it may take and the downtime it may cause. Also, it
  needs to be consious decision, because in some cases it's better to back up
  existing database. (wallet)

  - If there's a migration available for the db, running the node will fail.
  - If there's no migration but you pass the migration flag, it will fail.
    - We don't want users to constantly run nodes with this flag (or maybe
      someone used config file, so they don't forget to remove the config)
  - If there's migration and migration flag is passed, all migrations will run.
      
  For fullnode use `hsd --chain-migrate` and for wallet
  `hsd --wallet-migrate` or `hsw --migrate`.

### Migration versions
  Migrations version start from `1` (wallet and chain both have one migration)
  and will be incremented from there. For defining migrations, there's no
  distinction between different types.

[pr415]: https://github.com/handshake-org/hsd/pull/415
