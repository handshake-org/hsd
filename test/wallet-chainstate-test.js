'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const WorkerPool = require('../lib/workers/workerpool');
const WalletDB = require('../lib/wallet/walletdb');
const wutils = require('./util/wallet');
const {
  dummyInput,
  nextEntry
} = wutils;

const enabled = true;
const size = 2;
const network = Network.get('main');

describe('WalletDB ChainState', function() {
  /** @type {WorkerPool} */
  let workers = null;
  /** @type {WalletDB} */
  let wdb = null;

  const progressWithTX = async (wdb) => {
    const addr = await wdb.primary.receiveAddress();
    const mtx = new MTX();
    mtx.addInput(dummyInput());
    mtx.addOutput(addr, 10000);

    const block = nextEntry(wdb);
    const txs = [mtx.toTX()];
    await wdb.addBlock(block, txs);

    return {block, txs};
  };

  const progressWithNoTX = async (wdb) => {
    const block = nextEntry(wdb);
    const txs = [];

    await wdb.addBlock(block, txs);
    return {block, txs};
  };

  beforeEach(async () => {
    workers = new WorkerPool({ enabled, size });
    wdb = new WalletDB({ workers, network });
    await workers.open();
    await wdb.open();
  });

  afterEach(async () => {
    await wdb.close();
    await workers.close();
  });

  it('should have initial state', () => {
    assert.strictEqual(wdb.state.startHeight, 0);
    assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
    assert.strictEqual(wdb.height, 0);
    assert.strictEqual(wdb.state.height, 0);
    assert.strictEqual(wdb.state.marked, false);
  });

  it('should progress height but not startHeight w/o txs', async () => {
    const blocks = 10;

    for (let i = 0; i < blocks; i++) {
      await progressWithNoTX(wdb);
      assert.strictEqual(wdb.state.startHeight, 0);
      assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
      assert.strictEqual(wdb.height, i + 1);
      assert.strictEqual(wdb.state.height, i + 1);
      assert.strictEqual(wdb.state.marked, false);
    }

    assert.strictEqual(wdb.state.startHeight, 0);
    assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
    assert.strictEqual(wdb.height, blocks);
    assert.strictEqual(wdb.state.height, blocks);
    assert.strictEqual(wdb.state.marked, false);
  });

  it('should change startHeight when receiveing txs', async () => {
    const beforeBlocks = 10;
    const blocks = 10;

    for (let i = 0; i < beforeBlocks; i++) {
      await progressWithNoTX(wdb);
      assert.strictEqual(wdb.state.startHeight, 0);
      assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
      assert.strictEqual(wdb.height, i + 1);
      assert.strictEqual(wdb.state.height, i + 1);
      assert.strictEqual(wdb.state.marked, false);
    }

    let firstBlock = null;
    for (let i = 0; i < blocks; i++) {
      const {block} = await progressWithTX(wdb);

      if (!firstBlock)
        firstBlock = block;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, beforeBlocks + i + 1);
      assert.strictEqual(wdb.state.height, beforeBlocks + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, beforeBlocks + blocks);
    assert.strictEqual(wdb.state.height, beforeBlocks + blocks);
    assert.strictEqual(wdb.state.marked, true);
  });

  it('should not change startHeight once marked w/o txs', async () => {
    const noTXBlocks1 = 5;
    const txBlocks1 = 5;
    const noTXBlocks2 = 5;
    const txBlocks2 = 5;

    let height = 0;
    let firstBlock = null;

    for (let i = 0; i < noTXBlocks1; i++) {
      await progressWithNoTX(wdb);
      height++;

      assert.strictEqual(wdb.state.startHeight, 0);
      assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
      assert.strictEqual(wdb.height, height);
      assert.strictEqual(wdb.state.height, height);
      assert.strictEqual(wdb.state.marked, false);
    }

    for (let i = 0; i < txBlocks1; i++) {
      const {block} = await progressWithTX(wdb);
      height++;

      if (!firstBlock)
        firstBlock = block;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, height);
      assert.strictEqual(wdb.state.height, height);
      assert.strictEqual(wdb.state.marked, true);
    }

    for (let i = 0; i < noTXBlocks2; i++) {
      await progressWithNoTX(wdb);
      height++;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, height);
      assert.strictEqual(wdb.state.height, height);
      assert.strictEqual(wdb.state.marked, true);
    }

    for (let i = 0; i < txBlocks2; i++) {
      await progressWithTX(wdb);
      height++;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, height);
      assert.strictEqual(wdb.state.height, height);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBlocks1 + noTXBlocks1 + txBlocks1 + txBlocks2);
    assert.strictEqual(wdb.state.height, noTXBlocks1 + noTXBlocks1 + txBlocks1 + txBlocks2);
    assert.strictEqual(wdb.state.marked, true);
  });

  it('should not change startHeight once marked on reorg (future reorgs)', async () => {
    const noTXBuffer = 10;
    const blocksPerAction = 5;
    let firstBlock = null;

    for (let i = 0; i < noTXBuffer; i++)
      await progressWithNoTX(wdb);

    for (let i = 0; i < blocksPerAction; i++) {
      const {block} = await progressWithTX(wdb);

      if (!firstBlock)
        firstBlock = block;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.marked, true);

    const removeBlocks = [];
    // first 5 blocks with no txs. before reorg.
    for (let i = 0; i < blocksPerAction; i++) {
      const {block} = await progressWithNoTX(wdb);
      removeBlocks.push(block);

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    // Disconnect all the stuff.
    for (let i = 0; i < blocksPerAction; i++) {
      await wdb.removeBlock(removeBlocks.pop());

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2 - i - 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2 - i - 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(removeBlocks.length, 0);

    // Reconnect with txs.
    for (let i = 0; i < blocksPerAction; i++) {
      const {block} = await progressWithTX(wdb);
      removeBlocks.push(block);

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    // Disconnect all the stuff again.
    for (let i = 0; i < blocksPerAction; i++) {
      await wdb.removeBlock(removeBlocks.pop());

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2 - i - 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2 - i - 1);
      assert.strictEqual(wdb.state.marked, true);
    }
  });

  it('should should not change start height if reorg recovers txs at same height', async () => {
    const noTXBuffer = 10;
    const blocksPerAction = 5;
    let firstBlock = null;
    const removeBlocks = [];

    for (let i = 0; i < noTXBuffer; i++)
      await progressWithNoTX(wdb);

    for (let i = 0; i < blocksPerAction; i++) {
      const blockAndTXs = await progressWithNoTX(wdb);
      removeBlocks.push(blockAndTXs);
    }

    assert.strictEqual(wdb.state.startHeight, 0);
    assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.marked, false);

    for (let i = 0; i < blocksPerAction; i++) {
      const blockAndTXs = await progressWithTX(wdb);
      removeBlocks.push(blockAndTXs);

      if (!firstBlock)
        firstBlock = blockAndTXs.block;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.marked, true);

    const connectList = removeBlocks.slice();

    for (let i = 0; i < blocksPerAction - 1; i++) {
      const {block} = removeBlocks.pop();
      await wdb.removeBlock(block);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + 1);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + 1);
    assert.strictEqual(wdb.state.marked, true);

    // Remove last block after which chain state becomes unmarked.
    {
      const {block} = removeBlocks.pop();
      await wdb.removeBlock(block);
      const tip = await wdb.getTip();

      // this block is no longer ours, so it gets unmarked
      assert.strictEqual(wdb.state.startHeight, tip.height);
      assert.bufferEqual(wdb.state.startHash, tip.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction);
      assert.strictEqual(wdb.state.marked, false);
    }

    for (let i = 0; i < blocksPerAction; i++) {
      const {block} = removeBlocks.pop();
      await wdb.removeBlock(block);
      const tip = await wdb.getTip();

      assert.strictEqual(wdb.state.startHeight, tip.height);
      assert.bufferEqual(wdb.state.startHash, tip.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction - i - 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction - i - 1);
      assert.strictEqual(wdb.state.marked, false);
    }

    const tip = await wdb.getTip();
    assert.strictEqual(wdb.state.startHeight, tip.height);
    assert.bufferEqual(wdb.state.startHash, tip.hash);
    assert.strictEqual(wdb.height, noTXBuffer);
    assert.strictEqual(wdb.state.height, noTXBuffer);
    assert.strictEqual(wdb.state.marked, false);

    // Re add all the blocks.
    let marked = false;
    firstBlock = null;

    // Marked check only runs when there are transactions,
    // so startHeight and startHash will be left behind until
    // we find first block with txs.
    const checkEntry = {
      hash: tip.hash,
      height: tip.height
    };

    for (const [i, {block, txs}] of connectList.entries()) {
      await wdb.addBlock(block, txs);

      if (!firstBlock && txs.length > 0) {
        firstBlock = block;
        marked = true;
      }

      // First block marks and changes startHash, startHeight
      if (firstBlock) {
        checkEntry.hash = firstBlock.hash;
        checkEntry.height = firstBlock.height;
      }

      assert.strictEqual(wdb.state.startHeight, checkEntry.height);
      assert.bufferEqual(wdb.state.startHash, checkEntry.hash);
      assert.strictEqual(wdb.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.marked, marked);
    }
  });

  it('should change mark and startHeight on reorg to earlier', async () => {
    const noTXBuffer = 10;
    const blocksPerAction = 5;
    let firstBlock = null;
    const removeBlocks = [];

    for (let i = 0; i < noTXBuffer; i++)
      await progressWithNoTX(wdb);

    for (let i = 0; i < blocksPerAction; i++)
      removeBlocks.push(await progressWithNoTX(wdb));

    for (let i = 0; i < blocksPerAction; i++) {
      const blockAndTXs = await progressWithTX(wdb);
      if (!firstBlock)
        firstBlock = blockAndTXs.block;
      removeBlocks.push(blockAndTXs);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.marked, true);

    // revert all
    for (const {block} of removeBlocks.reverse())
      await wdb.removeBlock(block);

    const tip = await wdb.getTip();
    assert.strictEqual(wdb.state.startHeight, tip.height);
    assert.bufferEqual(wdb.state.startHash, tip.hash);
    assert.strictEqual(wdb.height, noTXBuffer);
    assert.strictEqual(wdb.state.height, noTXBuffer);
    assert.strictEqual(wdb.state.marked, false);

    // create new chain but all with txs.
    firstBlock = null;

    for (let i = 0; i < blocksPerAction; i++) {
      const blockAndTXs = await progressWithTX(wdb);

      if (!firstBlock)
        firstBlock = blockAndTXs.block;

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.marked, true);
  });

  it('should change mark and startHeight on reorg but later', async () => {
    const noTXBuffer = 10;
    const blocksPerAction = 5;
    let firstBlock = null;
    const removeBlocks = [];

    for (let i = 0; i < noTXBuffer; i++)
      await progressWithNoTX(wdb);

    for (let i = 0; i < blocksPerAction * 2; i++) {
      const blockAndTXs = await progressWithTX(wdb);
      if (!firstBlock)
        firstBlock = blockAndTXs.block;
      removeBlocks.push(blockAndTXs);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.marked, true);

    // revert all
    for (const {block} of removeBlocks.reverse())
      await wdb.removeBlock(block);

    const tip = await wdb.getTip();
    assert.strictEqual(wdb.state.startHeight, tip.height);
    assert.bufferEqual(wdb.state.startHash, tip.hash);
    assert.strictEqual(wdb.height, noTXBuffer);
    assert.strictEqual(wdb.state.height, noTXBuffer);
    assert.strictEqual(wdb.state.marked, false);

    for (let i = 0; i < blocksPerAction; i++) {
      await progressWithNoTX(wdb);

      assert.strictEqual(wdb.state.startHeight, tip.height);
      assert.bufferEqual(wdb.state.startHash, tip.hash);
      assert.strictEqual(wdb.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.marked, false);
    }

    assert.strictEqual(wdb.state.startHeight, tip.height);
    assert.bufferEqual(wdb.state.startHash, tip.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction);
    assert.strictEqual(wdb.state.marked, false);

    firstBlock = null;

    for (let i = 0; i < blocksPerAction; i++) {
      const blockAndTXs = await progressWithTX(wdb);
      if (!firstBlock)
        firstBlock = blockAndTXs.block;
      removeBlocks.push(blockAndTXs);

      assert.strictEqual(wdb.state.startHeight, firstBlock.height);
      assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
      assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + i + 1);
      assert.strictEqual(wdb.state.marked, true);
    }

    assert.strictEqual(wdb.state.startHeight, firstBlock.height);
    assert.bufferEqual(wdb.state.startHash, firstBlock.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction * 2);
    assert.strictEqual(wdb.state.marked, true);
  });

  it('should recover to the proper mark/startHeight after corruption', async () => {
    // If we receive a block that has TXs (meaning wdb should care) but it
    // DB/Node closes/crashes and restarted node does not have txs in the blocks.
    // startHeight and mark will be set incorrectly.
    const noTXBuffer = 10;
    const blocksPerAction = 5;

    for (let i = 0; i < noTXBuffer; i++)
      await progressWithNoTX(wdb);

    assert.strictEqual(wdb.state.startHeight, 0);
    assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
    assert.strictEqual(wdb.height, noTXBuffer);
    assert.strictEqual(wdb.state.height, noTXBuffer);
    assert.strictEqual(wdb.state.marked, false);

    // This will be the corruption case.
    const bakAdd = wdb.primary.add;
    wdb.primary.add = () => {
      throw new Error('Corruption');
    };

    let err;
    try {
      await progressWithTX(wdb);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'Corruption');

    assert.strictEqual(wdb.state.startHeight, 0);
    assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
    assert.strictEqual(wdb.height, noTXBuffer);
    assert.strictEqual(wdb.state.height, noTXBuffer);
    assert.strictEqual(wdb.state.marked, false);

    wdb.primary.add = bakAdd;

    // no tx blocks...
    for (let i = 0; i < blocksPerAction; i++) {
      await progressWithNoTX(wdb);

      assert.strictEqual(wdb.state.startHeight, 0);
      assert.bufferEqual(wdb.state.startHash, consensus.ZERO_HASH);
      assert.strictEqual(wdb.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.height, noTXBuffer + i + 1);
      assert.strictEqual(wdb.state.marked, false);
    }

    const {block} = await progressWithTX(wdb);
    assert.strictEqual(wdb.state.startHeight, block.height);
    assert.bufferEqual(wdb.state.startHash, block.hash);
    assert.strictEqual(wdb.height, noTXBuffer + blocksPerAction + 1);
    assert.strictEqual(wdb.state.height, noTXBuffer + blocksPerAction + 1);
    assert.strictEqual(wdb.state.marked, true);
  });
});
