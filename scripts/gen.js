'use strict';

const assert = require('assert');
const Path = require('path');
const fs = require('bfile');
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
const Resource = require('../lib/dns/resource');
const root = require('../etc/root.json');
const {EMPTY_ROOT} = require('btrie/lib/common');
const {types} = rules;

const networks = {
  main: Network.get('main'),
  testnet: Network.get('testnet'),
  regtest: Network.get('regtest'),
  simnet: Network.get('simnet')
};

const genesis = Address.fromHash(consensus.GENESIS_KEY, 0);
const investors = Address.fromHash(consensus.INVESTORS_KEY, 0);
const foundationHot = Address.fromHash(consensus.FOUNDATION_HOT, 0);
const foundation = Address.fromHash(consensus.FOUNDATION_KEY, 0);
const creators = Address.fromHash(consensus.CREATORS_KEY, 0);
const airdrop = Address.fromHash(consensus.AIRDROP_KEY, 0);

const names = Object.keys(root).sort();

function createGenesisBlock(options) {
  let flags = options.flags;
  let nonce = options.nonce;

  if (!flags) {
    flags = Buffer.from(
      `01/Nov/2017 EFF to ICANN: Don't Pick Up the Censor's Pen`,
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
        address: genesis
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
    trieRoot: EMPTY_ROOT.toString('hex'),
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
      address: genesis
    }],
    locktime: 0
  });

  for (const name of names) {
    const rawName = Buffer.from(name, 'ascii');

    const claim = new Output();
    claim.value = 0;
    claim.address = foundationHot;
    claim.covenant.type = types.CLAIM;
    claim.covenant.items.push(rawName);
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
    const data = root[name];
    assert(data.ttl);
    assert(data.ds);
    assert(data.auth);

    const json = {
      ttl: data.ttl,
      ds: data.ds,
      ns: []
    };

    for (const auth of data.auth) {
      assert(auth.name);
      assert(auth.inet4 || auth.inet6);

      const ips = [];

      if (auth.inet4)
        ips.push(auth.inet4);

      if (auth.inet6)
        ips.push(auth.inet6);

      json.ns.push(`${auth.name}@${ips.join(',')}`);
    }

    const rawName = Buffer.from(name, 'ascii');
    const res = Resource.fromJSON(json);

    const claimPrev = claimer.outpoint(i);
    const dustPrev = claimer.outpoint(i + 1);

    const claim = Input.fromOutpoint(claimPrev);
    const dust = Input.fromOutpoint(dustPrev);

    const update = new Output();
    update.value = 0;
    update.address = foundationHot;
    update.covenant.type = types.REGISTER;
    update.covenant.items.push(rawName);
    update.covenant.items.push(res.toRaw());
    update.covenant.items.push(consensus.ZERO_HASH);

    const cold = new Output();
    cold.value = 0;
    cold.address = foundation;
    cold.covenant.type = types.COLD;
    cold.covenant.items.push(rawName);

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

const blocks = {
  main: createGenesisBlock({
    time: 1514765688,
    bits: networks.main.pow.bits,
    solution: new Uint32Array(networks.main.cuckoo.size)
  }),
  testnet: createGenesisBlock({
    time: 1514765689,
    bits: networks.testnet.pow.bits,
    solution: new Uint32Array(networks.testnet.cuckoo.size)
  }),
  regtest: createGenesisBlock({
    time: 1514765690,
    bits: networks.regtest.pow.bits,
    solution: new Uint32Array(networks.regtest.cuckoo.size)
  }),
  simnet: createGenesisBlock({
    time: 1514765691,
    bits: networks.simnet.pow.bits,
    solution: new Uint32Array(networks.simnet.cuckoo.size)
  })
};

function formatJS(name, block) {
  const sol = block.solution.toArray();

  let out = '';
  out += `genesis.${name} = {\n`;
  out += `  version: ${block.version},\n`;
  out += `  hash: '${block.hash('hex')}',\n`;
  out += `  prevBlock: '${block.prevBlock}',\n`;
  out += `  merkleRoot:\n`;
  out += `    '${block.merkleRoot}',\n`;
  out += `  witnessRoot:\n`;
  out += `    '${block.witnessRoot}',\n`;
  out += `  trieRoot:\n`;
  out += `    '${block.trieRoot}',\n`;
  out += `  time: ${block.time},\n`;
  out += `  bits: 0x${util.hex32(block.bits)},\n`;
  out += `  nonce: Buffer.from('${block.nonce.toString('hex')}', 'hex'),\n`;
  out += `  solution: new Uint32Array([\n`;

  for (let i = 0; i < sol.length; i++)
    out += `    0x${util.hex32(sol[i])},\n`;

  out = out.slice(0, -2) + '\n';

  out += `  ]),\n`;
  out += `  height: 0\n`;
  out += `};`;

  return out;
}

function formatData(name, block) {
  const hex = block.toRaw().toString('base64');
  const chunks = [`genesis.${name}Data = Buffer.from(\``];

  for (let i = 0; i < hex.length; i += 50)
    chunks.push(`  ${hex.slice(i, i + 50)}`);

  return chunks.join('\n') + '`, \'base64\');';
}

function formatC(name, block) {
  const hdr = block.toHead().toString('hex');
  const upper = name.toUpperCase();
  const chunks = [`static const uint8_t HSK_GENESIS_${upper}[] = ""`];

  for (let i = 0; i < hdr.length; i += 26)
    chunks.push(`  "${hdr.slice(i, i + 26)}"`);

  const hex = chunks.join('\n');
  const data = hex.replace(/([a-f0-9]{2})/g, '\\x$1');

  return `${data};`;
}

const code = [
  '// Autogenerated, do not edit.',
  '',
  `'use strict';`,
  '',
  `const data = require('./genesis-data.json');`,
  'const genesis = exports;',
  ''
];

for (const name of Object.keys(blocks)) {
  const upper = name[0].toUpperCase() + name.substring(1);
  const block = blocks[name];
  code.push('/*');
  code.push(` * ${upper}`);
  code.push(' */');
  code.push('');
  code.push(formatJS(name, block));
  code.push('');
  code.push(`genesis.${name}Data = Buffer.from(data.${name}, 'base64');`);
  code.push('');
}

const json = JSON.stringify({
  main: blocks.main.toRaw().toString('base64'),
  testnet: blocks.testnet.toRaw().toString('base64'),
  regtest: blocks.regtest.toRaw().toString('base64'),
  simnet: blocks.simnet.toRaw().toString('base64')
}, null, 2);

const ccode = [
  '#ifndef _HSK_GENESIS_H',
  '#define _HSK_GENESIS_H',
  ''
];

for (const name of Object.keys(blocks)) {
  const upper = name[0].toUpperCase() + name.substring(1);
  const block = blocks[name];
  ccode.push('/*');
  ccode.push(` * ${upper}`);
  ccode.push(' */');
  ccode.push('');
  ccode.push(formatC(name, block));
  ccode.push('');
}

ccode.push('#endif');
ccode.push('');

const file = Path.resolve(
  __dirname,
  '..',
  'lib',
  'protocol',
  'genesis.js'
);

fs.writeFileSync(file, code.join('\n'));

const jfile = Path.resolve(
  __dirname,
  '..',
  'lib',
  'protocol',
  'genesis-data.json'
);

fs.writeFileSync(jfile, json);

const cfile = Path.resolve(
  __dirname,
  '..',
  'etc',
  'genesis.h'
);

fs.writeFileSync(cfile, ccode.join('\n'));
