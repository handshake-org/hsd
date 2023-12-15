'use strict';

const assert = require('bsert');
const Network = require('../../lib/protocol/network');
const Chain = require('../../lib/blockchain/chain');
const Miner = require('../../lib/mining/miner');
const WorkerPool = require('../../lib/workers/workerpool');
const rules = require('../../lib/covenants/rules');
const store = require('../../lib/blockstore');
const {testdir} = require('./common');

const chainUtils = exports;

chainUtils.getChainBundle = (options) => {
  const name = options.name || 'chain-test';
  const prefix = options.prefix || testdir(name);
  const network = options.network || Network.get('regtest');
  const memory = Boolean(options.memory);
  let blocks, workers;

  if (!options.spv) {
    blocks = options.blocks;

    if (blocks == null) {
      blocks = store.create({
        location: prefix,
        memory,
        network
      });
    }
  }

  if (options.workers === true) {
    workers = new WorkerPool({
      enabled: true,
      size: 2
    });
  }

  if (options.workers instanceof WorkerPool)
    workers = options.workers;

  const chain = new Chain({
    ...options,
    prefix,
    blocks,
    memory,
    workers,
    network
  });

  const miner = new Miner({ chain, workers });

  if (options.address) {
    miner.addresses.length = 0;
    miner.addAddress(options.address);
  }

  return {
    chain,
    blocks,
    miner,
    workers
  };
};

chainUtils.openChainBundle = async (chainObj) => {
  const {
    chain,
    blocks,
    miner,
    workers
  } = chainObj;

  if (workers)
    await workers.open();

  if (blocks)
    await blocks.open();

  await chain.open();

  if (miner)
    await miner.open();
};

chainUtils.closeChainBundle = async (chainObj) => {
  const {
    chain,
    blocks,
    miner,
    workers
  } = chainObj;

  if (miner)
    await miner.close();

  await chain.close();

  if (blocks)
    await blocks.close();

  if (workers)
    await workers.close();
};

chainUtils.syncChain = async (fromChain,  toChain, startHeight) => {
  const endHeight = fromChain.tip.height;
  assert(startHeight <= endHeight);

  for (let i = startHeight + 1; i <= endHeight; i++) {
    const block = await fromChain.getBlock(i);
    assert(await toChain.add(block));
  }

  return endHeight - startHeight;
};

chainUtils.mineBlock = async (chainObj, mtxs) => {
  const tip = chainObj.chain.tip;
  const job = await chainObj.miner.createJob(tip);

  if (mtxs) {
    for (const mtx of mtxs) {
      const [tx, view] = mtx.commit();

      job.addTX(tx, view);
    }
  }

  job.refresh();

  const block = await job.mineAsync();
  const entry = await chainObj.chain.add(block);
  return { block, entry };
};

chainUtils.chainTreeHasName = async (chain, name) => {
  assert(!chain.options.spv);
  const hash = rules.hashName(name);
  return await chain.db.tree.get(hash) != null;
};

chainUtils.chainTxnHasName = async (chain, name) => {
  assert(!chain.options.spv);
  const hash = rules.hashName(name);
  return await chain.db.txn.get(hash) != null;
};
