'use strict';

const assert = require('bsert');
const ownership = require('../lib/covenants/ownership');
const Address = require('../lib/primitives/address');
const Network = require('../lib/protocol/network');
const network = Network.get('regtest');

describe('Ownership', function() {
  it('should encode / decode ownership TXT data', () => {
    const block1Hash =
      '0025f4480dadc61f13f507af9c9c9d06373fed38727ea467b6b2d5b09d522164';
    const claim = {
      name: 'bitcoin',
      target: 'bitcoin.com.',
      value: 503513487,
      size: 4194,
      fee: 20960,
      address: 'rs1qjvvwkq2hq3cz5kmgz80v0a2l625ktdjtn60dpw',
      txt: 'hns-regtest:aakjgghlaflqi4bklnubdxwh6vp5fklfwzf73ycraa' +
           's7isanvxdb6e7va6xzzhe5ay3t73jyoj7kiz5wwlk3bhksefsacaaaaafk5pvj'
    };

    const claimAddress = Address.fromString(claim.address, 'regtest');
    const decoded = ownership.decodeData(claim.txt, 'regtest');
    assert.strictEqual(decoded.address.version, claimAddress.version);
    assert.strictEqual(decoded.address.hash, claimAddress.hash.toString('hex'));
    assert.strictEqual(decoded.fee, claim.fee);
    assert.strictEqual(decoded.commitHash, block1Hash);
    assert.strictEqual(decoded.commitHeight, 1);

    // (address, fee, commitHash, commitHeight, network)
    const encoded = ownership.createData(
      claimAddress,
      claim.fee,
      Buffer.from(block1Hash, 'hex'),
      1,
      network
    );
    assert.strictEqual(encoded, claim.txt);
  });
});
