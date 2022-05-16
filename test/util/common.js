'use strict';

const assert = require('assert');
const {tmpdir} = require('os');
const path = require('path');
const Logger = require('blgr');
const fs = require('bfile');
const bio = require('bufio');
const {randomBytes} = require('bcrypto/lib/random');
const Block = require('../../lib/primitives/block');
const MerkleBlock = require('../../lib/primitives/merkleblock');
const Headers = require('../../lib/primitives/headers');
const {CompactBlock} = require('../../lib/net/bip152');
const TX = require('../../lib/primitives/tx');
const Output = require('../../lib/primitives/output');
const CoinView = require('../../lib/coins/coinview');

const common = exports;

common.readFile = function readFile(name, enc) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.readFileSync(file, enc);
};

common.writeFile = function writeFile(name, data) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.writeFileSync(file, data);
};

common.exists = function exists(name) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.existsSync(file);
};

common.readBlock = function readBlock(name) {
  const raw = common.readFile(`${name}.raw`);

  if (!common.exists(`${name}-undo.raw`))
    return new BlockContext(Block, raw);

  const undoRaw = common.readFile(`${name}-undo.raw`);

  return new BlockContext(Block, raw, undoRaw);
};

common.readMerkle = function readMerkle(name) {
  const raw = common.readFile(`${name}.raw`);
  return new BlockContext(MerkleBlock, raw);
};

common.readCompact = function readCompact(name) {
  const raw = common.readFile(`${name}.raw`);
  return new BlockContext(CompactBlock, raw);
};

common.readTX = function readTX(name) {
  const raw = common.readFile(`${name}.raw`);

  if (!common.exists(`${name}-undo.raw`))
    return new TXContext(raw);

  const undoRaw = common.readFile(`${name}-undo.raw`);

  return new TXContext(raw, undoRaw);
};

common.writeBlock = function writeBlock(name, block, view) {
  common.writeFile(`${name}.raw`, block.encode());

  if (!view)
    return;

  const undo = makeBlockUndo(block, view);
  const undoRaw = serializeUndo(undo);

  common.writeFile(`${name}-undo.raw`, undoRaw);
};

common.writeTX = function writeTX(name, tx, view) {
  common.writeFile(`${name}.raw`, tx.encode());

  if (!view)
    return;

  const undo = makeTXUndo(tx, view);
  const undoRaw = serializeUndo(undo);

  common.writeFile(`${name}-undo.raw`, undoRaw);
};

common.testdir = function(name) {
  assert(/^[a-z0-9\-]+$/.test(name), 'Invalid name');

  const uniq = randomBytes(4).toString('hex');
  return path.join(tmpdir(), `hsd-test-${name}-${uniq}`);
};

common.rimraf = async function(p) {
  const allowed = /hsd\-test\-[a-z0-9\-]+\-[a-f0-9]{8}((\\|\/)[a-z]+)?$/;
  if (!allowed.test(p))
    throw new Error(`Path not allowed: ${p}.`);

  return await fs.rimraf(p);
};

common.forValue = async function forValue(obj, key, val, timeout = 5000) {
  assert(typeof obj === 'object');
  assert(typeof key === 'string');

  const ms = 10;
  let interval = null;
  let count = 0;

  return new Promise((resolve, reject) => {
    interval = setInterval(() => {
      if (obj[key] === val) {
        clearInterval(interval);
        resolve();
      } else if (count * ms >= timeout) {
        clearInterval(interval);
        reject(new Error('Timeout waiting for value.'));
      }
      count += 1;
    }, ms);
  });
};

common.forEvent = async function forEvent(obj, name, count = 1, timeout = 5000) {
  assert(typeof obj === 'object');
  assert(typeof name === 'string');
  assert(typeof count === 'number');
  assert(typeof timeout === 'number');

  let countdown = count;
  const events = [];

  return new Promise((resolve, reject) => {
    let timeoutHandler, listener;

    const cleanup = function cleanup() {
      clearTimeout(timeoutHandler);
      obj.removeListener(name, listener);
    };

    listener = function listener(...args) {
      events.push({
        event: name,
        values: [...args]
      });

      countdown--;
      if (countdown === 0) {
        cleanup();
        resolve(events);
        return;
      }
    };

    timeoutHandler = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for event ${name} `
        + `(received ${count - countdown}/${count})`;

      reject(new Error(msg));
      return;
    }, timeout);

    obj.on(name, listener);
  });
};

common.forEventCondition = async function forEventCondition(obj, name, fn, timeout = 5000) {
  assert(typeof obj === 'object');
  assert(typeof name === 'string');
  assert(typeof fn === 'function');
  assert(typeof timeout === 'number');

  return new Promise((resolve, reject) => {
    let timeoutHandler, listener;

    const cleanup = function cleanup() {
      clearTimeout(timeoutHandler);
      obj.removeListener(name, listener);
    };

    listener = async function listener(...args) {
      let res = null;

      try {
        res = await fn(...args);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      if (res) {
        cleanup();
        resolve([...args]);
      }
    };

    timeoutHandler = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for event ${name} with condition`;
      reject(new Error(msg));
      return;
    }, timeout);

    obj.on(name, listener);
  });
};

common.sleep = async function sleep(ms) {
  assert(typeof ms === 'number');
  return new Promise(r => setTimeout(r, ms));
};

common.enableLogger = () => {
  Logger.global.set({
    level: 'debug',
    console: true
  });

  Logger.global.closed = false;
};

function parseUndo(data) {
  const br = bio.read(data);
  const items = [];

  while (br.left()) {
    const output = Output.read(br);
    items.push(output);
  }

  return items;
}

function serializeUndo(items) {
  const bw = bio.write();

  for (const item of items) {
    bw.writeU64(item.value);
    item.address.write(bw);
    item.covenant.write(bw);
  }

  return bw.render();
}

function applyBlockUndo(block, undo) {
  const view = new CoinView();
  let i = 0;

  for (const tx of block.txs) {
    if (tx.isCoinbase())
      continue;

    for (const {prevout} of tx.inputs)
      view.addOutput(prevout, undo[i++]);
  }

  assert(i === undo.length, 'Undo coins data inconsistency.');

  return view;
}

function applyTXUndo(tx, undo) {
  const view = new CoinView();
  let i = 0;

  for (const {prevout} of tx.inputs)
    view.addOutput(prevout, undo[i++]);

  assert(i === undo.length, 'Undo coins data inconsistency.');

  return view;
}

function makeBlockUndo(block, view) {
  const items = [];

  for (const tx of block.txs) {
    if (tx.isCoinbase())
      continue;

    for (const {prevout} of tx.inputs) {
      const coin = view.getOutput(prevout);
      assert(coin);
      items.push(coin);
    }
  }

  return items;
}

function makeTXUndo(tx, view) {
  const items = [];

  for (const {prevout} of tx.inputs) {
    const coin = view.getOutput(prevout);
    assert(coin);
    items.push(coin);
  }

  return items;
}

class BlockContext {
  constructor(ctor, raw, undoRaw) {
    this.ctor = ctor;
    this.raw = raw;
    this.undoRaw = undoRaw || null;
  }
  getRaw() {
    return this.raw;
  }
  getBlock() {
    const Block = this.ctor;
    const block = Block.decode(this.raw);

    if (!this.undoRaw) {
      const view = new CoinView();
      return [block, view];
    }

    const undo = parseUndo(this.undoRaw);
    const view = applyBlockUndo(block, undo);

    return [block, view];
  }
  getHeaders() {
    return Headers.fromHead(this.raw);
  }
}

class TXContext {
  constructor(raw, undoRaw) {
    this.raw = raw;
    this.undoRaw = undoRaw || null;
  }
  getRaw() {
    return this.raw;
  }
  getTX() {
    const tx = TX.decode(this.raw);

    if (!this.undoRaw) {
      const view = new CoinView();
      return [tx, view];
    }

    const undo = parseUndo(this.undoRaw);
    const view = applyTXUndo(tx, undo);

    return [tx, view];
  }
}
