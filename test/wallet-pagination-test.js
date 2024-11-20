'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const WalletDB = require('../lib/wallet/walletdb');
const consensus = require('../lib/protocol/consensus');
const util = require('../lib/utils/util');
const wutils = require('./util/wallet');
const {
  dummyInput,
  nextEntry
} = wutils;

/** @typedef {import('../lib/wallet/wallet')} Wallet */

const network = Network.get('main');
// single request per page.
const MAX_HISTORY = 20;
const DEFAULT = 'default';
const ALT_ACCOUNT = 'alt';

const UNCONFIRMED_HEIGHT = 0xffffffff;
const MAX_TIME = 0xffffffff;
const GENESIS_TIME = 1580745078;

describe('WalletDB Pagination', function() {
  /** @type {WalletDB} */
  let wdb;
  /** @type {Wallet} */
  let wallet;
  let timeCounter = GENESIS_TIME;

  const setupWDB = async () => {
    wdb = new WalletDB({
      maxHistoryTXs: MAX_HISTORY,
      network
    });

    await wdb.open();

    wallet = wdb.primary;

    const altAccount = await wallet.createAccount({
      name: ALT_ACCOUNT
    });

    assert(altAccount);

    wallet.txdb.nowFn = () => timeCounter++;
  };

  const cleanupWDB = async () => {
    timeCounter = GENESIS_TIME;
    await wdb.wipe();
  };

  describe('Index unconfirm counts', function() {
    beforeEach(setupWDB);
    afterEach(cleanupWDB);

    it('should increment unconfirmed count: -> unconfirmed tx', async () => {
      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, 0);

      const mtx = await dummyTX(wallet);
      const wids = await wdb.addTX(mtx.toTX());
      assert(wids);
      assert.strictEqual(wids.wids.size, 1);

      const txCount = await wallet.txdb.getCountForTX(mtx.hash());
      assert.strictEqual(txCount.index, initUCount.index);
      assert.strictEqual(txCount.height, txCount.height);

      const uCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(uCount.index, 1);
    });

    it('should not increment unconfirmed count: unconfirmed -> confirmed', async () => {
      const totalTXs = 10;
      const mtxs = [];

      for (let i = 0; i < totalTXs; i++) {
        const mtx = await dummyTX(wallet);
        await wdb.addTX(mtx.toTX());
        mtxs.push(mtx);
      }

      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, totalTXs);

      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, mtxs.map(mtx => mtx.toTX()));

      const uCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(uCount.index, totalTXs);
    });

    it('should increment unconfirmed count: -> confirmed', async () => {
      const totalTXs = 10;

      // add some mock txs (Not part of test, just moving unconfirmed count)
      for (let i = 0; i < totalTXs; i++) {
        const mtx = await dummyTX(wallet);
        await wdb.addTX(mtx.toTX());
      }

      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, totalTXs);

      const mtx = await dummyTX(wallet);
      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, [mtx.toTX()]);

      const txCount = await wallet.txdb.getCountForTX(mtx.hash());
      // this is block index
      assert.strictEqual(txCount.index, 0);

      const uCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(uCount.index, totalTXs + 1);
    });

    it('should not increment count: confirmed -> unconfirmed', async () => {
      const totalConfirmed = 5;
      const totalUnconfirmed = 5;
      const totalTXs = totalConfirmed + totalUnconfirmed;
      const entries = [];
      const mtxs = [];
      const times = [];

      // 5 directly confirmed
      for (let i = 0; i < totalConfirmed; i++) {
        const mtx = await dummyTX(wallet);
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, [mtx.toTX()]);
        // timeCounter is incremented twice, once for wdb.add/txrecord
        // creation and another on time index creation.
        times.push(timeCounter - 1);
        entries.push(entry);
        mtxs.push(mtx);
      }

      // 5 unconfirmed -> confirmed
      for (let i = 0; i < totalUnconfirmed; i++) {
        const mtx = await dummyTX(wallet);
        await wdb.addTX(mtx.toTX());
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, [mtx.toTX()]);
        // timeCounter is incremented twice, once for wdb.add/txrecord
        // creation and another on time index creation.
        times.push(timeCounter - 1);
        entries.push(entry);
        mtxs.push(mtx);
      }

      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, totalTXs);

      for (const entry of entries.reverse())
        await wdb.removeBlock(entry);

      const countUAfter = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(countUAfter.index, totalTXs);

      for (const [index, mtx] of mtxs.entries()) {
        const count = await wallet.txdb.getCountForTX(mtx.hash());
        assert.strictEqual(count.height, UNCONFIRMED_HEIGHT);
        assert.strictEqual(count.index, index);

        const txByTime = await wallet.listUnconfirmedByTime(-1, {
          limit: 1,
          time: times[index],
          reverse: false
        });

        const txByTimeRev = await wallet.listUnconfirmedByTime(-1, {
          limit: 1,
          time: times[index],
          reverse: true
        });

        assert.bufferEqual(txByTime[0].hash, mtx.hash());
        assert.bufferEqual(txByTimeRev[0].hash, mtx.hash());
      }
    });

    it('should not decrement count: unconfirmed -> erase', async () => {
      const totalTXs = 10;
      const mtxs = [];

      for (let i = 0; i < 10; i++) {
        const mtx = await dummyTX(wallet);
        await wdb.addTX(mtx.toTX());
        mtxs.push(mtx);
      }

      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, totalTXs);

      for (const mtx of mtxs)
        await wallet.remove(mtx.hash());

      const uCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(uCount.index, totalTXs);
    });

    it('should not decrement count: confirmed -> erase', async () => {
      const totalTXs = 10;
      const entries = [];

      for (let i = 0; i < totalTXs; i++) {
        const cbTX = await dummyTX(wallet);
        cbTX.inputs[0].prevout.hash = consensus.ZERO_HASH;
        cbTX.inputs[0].prevout.index = 0xffffffff;
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, [cbTX.toTX()]);
        entries.push(entry);
      }

      const initUCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(initUCount.index, totalTXs);

      // Coinbase txs will get erased after remove block.
      for (const entry of entries.reverse())
        await wdb.removeBlock(entry);

      const uCount = await wallet.txdb.getLatestUnconfirmedTXCount();
      assert.strictEqual(uCount.index, totalTXs);

      const txs = await wallet.listHistory(-1, {
        limit: MAX_HISTORY,
        reverse: true
      });

      assert.strictEqual(txs.length, 0);
    });
  });

  describe('Query TXs', function() {
    // default unconfirmed
    const defAcc = {
      name: DEFAULT,
      unconf: 40,
      conf: 40,

      unconfHashes: [],
      unconfByTime: new Map(),
      confHashes: [],
      confByTime: new Map()
    };

    const altAcc = {
      name: ALT_ACCOUNT,
      unconf: 40,
      conf: 40,

      unconfHashes: [],
      unconfByTime: new Map(),
      confHashes: [],
      confByTime: new Map()
    };

    const total = {
      name: -1,
      unconf: defAcc.unconf + altAcc.unconf,
      conf: defAcc.conf + altAcc.conf,

      unconfHashes: [],
      unconfByTime: new Map(),
      confHashes: [],
      confByTime: new Map()
    };

    before(async () => {
      await setupWDB();

      assert(defAcc.unconf % 4 === 0);
      assert(altAcc.unconf % 4 === 0);
      assert(defAcc.conf % 2 === 0);
      assert(altAcc.conf % 2 === 0);

      const setupUnconfirmed = async (account) => {
        // We grab time - 1, since we are incrementing after each insertion.
        // half unconfirmed
        for (let i = 0; i < account.unconf / 2; i++) {
          const mtx = await dummyTX(wallet, account.name);
          await wdb.addTX(mtx.toTX());

          account.unconfHashes.push(mtx.hash());
          total.unconfHashes.push(mtx.hash());
          account.unconfByTime.set(timeCounter - 1, mtx.hash());
          total.unconfByTime.set(timeCounter - 1, mtx.hash());
        }

        let entries = [];
        // 1/4 confirmed -> unconfirmed
        for (let i = 0; i < account.unconf / 4; i++) {
          const mtx = await dummyTX(wallet, account.name);
          const entry = nextEntry(wdb);
          await wdb.addBlock(entry, [mtx.toTX()]);
          entries.push(entry);

          account.unconfHashes.push(mtx.hash());
          total.unconfHashes.push(mtx.hash());
          account.unconfByTime.set(timeCounter - 1, mtx.hash());
          total.unconfByTime.set(timeCounter - 1, mtx.hash());
        }

        for (const entry of entries.reverse())
          await wdb.removeBlock(entry);

        // 1/4 unconfirmed -> confirmed -> unconfirmed
        entries = [];

        for (let i = 0; i < account.unconf / 4; i++) {
          const mtx = await dummyTX(wallet, account.name);
          await wdb.addTX(mtx.toTX());
          const entry = nextEntry(wdb);
          await wdb.addBlock(entry, [mtx.toTX()]);
          entries.push(entry);

          account.unconfHashes.push(mtx.hash());
          total.unconfHashes.push(mtx.hash());
          account.unconfByTime.set(timeCounter - 1, mtx.hash());
          total.unconfByTime.set(timeCounter - 1, mtx.hash());
        }

        for (const entry of entries.reverse())
          await wdb.removeBlock(entry);
      };

      const setupConfirmed = async (account) => {
        const addConfirmedByTime = (mtp, mtx) => {
          // account specific
          const accList = account.confByTime.get(mtp) || [];
          accList.push(mtx.hash());
          account.confByTime.set(mtp, accList);

          const totalList = total.confByTime.get(mtp) || [];
          totalList.push(mtx.hash());
          total.confByTime.set(mtp, totalList);
        };

        // half direct confirmed
        for (let i = 0; i < account.conf / 2; i++) {
          const mtx = await dummyTX(wallet, account.name);
          const entry = nextEntry(wdb);
          await wdb.addBlock(entry, [mtx.toTX()]);

          const mtp = await wdb.getMedianTime(entry.height);
          addConfirmedByTime(mtp, mtx);

          account.confHashes.push(mtx.hash());
          total.confHashes.push(mtx.hash());
        }

        // half unconfirmed -> confirmed
        for (let i = 0; i < account.conf / 2; i++) {
          const mtx = await dummyTX(wallet, account.name);
          await wdb.addTX(mtx.toTX());
          const entry = nextEntry(wdb);
          await wdb.addBlock(entry, [mtx.toTX()]);

          const mtp = await wdb.getMedianTime(entry.height);
          addConfirmedByTime(mtp, mtx);

          account.confHashes.push(mtx.hash());
          total.confHashes.push(mtx.hash());
        }
      };

      // Add 3 blocks to correct mtp.
      for (let i = 0; i < 3; i++) {
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, []);
      }

      await setupUnconfirmed(defAcc);
      await setupUnconfirmed(altAcc);
      await setupConfirmed(defAcc);
      await setupConfirmed(altAcc);

      const balance = await wallet.getBalance();
      assert.strictEqual(balance.tx, total.unconf + total.conf);
    });

    after(async () => {
      await cleanupWDB();
    });

    it('should query unconfirmed (asc)', async () => {
      const check = async (accountInfo, limit) => {
        const history = await wallet.listUnconfirmed(accountInfo.name, {
          limit: limit,
          reverse: false
        });

        assert.strictEqual(history.length, limit);
        assert.deepStrictEqual(
          history.map(entry => entry.hash),
          accountInfo.unconfHashes.slice(0, limit)
        );
      };

      for (let i = 1; i < MAX_HISTORY; i++) {
        await check(defAcc, i);
        await check(altAcc, i);
        await check(total, i);
      }
    });

    it('should query unconfirmed (desc)', async () => {
      const check = async (accountInfo, limit) => {
        const history = await wallet.listUnconfirmed(accountInfo.name, {
          limit: limit,
          reverse: true
        });

        const hashes = accountInfo.unconfHashes;
        assert.strictEqual(history.length, limit);
        assert.deepStrictEqual(
          history.map(entry => entry.hash).reverse(),
          hashes.slice(hashes.length - limit)
        );
      };

      for (let i = 1; i < MAX_HISTORY; i++) {
        await check(defAcc, i);
        await check(altAcc, i);
        await check(total, i);
      }
    });

    it('should query unconfirmed after (asc)', async () => {
      const check = async (accountID, hashes) => {
        const listAfter = await wallet.listUnconfirmedAfter(accountID, {
          hash: hashes[0],
          limit: MAX_HISTORY,
          reverse: false
        });

        const len = Math.min(MAX_HISTORY, hashes.length - 1);
        assert.strictEqual(listAfter.length, len);
        assert.deepStrictEqual(
          listAfter.map(entry => entry.hash),
          hashes.slice(1, len + 1)
        );
      };

      // slide the hashes
      for (let i = 0; i < defAcc.unconfHashes.length; i++) {
        await check(DEFAULT, defAcc.unconfHashes.slice(i), MAX_HISTORY);
      }

      for (let i = 0; i < altAcc.unconfHashes.length; i++) {
        await check(ALT_ACCOUNT, altAcc.unconfHashes.slice(i), MAX_HISTORY);
      }

      for (let i = 0; i < total.unconfHashes.length; i++) {
        await check(-1, total.unconfHashes.slice(i), MAX_HISTORY);
      }
    });

    it('should query unconfirmed after (desc)', async () => {
      const check = async (accountID, hashes) => {
        const listAfter = await wallet.listUnconfirmedAfter(accountID, {
          hash: hashes[0],
          limit: MAX_HISTORY,
          reverse: true
        });

        const len = Math.min(MAX_HISTORY, hashes.length - 1);
        assert.strictEqual(listAfter.length, len);
        const hashesSlice = hashes.slice(1, len + 1);
        assert.deepStrictEqual(
          listAfter.map(entry => entry.hash),
          hashesSlice
        );
      };

      for (let i = 1; i < defAcc.unconfHashes.length; i++)
        await check(DEFAULT, defAcc.unconfHashes.slice(0, -i).reverse());

      for (let i = 1; i < altAcc.unconfHashes.length; i++)
        await check(ALT_ACCOUNT, altAcc.unconfHashes.slice(0, -i).reverse());

      for (let i = 1; i < total.unconfHashes.length; i++)
        await check(-1, total.unconfHashes.slice(0, -i).reverse());
    });

    it('should query unconfirmed by time (asc)', async () => {
      const check = async (accountID, time, hashes) => {
        const listByTime = await wallet.listUnconfirmedByTime(accountID, {
          limit: MAX_HISTORY,
          time: time,
          reverse: false
        });

        const len = Math.min(MAX_HISTORY, hashes.length);
        assert.strictEqual(listByTime.length, len);
        assert.deepStrictEqual(
          listByTime.map(entry => entry.hash),
          hashes.slice(0, len)
        );
      };

      const checkForAccount = async (accountInfo) => {
        let i = 0;
        for (const [time, hash] of accountInfo.unconfByTime.entries()) {
          const checkHash = accountInfo.unconfHashes[i];
          assert.bufferEqual(hash, checkHash);

          await check(accountInfo.name, time, accountInfo.unconfHashes.slice(i));
          i++;
        }
      };

      await checkForAccount(defAcc);
      await checkForAccount(altAcc);
      await checkForAccount(total);
    });

    it('should query unconfirmed by time (desc)', async () => {
      const check = async (accountID, time, hashes) => {
        const listByTime = await wallet.listUnconfirmedByTime(accountID, {
          limit: MAX_HISTORY,
          time: time,
          reverse: true
        });

        const len = Math.min(MAX_HISTORY, hashes.length);

        assert.strictEqual(listByTime.length, len);
        const hashesSlice = hashes.slice(0, len);
        assert.deepStrictEqual(
          listByTime.map(entry => entry.hash),
          hashesSlice
        );
      };

      const checkForAccount = async (accountInfo) => {
        let i = accountInfo.unconfHashes.length;

        const entries = Array.from(accountInfo.unconfByTime.entries());

        for (const [time, hash] of entries.reverse()) {
          const checkHash = accountInfo.unconfHashes[i - 1];
          assert.bufferEqual(hash, checkHash);

          const hashes = accountInfo.unconfHashes.slice(0, i).reverse();
          await check(accountInfo.name, time, hashes);
          i--;
        }
      };

      for (const account of [defAcc, altAcc, total])
        await checkForAccount(account);

      for (const account of [defAcc, altAcc, total]) {
        const hashes = account.unconfHashes;
        const from = hashes.length - MAX_HISTORY;
        await check(account.name, MAX_TIME, hashes.slice(from).reverse());
      }
    });

    it('should query history (asc)', async () => {
      const check = async (accountInfo, limit) => {
        const history = await wallet.listHistory(accountInfo.name, {
          limit: limit,
          reverse: false
        });

        assert.strictEqual(history.length, limit);
        assert.deepStrictEqual(
          history.map(entry => entry.hash),
          accountInfo.confHashes.slice(0, limit)
        );
      };

      for (let i = 0; i < MAX_HISTORY; i++) {
        await check(defAcc, i);
        await check(altAcc, i);
        await check(total, i);
      }
    });

    it('should query history (desc)', async () => {
      const check = async (accountInfo, limit) => {
        const history = await wallet.listHistory(accountInfo.name, {
          limit: limit,
          reverse: true
        });

        // Unconfirmed txs are the newest ones.
        const hashes = accountInfo.unconfHashes;
        assert.strictEqual(history.length, limit);
        assert.deepStrictEqual(
          history.map(entry => entry.hash).reverse(),
          hashes.slice(hashes.length - limit)
        );
      };

      for (let i = 0; i < MAX_HISTORY; i++) {
        await check(defAcc, i);
        await check(altAcc, i);
        await check(total, i);
      }
    });

    it('should query history after (asc)', async () => {
      const check = async (accountID, hashes) => {
        const listAfter = await wallet.listHistoryAfter(accountID, {
          hash: hashes[0],
          limit: MAX_HISTORY,
          reverse: false
        });

        const len = Math.min(MAX_HISTORY, hashes.length - 1);
        assert.strictEqual(listAfter.length, len);
        assert.deepStrictEqual(
          listAfter.map(entry => entry.hash),
          hashes.slice(1, len + 1)
        );
      };

      for (const account of [defAcc, altAcc, total]) {
        const all = account.confHashes.concat(account.unconfHashes);

        for (let i = 0; i < all.length; i++)
          await check(account.name, all.slice(i));
      }
    });

    it('should query history after (desc)', async () => {
      const check = async (accountID, hashes) => {
        const listAfter = await wallet.listHistoryAfter(accountID, {
          hash: hashes[0],
          limit: MAX_HISTORY,
          reverse: true
        });

        const len = Math.min(MAX_HISTORY, hashes.length - 1);
        assert.strictEqual(listAfter.length, len);
        const hashesSlice = hashes.slice(1, len + 1);
        assert.deepStrictEqual(
          listAfter.map(entry => entry.hash),
          hashesSlice
        );
      };

      for (const account of [defAcc, altAcc, total]) {
        const all = account.confHashes.concat(account.unconfHashes);

        for (let i = 1; i < all.length; i++)
          await check(account.name, all.slice(0, -i).reverse());
      }
    });

    it('should query history by time (asc)', async () => {
      const check = async (accountID, time, hashes) => {
        const listByTime = await wallet.listHistoryByTime(accountID, {
          limit: MAX_HISTORY,
          time: time,
          reverse: false
        });

        const len = Math.min(MAX_HISTORY, hashes.length);
        assert.strictEqual(listByTime.length, len);
        assert.deepStrictEqual(
          listByTime.map(entry => entry.hash),
          hashes.slice(0, len)
        );
      };

      for (const account of [defAcc, altAcc, total]) {
        for (const [time, hashes] of account.confByTime.entries()) {
          // Because mtp can be same for two blocks, we need to find the
          // first confirmed tx in the list.
          const first = hashes[0];
          assert(first);
          const index = bufIndexOf(first, account.confHashes);
          assert.notStrictEqual(index, -1);

          // historyByTime, even though it only indexes confirmed tx times,
          // will continue to return unconfirmed txs after the confirmed txs.
          const confirmed = account.confHashes.slice(index);
          const unconfirmed = account.unconfHashes;
          await check(account.name, time, confirmed.concat(unconfirmed));
        }
      }
    });

    it('should query history by time (desc)', async () => {
      const check = async (accountID, time, hashes) => {
        const listByTime = await wallet.listHistoryByTime(accountID, {
          limit: MAX_HISTORY,
          time: time,
          reverse: true
        });

        const len = Math.min(MAX_HISTORY, hashes.length);
        assert.strictEqual(listByTime.length, len);
        const hashesSlice = hashes.slice(0, len);
        assert.deepStrictEqual(
          listByTime.map(entry => entry.hash),
          hashesSlice
        );
      };

      const checkForAccount = async (accountInfo) => {
        const entries = Array.from(accountInfo.confByTime.entries());

        for (const [time, hashes] of entries.reverse()) {
          // Because mtp can be same for two blocks, we need to find the
          // last confirmed tx in the list. (desc)
          const last = hashes[hashes.length - 1];
          assert(last);

          const index = bufIndexOf(last, accountInfo.confHashes);
          assert.notStrictEqual(index, -1);

          // because we are going in reverse, we no longer need to
          // include unconfirmed txs.
          const checkHashes = accountInfo.confHashes.slice(0, index + 1).reverse();
          await check(accountInfo.name, time, checkHashes);
        }
      };

      for (const account of [defAcc, altAcc, total])
        await checkForAccount(account);

      // Because query by history only looks up first confirmed tx in the list,
      // we wont encounter unconfirmed txs, even if they are newer.
      for (const account of [defAcc, altAcc, total]) {
        const hashes = account.confHashes;
        const from = hashes.length - MAX_HISTORY;
        await check(account.name, MAX_TIME, hashes.slice(from).reverse());
      }
    });
  });

  describe('Index/Query', function() {
    beforeEach(setupWDB);
    afterEach(cleanupWDB);

    it('should fail to query more than max history', async () => {
      const N = MAX_HISTORY + 1;
      const methods = [{
        method: wallet.listHistory,
        args: [-1, {
          limit: N,
          reverse: false
        }]
      }, {
        method: wallet.listHistoryByTime,
        args: [-1, {
          limit: N,
          reverse: false,
          time: GENESIS_TIME
        }]
      }, {
        method: wallet.listHistoryAfter,
        args: [-1, {
          limit: N,
          reverse: false,
          hash: consensus.ZERO_HASH
        }]
      }, {
        method: wallet.listHistoryFrom,
        args: [-1, {
          limit: N,
          reverse: false,
          hash: consensus.ZERO_HASH
        }]
      }, {
        method: wallet.listUnconfirmed,
        args: [-1, {
          limit: N,
          reverse: false
        }]
      }, {
        method: wallet.listUnconfirmedByTime,
        args: [-1, {
          limit: N,
          reverse: false,
          time: GENESIS_TIME
        }]
      }, {
        method: wallet.listUnconfirmedAfter,
        args: [-1, {
          limit: N,
          reverse: false,
          hash: consensus.ZERO_HASH
        }]
      }, {
        method: wallet.listUnconfirmedFrom,
        args: [-1, {
          limit: N,
          reverse: false,
          hash: consensus.ZERO_HASH
        }]
      }];

      for (const {method, args} of methods) {
        let err;

        try {
          await method.call(wallet, ...args);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, `Limit exceeds max of ${MAX_HISTORY}.`);
      }
    });

    it('should query empty history (unconfirmed)', async () => {
      const ucTXs = await wallet.listUnconfirmed(-1, {
        limit: MAX_HISTORY,
        reverse: false
      });

      assert.strictEqual(ucTXs.length, 0);
    });

    it('should query empty history (confirmed)', async () => {
      const cTXs = await wallet.listHistory(-1, {
        limit: MAX_HISTORY,
        reverse: false
      });

      assert.strictEqual(cTXs.length, 0);
    });

    it('should query empty history by time (unconfirmed)', async () => {
      const ucTXs = await wallet.listUnconfirmedByTime(-1, {
        limit: MAX_HISTORY,
        reverse: false,
        time: GENESIS_TIME
      });

      assert.strictEqual(ucTXs.length, 0);
    });

    it('should query empty history by time (confirmed)', async () => {
      const cTXs = await wallet.listHistoryByTime(-1, {
        limit: MAX_HISTORY,
        reverse: false,
        time: GENESIS_TIME
      });

      assert.strictEqual(cTXs.length, 0);
    });

    it('should fail to query after (unconfirmed)', async () => {
      let err;

      try {
        await wallet.listUnconfirmedAfter(-1, {
          hash: consensus.ZERO_HASH,
          limit: MAX_HISTORY,
          reverse: false
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Transaction not found.');
    });

    it('should fail to query after (unconfirmed) when it is confirmed', async () => {
      // create confirmed entry.
      const mtx = await dummyTX(wallet);
      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, [mtx.toTX()]);

      let err;

      try {
        await wallet.listUnconfirmedAfter(-1, {
          hash: mtx.hash(),
          limit: MAX_HISTORY,
          reverse: false
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Transaction is confirmed.');
    });

    it('should fail to query after (confirmed)', async () => {
      let err;

      try {
        await wallet.listHistoryAfter(-1, {
          hash: consensus.ZERO_HASH,
          limit: MAX_HISTORY,
          reverse: false
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Transaction not found.');
    });

    it('should reindex newly unconfirmed txs after disconnect', async () => {
      const N = 2;

      const toConfirm = [];
      for (let i = 0; i < N; i++) {
        const address = await wdb.primary.receiveAddress();
        const mtx = new MTX();
        mtx.addInput(dummyInput());
        mtx.addOutput(address, 1);

        const tx = mtx.toTX();
        toConfirm.push(tx);
        await wdb.addTX(tx);
      }

      {
        const unconfirmed = await wdb.primary.listUnconfirmed(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        assert.strictEqual(unconfirmed.length, N);
      }

      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, toConfirm);

      {
        const unconfirmed = await wdb.primary.listUnconfirmed(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        assert.strictEqual(unconfirmed.length, 0);
      }

      for (let i = 0; i < N; i++) {
        const address = await wdb.primary.receiveAddress();
        const mtx = new MTX();
        mtx.addInput(dummyInput());
        mtx.addOutput(address, 1);

        const tx = mtx.toTX();
        toConfirm.push(tx);
        await wdb.addTX(tx);
      }

      {
        const unconfirmed = await wdb.primary.listUnconfirmed(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        const all = await wdb.primary.listHistory(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        assert.strictEqual(unconfirmed.length, N);
        assert.strictEqual(all.length, N * 2);
      }

      await wdb.removeBlock(entry);

      {
        const unconfirmed = await wdb.primary.listUnconfirmed(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        const all = await wdb.primary.listHistory(0, {
          limit: MAX_HISTORY,
          reverse: false
        });

        assert.strictEqual(unconfirmed.length, N * 2);
        assert.strictEqual(all.length, N * 2);
      }
    });

    it('should query confirmed by time when unconfirmed txs are present', async () => {
      // calculate median time for the block
      const wdbLike = {
        state: {
          height: 0
        }
      };
      const entries = [null];

      for (let i = 0; i < 3; i++) {
        entries.push(nextEntry(wdbLike));
        wdbLike.state.height++;
      }

      const mtp = entries[entries.length >>> 1].time;
      wallet.txdb.nowFn = () => mtp;

      const tx = await dummyTX(wallet);
      await wdb.addTX(tx.toTX());

      wallet.txdb.nowFn = util.now;

      for (let i = 0; i < entries.length - 2; i++) {
        await wdb.addBlock(entries[1 + i], []);
      }

      const lastEntry = entries[entries.length - 1];
      const confTX = await dummyTX(wallet);
      await wdb.addTX(confTX.toTX());
      await wdb.addBlock(lastEntry, [confTX.toTX()]);

      // check mtp
      const wdbMTP = await wdb.getMedianTime(lastEntry.height);
      assert.strictEqual(wdbMTP, mtp);

      // Only return unconfirmed time
      {
        const txByTime = await wallet.listUnconfirmedByTime(-1, {
          limit: 1,
          time: mtp,
          reverse: false
        });

        const txByTimeRev = await wallet.listUnconfirmedByTime(-1, {
          limit: 1,
          time: mtp,
          reverse: true
        });

        assert.bufferEqual(txByTime[0].hash, tx.hash());
        assert.bufferEqual(txByTimeRev[0].hash, tx.hash());
      }

      // History should return confirmed tx by time.
      {
        const txByTime = await wallet.listHistoryByTime(-1, {
          limit: 1,
          time: mtp,
          reverse: false
        });

        const txByTimeRev = await wallet.listHistoryByTime(-1, {
          limit: 1,
          time: mtp,
          reverse: true
        });

        assert.bufferEqual(txByTime[0].hash, confTX.hash());
        assert.bufferEqual(txByTimeRev[0].hash, confTX.hash());
      }
    });
  });
});

/**
 * @param {Wallet} wallet
 * @param {(String|Number)} [account]
 * @param {Number} [value=10000]
 * @returns {Promise<MTX>}
 */

async function dummyTX(wallet, account = 'default', value = 10000) {
  const addr = await wallet.receiveAddress(account);
  const mtx = new MTX();
  mtx.addInput(dummyInput());
  mtx.addOutput(addr, value);
  return mtx;
};

/**
 * Index of using buffers.
 * @param {Buffer} needle
 * @param {Buffer[]} haystack
 * @returns {Number}
 */

function bufIndexOf(needle, haystack) {
  for (let i = 0; i < haystack.length; i++) {
    if (needle.equals(haystack[i]))
      return i;
  }

  return -1;
}
