#!/usr/bin/env node

'use strict';

const WalletDB = require('../lib/wallet/walletdb');
const path = require('path');
const os = require('os');
const Logger = require('blgr');

(async () => {
  const args = process.argv.slice(2);

  let network = 'main';
  let prefix = path.join(os.homedir(), '.hsd');
  let level = 'info';

  while (args.length > 0) {
    const arg = args.shift()
    switch (arg) {
      case '-n':
      case '--network':
        network = args.shift();
        continue;
      case '-p':
      case '--prefix':
        prefix = args.shift();
      case '-l':
      case '--log-level':
        level = args.shift();
    }
  }

  const logger = new Logger(level);
  await logger.open

  const wdb = new WalletDB({
    network: network,
    logger: logger,
    prefix: prefix,
    memory: false
  });

  await wdb.open();
  await wdb.migrateChange();
  await wdb.close()

})().catch(err => {
  console.log(err)
  process.exit(1);
});
