'use strict';

const consensus = require('../lib/protocol/consensus');
const TX = require('../lib/primitives/tx');
const Block = require('../lib/primitives/block');
const Script = require('../lib/script/script');

function createGenesisBlock(options) {
  let flags = options.flags;
  let key = options.key;
  let reward = options.reward;

  if (!flags) {
    flags = Buffer.from(
      'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks',
      'ascii');
  }

  if (!key) {
    key = Buffer.from(''
      + '04678afdb0fe5548271967f1a67130b7105cd6a828e039'
      + '09a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c3'
      + '84df7ba0b8d578a4c702b6bf11d5f', 'hex');
  }

  if (!reward)
    reward = 50 * consensus.COIN;

  const tx = new TX({
    version: 1,
    inputs: [{
      prevout: {
        hash: consensus.NULL_HASH,
        index: 0xffffffff
      },
      script: (new Script())
        .pushInt(0)
        .pushData(flags)
        .compile(),
      sequence: 0xffffffff
    }],
    outputs: [{
      value: reward,
      script: Script.fromPubkey(key)
    }],
    locktime: 0
  });

  const block = new Block({
    version: 0,
    prevBlock: consensus.NULL_HASH,
    merkleRoot: tx.hash('hex'),
    witnessRoot: tx.witnessHash('hex'),
    reservedRoot: consensus.NULL_HASH,
    time: options.time,
    bits: options.bits,
    nonce: options.nonce,
    solution: options.solution
  });

  block.txs.push(tx);

  return block;
}

const main = createGenesisBlock({
  time: 1514765688,
  bits: 486604799,
  nonce: Buffer.alloc(16, 0x00),
  solution: new Uint32Array(42)
});

const testnet = createGenesisBlock({
  time: 1514765689,
  bits: 486604799,
  nonce: Buffer.alloc(16, 0x00),
  solution: new Uint32Array(42)
});

const regtest = createGenesisBlock({
  time: 1514765690,
  bits: 545259519,
  nonce: Buffer.alloc(16, 0x00),
  solution: new Uint32Array(42)
});

const simnet = createGenesisBlock({
  time: 1514765691,
  bits: 545259519,
  nonce: Buffer.alloc(16, 0x00),
  solution: new Uint32Array(42)
});

function format(block) {
  const str = block.toRaw().toString('hex');

  let out = '';

  for (let i = 0; i < str.length; i += 64)
    out += `  + '${str.slice(i, i + 64)}'\n`;

  return out;
}

console.log(main);
console.log('');
console.log(testnet);
console.log('');
console.log(regtest);
console.log('');
console.log(simnet);
console.log('');
console.log('');
console.log('main hash: %s', main.rhash());
console.log('main raw:');
console.log(format(main));
console.log('');
console.log('testnet hash: %s', testnet.rhash());
console.log('testnet raw:');
console.log(format(testnet));
console.log('');
console.log('regtest hash: %s', regtest.rhash());
console.log('regtest raw:');
console.log(format(regtest));
console.log('');
console.log('simnet hash: %s', simnet.rhash());
console.log('simnet raw:');
console.log(format(simnet));
