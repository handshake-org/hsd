'use strict';

const assert = require('bsert');
const {forEventCondition} = require('./common');

exports.generateInitialBlocks = async (options) => {
  const {
    nodeCtx,
    coinbase,
    sendTXs,
    singleAccount,
    genesisTime
  } = options;

  const blockInterval = 600;
  const timewrap = 3200;

  async function mineBlock(coinbase, wrap = false) {
    const height = nodeCtx.height;
    let blocktime = genesisTime + (height + 1) * blockInterval;

    if (wrap && height % 5)
      blocktime -= timewrap;

    await nodeCtx.nclient.execute('setmocktime', [blocktime]);

    const blocks = await nodeCtx.mineBlocks(1, coinbase);
    const firstHash = blocks[0].hash().toString('hex');
    const block = await nodeCtx.nclient.execute('getblock', [firstHash]);

    assert(block.time <= blocktime + 1);
    assert(block.time >= blocktime);

    return block;
  }

  let c = 0;

  // Establish baseline block interval for a median time
  for (; c < 11; c++)
    await mineBlock(coinbase);

  const h20 = entry => entry.height === 20;
  const walletEvents = forEventCondition(nodeCtx.wdb, 'block connect', h20);

  for (; c < 20; c++)
    await mineBlock(coinbase, true);

  await walletEvents;

  // 20 blocks * (20 txs per wallet, 19 default + 1 single account)
  for (; c < 40; c++) {
    await sendTXs(19);
    await sendTXs(1, singleAccount);
    await mineBlock(coinbase, true);
  }
};
