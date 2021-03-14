'use strict';

const {tmpdir} = require('os');
const fs = require('fs');
const path = require('path');
const WalletDB = require('../lib/wallet/walletdb');
const bench = require('./bench');

const location = path.join(tmpdir(), 'hsd_account_bench_' + String(Date.now()));
const wdb = new WalletDB({
  network: 'regtest',
  memory: false,
  location
});

(async () => {
  await fs.mkdirSync(location);
  await wdb.open();
  const wallet = await wdb.create();

  const end = bench('account');
  for (let i = 0; i < 1000; i++) {
    await wallet.createAccount({});
  }
  end(1000);
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
