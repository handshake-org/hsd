/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('assert');
const {Brontide} = require('../../lib/net/brontide');

const HELLO = Buffer.from('hello', 'ascii');
const PROLOGUE = 'lightning';

/*
 * Tests
 */

describe('Brontide', function() {
  let initiator = null;
  let responder = null;

  it('should test initiator (transport-initiator successful handshake)', () => {
    const rspub =
      '028d7500dd4c12685d1f568b4c2b5048e8534b873319f3a8daa612b469132ec7f7';
    const lspriv =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const epriv =
      '1212121212121212121212121212121212121212121212121212121212121212';

    initiator = new Brontide();
    initiator.generateKey = () => Buffer.from(epriv, 'hex');

    initiator.initState(
      true,
      PROLOGUE,
      Buffer.from(lspriv, 'hex'),
      Buffer.from(rspub, 'hex')
    );

    const actOne = initiator.genActOne();

    assert.strictEqual(actOne.toString('hex'), ''
      + '00036360e856310ce5d294e8be33fc807077dc56ac80d95d9'
      + 'cd4ddbd21325eff73f70df6086551151f58b8afe6c195782c'
      + '6a');

    const actTwo = ''
      + '0002466d7fcae563e5cb09a0d1870bb580344804617879a14'
      + '949cf22285f1bae3f276e2470b93aac583c9ef6eafca3f730'
      + 'ae';

    initiator.recvActTwo(Buffer.from(actTwo, 'hex'));

    const actThree = initiator.genActThree();

    assert.strictEqual(actThree.toString('hex'), ''
      + '00b9e3a702e93e3a9948c2ed6e5fd7590a6e1c3a0344cfc9d'
      + '5b57357049aa22355361aa02e55a8fc28fef5bd6d71ad0c38'
      + '228dc68b1c466263b47fdf31e560e139ba');

    assert.strictEqual(
      initiator.sendCipher.key.toString('hex'),
      '969ab31b4d288cedf6218839b27a3e2140827047f2c0f01bf5c04435d43511a9');

    assert.strictEqual(
      initiator.recvCipher.key.toString('hex'),
      'bb9020b8965f4df047e07f955f3c4b88418984aadc5cdb35096b9ea8fa5c3442');
  });

  it('should test responder (transport-responder successful handshake)', () => {
    const lspriv =
      '2121212121212121212121212121212121212121212121212121212121212121';
    const epriv =
      '2222222222222222222222222222222222222222222222222222222222222222';

    responder = new Brontide();
    responder.generateKey = () => Buffer.from(epriv, 'hex');
    responder.initState(false, PROLOGUE, Buffer.from(lspriv, 'hex'), null);

    const actOne = ''
      + '00036360e856310ce5d294e8be33fc807077dc56ac80d95d9'
      + 'cd4ddbd21325eff73f70df6086551151f58b8afe6c195782c'
      + '6a';

    responder.recvActOne(Buffer.from(actOne, 'hex'));

    const actTwo = responder.genActTwo();

    assert.strictEqual(actTwo.toString('hex'), ''
      + '0002466d7fcae563e5cb09a0d1870bb580344804617879a14'
      + '949cf22285f1bae3f276e2470b93aac583c9ef6eafca3f730'
      + 'ae');

    const actThree = ''
      + '00b9e3a702e93e3a9948c2ed6e5fd7590a6e1c3a0344cfc9d'
      + '5b57357049aa22355361aa02e55a8fc28fef5bd6d71ad0c38'
      + '228dc68b1c466263b47fdf31e560e139ba';

    responder.recvActThree(Buffer.from(actThree, 'hex'));

    assert.strictEqual(
      responder.recvCipher.key.toString('hex'),
      '969ab31b4d288cedf6218839b27a3e2140827047f2c0f01bf5c04435d43511a9');

    assert.strictEqual(
      responder.sendCipher.key.toString('hex'),
      'bb9020b8965f4df047e07f955f3c4b88418984aadc5cdb35096b9ea8fa5c3442');
  });

  it('should test encryption and key rotation', () => {
    for (let i = 0; i < 1001; i++) {
      const packet = initiator.write(HELLO);

      switch (i) {
        case 0:
          assert.strictEqual(packet.toString('hex'), ''
            + 'cf2b30ddf0cf3f80e7c35a6e6730b59fe802473'
            + '180f396d88a8fb0db8cbcf25d2f214cf9ea1d95');
          break;
        case 1:
          assert.strictEqual(packet.toString('hex'), ''
            + '72887022101f0b6753e0c7de21657d35a4cb2a1'
            + 'f5cde2650528bbc8f837d0f0d7ad833b1a256a1');
          break;
        case 500:
          assert.strictEqual(packet.toString('hex'), ''
            + '178cb9d7387190fa34db9c2d50027d21793c9bc'
            + '2d40b1e14dcf30ebeeeb220f48364f7a4c68bf8');
          break;
        case 501:
          assert.strictEqual(packet.toString('hex'), ''
            + '1b186c57d44eb6de4c057c49940d79bb838a145'
            + 'cb528d6e8fd26dbe50a60ca2c104b56b60e45bd');
          break;
        case 1000:
          assert.strictEqual(packet.toString('hex'), ''
            + '4a2f3cc3b5e78ddb83dcb426d9863d9d9a723b0'
            + '337c89dd0b005d89f8d3c05c52b76b29b740f09');
          break;
        case 1001:
          assert.strictEqual(packet.toString('hex'), ''
            + '2ecd8c8a5629d0d02ab457a0fdd0f7b90a192cd'
            + '46be5ecb6ca570bfc5e268338b1a16cf4ef2d36');
          break;
      }

      const msg = responder.read(packet);

      assert.strictEqual(msg.toString('hex'), HELLO.toString('hex'));
    }
  });
});
