'use strict';

const assert = require('assert');
const fs = require('bfile');
const Path = require('path');
const consensus = require('../lib/protocol/consensus');
const TX = require('../lib/primitives/tx');
const Block = require('../lib/primitives/block');
const Address = require('../lib/primitives/address');
const Witness = require('../lib/script/witness');
const Input = require('../lib/primitives/input');
const Output = require('../lib/primitives/output');
const util = require('../lib/utils/util');
const rules = require('../lib/covenants/rules');
const {types} = rules;

const secp256k1 = require('bcrypto/lib/secp256k1');
const hash160 = require('bcrypto/lib/hash160');
const hex = ''
  + '0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5c'
  + 'b2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3';
const uncompressed = Buffer.from(hex, 'hex');
const key = secp256k1.publicKeyConvert(uncompressed, true);
const keyHash = hash160.digest(key);
const ZERO_ROOT =
  '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314';

const {HSKResource} = require('../lib/covenants/record');
const root = require('../etc/root.json');
const names = Object.keys(root).sort();

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
      value: consensus.BASE_REWARD,
      address: addr
    }],
    locktime: 0
  });

  const block = new Block({
    version: 0,
    prevBlock: consensus.NULL_HASH,
    merkleRoot: tx.hash('hex'),
    witnessRoot: tx.witnessHash('hex'),
    trieRoot: ZERO_ROOT,
    time: options.time,
    bits: options.bits,
    nonce: nonce,
    solution: sol
  });

  block.txs.push(tx);

  const claim = new TX({
    version: 0,
    inputs: [{
      prevout: {
        hash: tx.hash('hex'),
        index: 0
      },
      witness: new Witness(),
      sequence: 0xffffffff
    }],
    outputs: [{
      value: consensus.BASE_REWARD,
      address: addr
    }],
    locktime: 0
  });

  for (const name of names) {
    const output = new Output();
    output.value = 0;
    output.address = addr;
    output.covenant.type = types.CLAIM;
    output.covenant.items.push(Buffer.from(name, 'ascii'));
    claim.outputs.push(output);
  }

  claim.refresh();

  const register = new TX({
    version: 0,
    inputs: [],
    outputs: [],
    locktime: 0
  });

  let i = 1;

  for (const name of names) {
    const res = HSKResource.fromJSON(root[name]);

    const input = Input.fromOutpoint(claim.outpoint(i));
    register.inputs.push(input);

    const output = new Output();
    output.value = 0;
    output.address = addr;
    output.covenant.type = types.REGISTER;
    output.covenant.items.push(Buffer.from(name, 'ascii'));
    output.covenant.items.push(res.toRaw());
    register.outputs.push(output);

    i += 1;
  }

  register.refresh();

  block.txs.push(claim);
  block.txs.push(register);
  block.merkleRoot = block.createMerkleRoot('hex');
  block.witnessRoot = block.createWitnessRoot('hex');

  return block;
}

/*
const tlds = require('handshake-names/build/tld');
const record = Buffer.from('00008000', 'hex');

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
      value: consensus.BASE_REWARD,
      address: addr
    }],
    locktime: 0
  });

  const block = new Block({
    version: 0,
    prevBlock: consensus.NULL_HASH,
    merkleRoot: tx.hash('hex'),
    witnessRoot: tx.witnessHash('hex'),
    trieRoot: ZERO_ROOT,
    time: options.time,
    bits: options.bits,
    nonce: nonce,
    solution: sol
  });

  block.txs.push(tx);

  const claim = new TX({
    version: 0,
    inputs: [{
      prevout: {
        hash: tx.hash('hex'),
        index: 0
      },
      witness: new Witness(),
      sequence: 0xffffffff
    }],
    outputs: [{
      value: consensus.BASE_REWARD,
      address: addr
    }],
    locktime: 0
  });

  for (const name of tlds) {
    const output = new Output();
    output.value = 0;
    output.address = addr;
    output.covenant.type = types.CLAIM;
    output.covenant.items.push(Buffer.from(name, 'ascii'));
    claim.outputs.push(output);
  }

  claim.refresh();

  const register = new TX({
    version: 0,
    inputs: [],
    outputs: [],
    locktime: 0
  });

  let i = 1;

  for (const name of tlds) {
    const input = Input.fromOutpoint(claim.outpoint(i));
    register.inputs.push(input);

    const output = new Output();
    output.value = 0;
    output.address = addr;
    output.covenant.type = types.REGISTER;
    output.covenant.items.push(Buffer.from(name, 'ascii'));
    output.covenant.items.push(record);
    register.outputs.push(output);

    i += 1;
  }

  register.refresh();

  block.txs.push(claim);
  block.txs.push(register);
  block.merkleRoot = block.createMerkleRoot('hex');
  block.witnessRoot = block.createWitnessRoot('hex');

  return block;
}
*/

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
  trieRoot:
    '${block.trieRoot}',
  time: ${block.time},
  bits: 0x${util.hex32(block.bits)},
  nonce: Buffer.from('${block.nonce.toString('hex')}', 'hex'),
  solution: new Uint32Array(${block.solution.size()}),
  height: 0
};`;
}

function toHex(block) {
  return block.toRaw().toString('hex');
}

function dump(name, block) {
  const blk = formatBlock(name, block);

  console.log(blk);
  console.log('');
}

console.log('');

dump('main', main);
dump('testnet', testnet);
dump('regtest', regtest);
dump('simnet', simnet);

const file = Path.resolve(__dirname, '..', 'lib', 'protocol', 'genesis.json');

fs.writeFileSync(file, JSON.stringify({
  main: toHex(main),
  testnet: toHex(testnet),
  regtest: toHex(regtest),
  simnet: toHex(simnet)
}, null, 2));
