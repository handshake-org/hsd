'use strict';

const consensus = require('../lib/protocol/consensus');
const TX = require('../lib/primitives/tx');
const Block = require('../lib/primitives/block');
const Address = require('../lib/primitives/address');
const Witness = require('../lib/script/witness');
const util = require('../lib/utils/util');

const secp256k1 = require('bcrypto/lib/secp256k1');
const hash160 = require('bcrypto/lib/hash160');
const hex = ''
  + '0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5c'
  + 'b2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3';
const uncompressed = Buffer.from(hex, 'hex');
const key = secp256k1.publicKeyConvert(uncompressed, true);
const keyHash = hash160.digest(key);

function createGenesisBlock(options) {
  let flags = options.flags;
  let addr = options.address;
  let nonce = options.nonce;
  let sol = options.solution;

  if (!flags) {
    flags = Buffer.from(
      '01/Nov/2017 EFF to ICANN: Don\'t Pick Up the Censor\'s Pen',
      'ascii');
  }

  if (!addr)
    addr = Address.fromHash(keyHash, 0);

  if (!nonce)
    nonce = Buffer.alloc(16, 0x00);

  if (!sol)
    sol = new Uint32Array(2);

  const tx = new TX({
    version: 0,
    inputs: [{
      prevout: {
        hash: consensus.NULL_HASH,
        index: 0xffffffff
      },
      witness: new Witness([flags]),
      sequence: 0xffffffff
    }],
    outputs: [{
      value: 50 * consensus.COIN,
      address: addr
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
    nonce: nonce,
    solution: sol
  });

  block.txs.push(tx);

  return block;
}

const main = createGenesisBlock({
  time: 1514765688,
  bits: 0x207fffff,
  solution: new Uint32Array(42)
});

const testnet = createGenesisBlock({
  time: 1514765689,
  bits: 0x207fffff,
  solution: new Uint32Array(18)
});

const regtest = createGenesisBlock({
  time: 1514765690,
  bits: 0x207fffff,
  solution: new Uint32Array(18)
});

const simnet = createGenesisBlock({
  time: 1514765691,
  bits: 0x207fffff,
  solution: new Uint32Array(18)
});

function formatBlock(name, block) {
  return `${name}.genesis = {
  version: ${block.version},
  hash: '${block.hash('hex')}',
  prevBlock: '${block.prevBlock}',
  merkleRoot:
    '${block.merkleRoot}',
  witnessRoot:
    '${block.witnessRoot}',
  reservedRoot:
    '${block.reservedRoot}',
  time: ${block.time},
  bits: 0x${util.hex32(block.bits)},
  nonce: Buffer.from('${block.nonce.toString('hex')}', 'hex'),
  solution: new Uint32Array(${block.solution.size()}),
  height: 0
};`;
}

function formatRaw(name, block) {
  const str = block.toRaw().toString('hex');

  let out = `${name}.genesisBlock = ''\n`;

  for (let i = 0; i < str.length; i += 64)
    out += `  + '${str.slice(i, i + 64)}'\n`;

  out = out.slice(0, -1) + ';';

  return out;
}

function dump(name, block) {
  const blk = formatBlock(name, block);
  const raw = formatRaw(name, block);

  console.log(blk);
  console.log('');
  console.log(raw);
  console.log('');
}

dump('main', main);
dump('testnet', testnet);
dump('regtest', regtest);
dump('simnet', simnet);

console.log(JSON.stringify(testnet.toJSON(), null, 2));
