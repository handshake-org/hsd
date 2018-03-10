'use strict';

const fs = require('bfile');
const Path = require('path');
const secp256k1 = require('bcrypto/lib/secp256k1');
const hash160 = require('bcrypto/lib/hash160');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const TX = require('../lib/primitives/tx');
const Block = require('../lib/primitives/block');
const Address = require('../lib/primitives/address');
const Witness = require('../lib/script/witness');
const Input = require('../lib/primitives/input');
const Output = require('../lib/primitives/output');
const util = require('../lib/utils/util');
const rules = require('../lib/covenants/rules');
const {HSKResource} = require('../lib/covenants/record');
const root = require('../etc/root.json');
const {types} = rules;

const hex = ''
  + '0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5c'
  + 'b2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3';

const uncompressed = Buffer.from(hex, 'hex');
const key = secp256k1.publicKeyConvert(uncompressed, true);
const keyHash = hash160.digest(key);

const ZERO_ROOT =
  '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314';

const satoshi = Address.fromHash(keyHash, 0);
const investors = Address.fromHash(keyHash, 0);
const foundationHot = Address.fromHash(keyHash, 0);
const foundation = Address.fromHash(keyHash, 0);
const creators = Address.fromHash(keyHash, 0);
const airdrop = Address.fromHash(keyHash, 0);

const names = Object.keys(root).sort();

function createGenesisBlock(options) {
  let flags = options.flags;
  let nonce = options.nonce;

  if (!flags) {
    flags = Buffer.from(
      '01/Nov/2017 EFF to ICANN: Don\'t Pick Up the Censor\'s Pen',
      'ascii');
  }

  if (!nonce)
    nonce = Buffer.alloc(consensus.NONCE_SIZE, 0x00);

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
    outputs: [
      {
        value: consensus.GENESIS_REWARD,
        address: satoshi
      },
      {
        value: consensus.MAX_INVESTORS,
        address: investors
      },
      {
        value: consensus.MAX_FOUNDATION,
        address: foundation
      },
      {
        value: consensus.MAX_CREATORS,
        address: creators
      },
      {
        value: consensus.MAX_AIRDROP,
        address: airdrop
      }
    ],
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
    solution: options.solution
  });

  block.txs.push(tx);

  const claimer = new TX({
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
      value: consensus.GENESIS_REWARD,
      address: satoshi
    }],
    locktime: 0
  });

  for (const name of names) {
    const claim = new Output();
    claim.value = 0;
    claim.address = foundationHot;
    claim.covenant.type = types.CLAIM;
    claim.covenant.items.push(Buffer.from(name, 'ascii'));
    claimer.outputs.push(claim);

    const dust = new Output();
    dust.value = 0;
    dust.address = foundationHot;
    claimer.outputs.push(dust);
  }

  claimer.refresh();

  const updater = new TX({
    version: 0,
    inputs: [],
    outputs: [],
    locktime: 0
  });

  let i = 1;

  for (const name of names) {
    const res = HSKResource.fromJSON(root[name]);

    const claimPrev = claimer.outpoint(i);
    const dustPrev = claimer.outpoint(i + 1);

    const claim = Input.fromOutpoint(claimPrev);
    const dust = Input.fromOutpoint(dustPrev);

    const update = new Output();
    update.value = 0;
    update.address = foundationHot;
    update.covenant.type = types.UPDATE;
    update.covenant.items.push(Buffer.from(name, 'ascii'));
    update.covenant.items.push(res.toRaw());

    const cold = new Output();
    cold.value = 0;
    cold.address = foundation;
    cold.covenant.type = types.COLD;
    cold.covenant.items.push(Buffer.from(name, 'ascii'));

    updater.inputs.push(claim);
    updater.inputs.push(dust);

    updater.outputs.push(update);
    updater.outputs.push(cold);

    i += 2;
  }

  updater.refresh();

  block.txs.push(claimer);
  block.txs.push(updater);

  block.merkleRoot = block.createMerkleRoot('hex');
  block.witnessRoot = block.createWitnessRoot('hex');

  return block;
}

const main = createGenesisBlock({
  time: 1514765688,
  bits: Network.get('main').pow.bits,
  solution: new Uint32Array(Network.get('main').cuckoo.size)
});

const testnet = createGenesisBlock({
  time: 1514765689,
  bits: Network.get('testnet').pow.bits,
  solution: new Uint32Array(Network.get('testnet').cuckoo.size)
});

const regtest = createGenesisBlock({
  time: 1514765690,
  bits: Network.get('regtest').pow.bits,
  solution: new Uint32Array(Network.get('regtest').cuckoo.size)
});

const simnet = createGenesisBlock({
  time: 1514765691,
  bits: Network.get('simnet').pow.bits,
  solution: new Uint32Array(Network.get('simnet').cuckoo.size)
});

function formatJS(name, block) {
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

function formatC(name, block) {
  const hdr = block.toHead().toString('hex');
  const chunks = [];

  for (let i = 0; i < hdr.length; i += 26)
    chunks.push(`  "${hdr.slice(i, i + 26)}"`);

  const hex = chunks.join('\n');
  const data = hex.replace(/([a-f0-9]{2})/g, '\\x$1');

  return `static const uint8_t HSK_GENESIS[] /* ${name} */ = ""\n${data};`;
}

function dump(name, block) {
  const js = formatJS(name, block);
  const c = formatC(name, block);

  console.log(js);
  console.log('');
  console.log(c);
  console.log('');
}

function toHex(block) {
  return block.toRaw().toString('hex');
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
