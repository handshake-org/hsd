
## HSD Migration
### Motivation
  Previously, bcoin used to have *external* migration scripts that would do
  the migration mostly changing layout and version of the db.
  After [PR 415][pr415] and discussions about it,
  database state fixes (that don't change layout/version of the db)
  have moved inside of the chaindb/walletdb instead.
  These two are different type of migrations, but I believe having migration
  inside db implementations makes them easier to use.
  You can see different type of migration setups below.

  This is proof of concept, but is necessary to properly implement
  blockstore migration. Blockstore could skip this by doing old-fashioned
  migration that is external script, but would prefer to discuss this here
  first.

### Migration differences
  There are several modes that chaindb operates in:
    - Full
    - Pruned
    - SPV
  Some migrations may be applicable to all three or any combination of these.  
  There are two types of migrations we've seen so far:
    - Fixes: Bug or Chain state fix that does not modify the layout of the
      database and does not need DB version change.
    - Upgrades: Changes that modify database layout and need to change the
      version of the database.
  
  Current POC does not include walletdb, but if the changes are good, we can
  port them to the walletdb as well. At least walletdb only has one mode of
  operation, only differences in migration types applies.

### Database versions
  ChainDB and WalletDB both have database version which is only incremented
  if there is backwards incompatible change, mostly layout changes.
  
    - ChainDB version - 1
    - WalletDB version - 0

  Current migrations are fixes and don't affect the layout, so the DB versions
  have not increased, but blockstore (and some future changes) will change
  chaindb layout, so we need to bump the version to `2`.

  ChainDB open logic has hard check for the version: if the db version entry
  does not match the codebase version that node won't start. If we use external
  scripts this is not an issue, but with integrated migrations we will need to
  move this check to migration checks. (See tasks bellow)

### Fresh vs Existing
  ChainDB checks whether database exists with ChainState check.  
  WalletDB does not have explicit existence check, instead it's done
  separately at each stage of the opening of the db.
  
  ChainDB as well as WalletDB(If it ever becomes necessary) can do
  existence checks using Version instead and use `batches` when creating.
  Existing chaindb open logic may not work properly because of this if
  there's termination in the process. (See tasks bellow)

### Migration versions
  [PR 415][pr415] introduced `migrate` entry in the db to track the current
  migration state. It is used to check which migrations we have run so far
  and skip if they are not necessary, but all these migrations are database
  state fixes not layout updates.  
  We could change versioning to have pair (version, migrationNumber) or
  in blockstore case not touch migration at all, because it does not actually
  affect existing migrations (totally different changes). But I believe
  we should stick to single `migration` layout entry and increase
  no matter the type of the migration we are doing. This can limit us
  for the stuff we could do in "parallel", but it would increase complexity.
  We could define some "framework" for the parallel migrations to run
  effectively, but I don't think the problem needs this complex solution.

  Single `migration` bump without considering db version number (upgrades will
  be considered normal migration) can simplify writing those and executing
  them in series. Optionally we could have `lastMigration` entry to easily
  skip ahead, but even this is not necessary at this stage.

### Triggering migrations
  We don't want to start migrations without notifying users first, so
  migrations must not start without user input. I believe we can stick
  to the similar pattern to walletdb and accept migration flag that will
  allow all migrations to run, otherwise throw an error.  
  I think having `--migration=bool` is good enough and is not necessary to
  specify version, as it does not make sense for users not to upgrade
  to the latest codebase if they are running one. If they want to skip
  then they should probably downgrade -- hopefully this wont happen
  as it is a big security risk.

### Downsides
  Migrations in the chaindb and walletdb code make it easier for users
  to run migrations (w/o figuring out steps and do manual checks of the
  parameters). Unfortunately, this introduces new code in the critical
  path of the software and this code will probably live forever
  at this place. That's one of the reasons I think moving migration
  related codebase to `migration.js` of respective database folders.
    Because this part of the codebase is critical, we should try
  and make this as independent/scoped from the main lifecycle of
  the ChainDB/WalletDB as possible. This migration objects will only
  be created in the `open` and end their lifecycles there.  
  It is hard to audit and predict all future changes to the migrations,
  but making sure that:
    - code does not affect chaindb/walletdb object in any way (Other than using
      db methods)
      - Don't change state of the chaindb/walletdb object or any other objects.
    - migration code can be run separately without any dependence on the other
      chain/wallet db logic.

[pr415]: https://github.com/handshake-org/hsd/pull/415
