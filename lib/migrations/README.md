## HSD Migration
### Motivation
  Previously, bcoin used to have **external** scripts that would do the
migration of the state, mostly changing layout and version of the db.  After
[PR 415][pr415-change-address] and discussions around it, database state
**fix**es (that don't change layout/version of the db) have moved inside of the
chaindb/walletdb instead.  
  So, in summary, there are two different type of migrations: state fixes and
layout changes.

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
existing database. (wallet) But we also provide option for the projects
depending on the hsd to decide for their users on each release.  
  Wallet and Chain accept `hsd --chain-migrate=N`/`--wallet-migrate=N` flags
(or `hsw --migrate=N` for separate wallet) which is number of the latest
migration to run specific to that db.

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

## Writing migrations
### Databases and migrations
  HSD has two separate databases with their own migrations: ChainDB and
WalletDB. Depending which database your migration affects, you will need to
refer to respective files to implement migrations:
  - `lib/blockchain/migrations.js` - for ChainDB
  - `lib/wallet/migrations.js` - for WalletDB

  As we described above, there are two type of migrations: `fix` and `upgrade`.

### Fix
  `Fix` migrations are used, when there's no database `layout` change, but some
state was calculated incorrectly. There are examples of this type of migration
in both databases:
  - `MigrateChainState` in `lib/blockchain/migrations.js` - Fixes Chain State.
    ([PR 396][pr396-total-supply])
  - `MigrateChangeAddress` in `lib/wallet/migrations.js` - Fix change address
    lookahead. ([PR 415][pr415-change-address])

  Notice, neither of those change `layout`. They only fix incorrectly calculated
state and then introduce necessary migration to migrate the database.

### Upgrade
  Changes, that affect `layout` of the database, need to also upgrade the
database version and those migrations are called `upgrade`
(at least in this doc). Note that `upgrade`s can't be skipped, because both
database verify version in the database matches to the one in DB class.
(Notes in `check` method description bellow)
  - ChainDB version: `lib/blockchain/chaindb.js`
  - ChainDB layout: `lib/blockchain/layout.js`
  - WalletDB version: `lib/wallet/walletdb.js`
  - WalletDB layout: `lib/wallet/layout.js`

### Implementation
  All migrations inherit from the class `AbstractMigration` in
`lib/migrations/migration.js`. There are three class methods and one
static method to implement: `check`, `migrate`, `warning` and
`static info`.

#### `check` method
  `check` method returns the type of the migration depending on the
database options, these are: `types.MIGRATE`, `types.FAKE_MIGRATE` and
`types.SKIP`. Definition can be found in `lib/migrations/migrator.js`.
Depending on the result, `migrator` will do different things:
  - `MIGRATE` - will call `migrate` method and do actual migration.
  - `FAKE_MIGRATE` - wont call `migrate` method but will mark migration as
    migrated.
  - `SKIP` - wont call `migrate` method but will mark migration as `skipped`,
    which will in turn call `warning` on each load of the database.

  How to decide which one to return is discussed in the above sections.  
  If the type of migration you are writing is `upgrade`, you must to return
`MIGRATE`, in order to run `migrate` method and change database
`layout.V` entry. In case other parts of the migration does not apply,
you can check for `options` and add necessary guards in the `migrate` method
instead. You always change `layout.V` for upgrade type migration, otherwise
checks version verification will fail.

#### `migrate` method
  `migrate` method is where the whole migration logic is written, you can of
course have other methods in the class to have cleaner code. (e.g.
`MigrateChangeAddress` class in `lib/wallet/migrations.js`)  
  It accepts `batch` as parameter, that is later executed by the `migrator`,
with the Migration State update.  
  Some migrations that do a lot of changes, may create their own `batch`es
and don't use `batch` passed as an argument. Migration State will
have `inProgress` flag set and the migration will continue with the
same `migrate` code. You will need to make sure code can handle
halt in between in this case and continue where you left off.

#### `warning` method
  Warning is useful when migration was skipped, it needs to use passed logger
to log into stdout and file, preferebly as warning. It can encourage or
notify users, that the state of their database is incorrect and could not
be fixed in their mode.  (e.g. `MigrateChainState` in
`lib/blockchain/migrations.js` when you have pruning enabled).  
  If the migration was not skipped, this method wont be called.

#### `static info` method
  This method provides name and small summary of the migration. This will
be shown on the CLI and logs when there are new migrations available to run
and flag is not set properly. It must return Object with `name` and
`description`:
  ```js
  return {
    name: 'Name of the migration',
    description: 'Small description of the migration'
  }
  ```

[pr415-change-address]: https://github.com/handshake-org/hsd/pull/415
[pr396-total-supply]: https://github.com/handshake-org/hsd/pull/396
