'use strict';

const assert = require('bsert');
const ContractState = require('../lib/mempool/contractstate');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const Output = require('../lib/primitives/output');
const CoinView = require('../lib/coins/coinview');
const rules = require('../lib/covenants/rules');
const NameState = require('../lib/covenants/namestate');
const {types} = rules;

const network = Network.get('regtest');

function nameContext(name, type) {
  const rawName = Buffer.from(name, 'ascii');
  const nameHash = rules.hashName(rawName);

  const output = new Output();
  const mtx = new MTX();
  const ns = new NameState();
  const view = new CoinView();

  switch (type) {
    case types.OPEN:
      output.covenant.setOpen(nameHash, rawName);
      break;
    case types.BID:
      output.covenant.setBid(nameHash, 0, rawName, Buffer.alloc(32));
      break;
    case types.REVEAL:
      output.covenant.setReveal(nameHash, 100, Buffer.alloc(32));
      break;
    case types.UPDATE: {
      const data = Buffer.from('hello world', 'ascii');
      output.covenant.setUpdate(nameHash, 100, data);
      break;
    }
  }

  mtx.outputs.push(output);
  ns.name = name;
  ns.nameHash = nameHash;
  ns.height = 1; // prevent null ns

  view.names.set(nameHash, ns);

  return [mtx, view];
}

describe('Contract State', function() {
  const name = 'foo';
  const rawName = Buffer.from(name, 'ascii');
  const nameHash = rules.hashName(rawName);

  it('Should construct', () => {
    const contract = new ContractState(network);
    assert.ok(contract);

    // Requires a network
    assert.throws(() => new ContractState());
  });

  it('should track an open', () => {
    const contract = new ContractState(network);

    const [mtx, view] = nameContext(name, types.OPEN);
    contract.track(mtx, view);

    assert.ok(contract.opens.has(nameHash));

    const opens = contract.opens.get(nameHash);
    assert.ok(opens.has(Buffer.from(mtx.txid(), 'hex')));
  });

  it('should track a bid', () => {
    const contract = new ContractState(network);

    const [mtx, view] = nameContext(name, types.BID);
    contract.track(mtx, view);

    assert.ok(contract.bids.has(nameHash));

    const bids = contract.bids.get(nameHash);
    assert.ok(bids.has(Buffer.from(mtx.txid(), 'hex')));
  });

  it('should track a reveal', () => {
    const contract = new ContractState(network);

    const [mtx, view] = nameContext(name, types.REVEAL);
    contract.track(mtx, view);

    assert.ok(contract.reveals.has(nameHash));

    const reveals = contract.reveals.get(nameHash);
    assert.ok(reveals.has(Buffer.from(mtx.txid(), 'hex')));
  });

  it('should track an update', () => {
    const contract = new ContractState(network);

    const [mtx, view] = nameContext(name, types.UPDATE);
    contract.track(mtx, view);

    assert.ok(contract.updates.has(nameHash));

    const updates = contract.updates.get(nameHash);
    assert.ok(updates.has(Buffer.from(mtx.txid(), 'hex')));
  });
});
