/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const {encoding} = require('bufio');
const assert = require('bsert');
const random = require('bcrypto/lib/random');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const Address = require('../lib/primitives/address');
const TX = require('../lib/primitives/tx');
const MTX = require('../lib/primitives/mtx');
const Output = require('../lib/primitives/output');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const Input = require('../lib/primitives/input');
const CoinView = require('../lib/coins/coinview');
const KeyRing = require('../lib/primitives/keyring');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_ADDITION = 0xfffffffffffff;

function createInput(value, view) {
  const hash = random.randomBytes(32);

  const input = {
    prevout: {
      hash: hash,
      index: 0
    }
  };

  const output = new Output();
  output.value = value;

  if (!view)
    view = new CoinView();

  view.addOutput(new Outpoint(hash, 0), output);

  return [input, view];
};

function sigopContext(witness, addr) {
  const fund = new TX();

  {
    fund.version = 1;

    const input = new Input();
    fund.inputs.push(input);

    const output = new Output();
    output.value = 1;
    output.address = addr;
    fund.outputs.push(output);

    fund.refresh();
  }

  const spend = new TX();

  {
    spend.version = 1;

    const input = new Input();
    input.prevout.hash = fund.hash();
    input.prevout.index = 0;
    input.witness = witness;
    spend.inputs.push(input);

    const output = new Output();
    output.value = 1;
    spend.outputs.push(output);

    spend.refresh();
  }

  const view = new CoinView();

  view.addTX(fund, 0);

  return {
    fund: fund,
    spend: spend,
    view: view
  };
}

describe('TX', function() {
  it('should fail on >51 bit coin values', () => {
    const [input, view] = createInput(consensus.MAX_MONEY + 1);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should handle 51 bit coin values', () => {
    const [input, view] = createInput(consensus.MAX_MONEY);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on >51 bit output values', () => {
    const [input, view] = createInput(consensus.MAX_MONEY);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY + 1
      }],
      locktime: 0
    });
    assert.ok(!tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should handle 51 bit output values', () => {
    const [input, view] = createInput(consensus.MAX_MONEY);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on >51 bit fees', () => {
    const [input, view] = createInput(consensus.MAX_MONEY + 1);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: 0
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on >51 bit values from multiple', () => {
    const view = new CoinView();
    const tx = new TX({
      version: 1,
      inputs: [
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0],
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0],
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0]
      ],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on >51 bit output values from multiple', () => {
    const [input, view] = createInput(consensus.MAX_MONEY);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [
        {
          script: [],
          value: Math.floor(consensus.MAX_MONEY / 2)
        },
        {
          script: [],
          value: Math.floor(consensus.MAX_MONEY / 2)
        },
        {
          script: [],
          value: Math.floor(consensus.MAX_MONEY / 2)
        }
      ],
      locktime: 0
    });
    assert.ok(!tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on >51 bit fees from multiple', () => {
    const view = new CoinView();
    const tx = new TX({
      version: 1,
      inputs: [
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0],
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0],
        createInput(Math.floor(consensus.MAX_MONEY / 2), view)[0]
      ],
      outputs: [{
        script: [],
        value: 0
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail to parse >53 bit values', () => {
    const [input] = createInput(Math.floor(consensus.MAX_MONEY / 2));

    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: 0xdeadbeef
      }],
      locktime: 0
    });

    let raw = tx.encode();
    assert.strictEqual(encoding.readU64(raw, 46), 0xdeadbeef);
    raw[54] = 0x7f;

    assert.throws(() => TX.decode(raw));

    tx.outputs[0].value = 0;
    tx.refresh();

    raw = tx.encode();
    assert.strictEqual(encoding.readU64(raw, 46), 0x00);
    raw[54] = 0x80;
    assert.throws(() => TX.decode(raw));
  });

  it('should fail on 53 bit coin values', () => {
    const [input, view] = createInput(MAX_SAFE_INTEGER);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: consensus.MAX_MONEY
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on 53 bit output values', () => {
    const [input, view] = createInput(consensus.MAX_MONEY);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: MAX_SAFE_INTEGER
      }],
      locktime: 0
    });
    assert.ok(!tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  it('should fail on 53 bit fees', () => {
    const [input, view] = createInput(MAX_SAFE_INTEGER);
    const tx = new TX({
      version: 1,
      inputs: [input],
      outputs: [{
        script: [],
        value: 0
      }],
      locktime: 0
    });
    assert.ok(tx.isSane());
    assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
  });

  for (const value of [MAX_SAFE_ADDITION, MAX_SAFE_INTEGER]) {
    it('should fail on >53 bit values from multiple', () => {
      const view = new CoinView();
      const tx = new TX({
        version: 1,
        inputs: [
          createInput(value, view)[0],
          createInput(value, view)[0],
          createInput(value, view)[0]
        ],
        outputs: [{
          script: [],
          value: consensus.MAX_MONEY
        }],
        locktime: 0
      });
      assert.ok(tx.isSane());
      assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
    });

    it('should fail on >53 bit output values from multiple', () => {
      const [input, view] = createInput(consensus.MAX_MONEY);
      const tx = new TX({
        version: 1,
        inputs: [input],
        outputs: [
          {
            script: [],
            value: value
          },
          {
            script: [],
            value: value
          },
          {
            script: [],
            value: value
          }
        ],
        locktime: 0
      });
      assert.ok(!tx.isSane());
      assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
    });

    it('should fail on >53 bit fees from multiple', () => {
      const view = new CoinView();
      const tx = new TX({
        version: 1,
        inputs: [
          createInput(value, view)[0],
          createInput(value, view)[0],
          createInput(value, view)[0]
        ],
        outputs: [{
          script: [],
          value: 0
        }],
        locktime: 0
      });
      assert.ok(tx.isSane());
      assert.ok(!tx.verifyInputs(view, 0, Network.get('main')));
    });
  }

  it('should count sigops for p2pkh', () => {
    const key = KeyRing.generate();

    const witness = new Witness([
      Buffer.from([0]),
      Buffer.from([0])
    ]);

    {
      const ctx = sigopContext(witness, key.getAddress());

      assert.strictEqual(ctx.spend.getSigops(ctx.view, 0), 1);
    }

    {
      const addr = Address.fromHash(key.getKeyHash(), 1);
      const ctx = sigopContext(witness, addr);

      assert.strictEqual(ctx.spend.getSigops(ctx.view, 0), 0);
    }

    {
      const ctx = sigopContext(witness, key.getAddress());

      ctx.spend.inputs[0].prevout.hash = consensus.ZERO_HASH;
      ctx.spend.inputs[0].prevout.index = 0xffffffff;
      ctx.spend.refresh();

      assert.strictEqual(ctx.spend.getSigops(ctx.view, 0), 0);
    }
  });

  it('should count sigops for p2sh', () => {
    const key = KeyRing.generate();
    const pub = key.publicKey;

    const redeem = Script.fromMultisig(1, 2, [pub, pub]);
    const addr = Address.fromScript(redeem);

    const witness = new Witness([
      Buffer.from([0]),
      Buffer.from([0]),
      redeem.encode()
    ]);

    const ctx = sigopContext(witness, addr);

    assert.strictEqual(ctx.spend.getSigops(ctx.view, 0), 2);
  });

  it('should have standard inputs', () => {
    const key = KeyRing.generate();
    const pub = key.publicKey;
    const addr = Address.fromPubkey(pub, 0);
    const mprev = new MTX();

    mprev.addOutput(addr, 1000);

    const prev = mprev.toTX();
    const view = new CoinView();

    view.addTX(prev, -1);

    const mtx = new MTX();
    mtx.view = view;

    mtx.addOutpoint({ hash: prev.hash(), index: 0 });
    mtx.addOutput(addr, 1000);
    mtx.sign(key);

    const tx = mtx.toTX();

    assert(tx.hasStandardInputs(view));
  });
});
