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
needs to be conscious decision, because in some cases it's better to back up
existing database. (wallet)
But we also provide option for the projects depending on the hsd to decide for
their users on each release. Wallet and Chain accept
`hsd --chain-migrate=N`/`--wallet-migrate=N` flags
(or `hsw --migrate=N` for separate wallet)
which is number of the latest migration to run specific to that db.

 - Flag not set:
   - no available migrations: nothing
   - migrations have to run: fail with migration available error. (list)
 - Flag == lastID
   - no available migration: nothing
   - migrations have to run: run the migrations
 - Flag != lastID
   - no available migration: fail with ID not matching error
   - migrations have to run: fail with migration available error. (list)

You can also check `test/migrations-test.js - Migrate flag` test cases.

### Migration versions
Migrations version start from 0 (which is `migrations` migration) and is
incremented from there. (Currently, wallet and chain both have one migration)

[pr415]: https://github.com/handshake-org/hsd/pull/415
