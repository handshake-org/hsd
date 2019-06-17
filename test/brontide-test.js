'use strict';

const assert = require('bsert');
const {CipherState, Brontide} = require('../lib/net/brontide');

const HELLO = Buffer.from('hello', 'ascii');
const PROLOGUE = 'hns';
const ROTATION_INTERVAL = 1000;

/*
 * Tests
 */

describe('CipherState', function() {
  const cipher = new CipherState();
  const key = Buffer.from(
    '2121212121212121212121212121212121212121212121212121212121212121',
    'hex'
  );
  const salt = Buffer.from(
    '1111111111111111111111111111111111111111111111111111111111111111',
    'hex'
  );

  it('should initalize with the key and salt', () => {
    cipher.initSalt(key, salt);

    assert.bufferEqual(cipher.key, key);

    assert.bufferEqual(cipher.salt, salt);
  });

  it('should rotate the secret key', () => {
    cipher.rotateKey();

    assert.bufferEqual(
      cipher.key,
      Buffer.from(
        '0b579ba44366e4d49ac7a44a8203925cb6d610e950aee7a23c47a5448173af11',
        'hex'
      )
    );

    assert.bufferEqual(
      cipher.salt,
      Buffer.from(
        'be23775b41e7c67d1ec6dcfc21299f32461e145d4164f65943b4b99fcaff6dee',
        'hex'
      )
    );

    assert.strictEqual(cipher.nonce, 0);
  });

  it('should properly encrypt given text and empty ad', () => {
    // Reset the cipher
    const cipher = new CipherState();
    cipher.initSalt(key, salt);

    const hello = Buffer.from('hello', 'ascii');

    const tag = cipher.encrypt(hello);

    assert.bufferEqual(
      tag,
      Buffer.from('f11ae60b9df4c6ea25aea58ce1b6df83', 'hex')
    );
    assert.bufferEqual(hello, Buffer.from('0935b4c530', 'hex'));

    // Round 2
    const hello2 = Buffer.from('hello', 'ascii');

    const tag2 = cipher.encrypt(hello2);

    assert.bufferEqual(
      tag2,
      Buffer.from('d840242a1e817cd8374d45fb5621a5fc', 'hex')
    );
    assert.bufferEqual(hello2, Buffer.from('74898781da', 'hex'));
  });

  it('should properly encrypt given text and ad', () => {
    // Reset the cipher
    const cipher = new CipherState();
    cipher.initSalt(key, salt);

    const hello = Buffer.from('hello', 'ascii');
    const ad = Buffer.from('222222222222222222222222222222222222', 'hex');

    const tag = cipher.encrypt(hello, ad);

    assert.bufferEqual(
      tag,
      Buffer.from('81ad416f62157481c8af8ace16b64e15', 'hex')
    );
    assert.bufferEqual(hello, Buffer.from('0935b4c530', 'hex'));

    const hello2 = Buffer.from('hello', 'ascii');

    const tag2 = cipher.encrypt(hello2, ad);

    assert.bufferEqual(
      tag2,
      Buffer.from('df3f8257977dfb8d283c6fb149d2d49d', 'hex')
    );
    assert.bufferEqual(hello2, Buffer.from('74898781da', 'hex'));
  });

  it('should rotate key after encryption', () => {
    const cipher = new CipherState();
    cipher.initSalt(key, salt);

    const hello = Buffer.from('hello', 'ascii');

    cipher.nonce = 999;

    cipher.encrypt(hello);

    assert.strictEqual(cipher.nonce, 0);

    assert.bufferEqual(
      cipher.key,
      Buffer.from(
        '0b579ba44366e4d49ac7a44a8203925cb6d610e950aee7a23c47a5448173af11',
        'hex'
      )
    );

    assert.bufferEqual(
      cipher.salt,
      Buffer.from(
        'be23775b41e7c67d1ec6dcfc21299f32461e145d4164f65943b4b99fcaff6dee',
        'hex'
      )
    );
  });

  it('should decrypt encrypted text', () => {
    const encryptionCipher = new CipherState();
    encryptionCipher.initSalt(key, salt);

    const decryptionCipher = new CipherState();
    decryptionCipher.initSalt(key, salt);

    const hello = Buffer.from('hello', 'ascii');

    const tag = encryptionCipher.encrypt(hello);

    assert(decryptionCipher.decrypt(hello, tag));
  });

  it('should decrypt encrypted text throughout key rotation', () => {
    const encryptionCipher = new CipherState();
    encryptionCipher.initSalt(key, salt);

    const decryptionCipher = new CipherState();
    decryptionCipher.initSalt(key, salt);

    for (let i = 0; i <= ROTATION_INTERVAL + 1; i++) {
      const hello = Buffer.from('hello', 'ascii');
      const tag = encryptionCipher.encrypt(hello);
      assert(decryptionCipher.decrypt(hello, tag));
    }
  });
});

describe('Brontide', function() {
  it('should test brontide exchange', () => {
    const epriv1 =
      '1212121212121212121212121212121212121212121212121212121212121212';
    const lspriv1 =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const rspub1 =
      '028d7500dd4c12685d1f568b4c2b5048e8534b873319f3a8daa612b469132ec7f7';

    const epriv2 =
      '2222222222222222222222222222222222222222222222222222222222222222';
    const lspriv2 =
      '2121212121212121212121212121212121212121212121212121212121212121';

    const initiator = new Brontide();
    const responder = new Brontide();

    initiator.generateKey = () => Buffer.from(epriv1, 'hex');
    responder.generateKey = () => Buffer.from(epriv2, 'hex');

    initiator.initState(true, PROLOGUE,
                        Buffer.from(lspriv1, 'hex'),
                        Buffer.from(rspub1, 'hex'));

    responder.initState(false, PROLOGUE,
                        Buffer.from(lspriv2, 'hex'),
                        null);

    responder.recvActOne(initiator.genActOne());

    initiator.recvActTwo(responder.genActTwo());

    responder.recvActThree(initiator.genActThree());

    assert.strictEqual(
      initiator.sendCipher.key.toString('hex'),
      '1f33627bc124e43ab1024fded2f5c0d6730430f3f4cb85172b10e77c055b3b65');

    assert.strictEqual(
      initiator.recvCipher.key.toString('hex'),
      '5b943fc7215b1d55f7b440d43ad0057d6ef1cfde0e12ab69b1db6b4578e84469');

    assert.strictEqual(
      responder.recvCipher.key.toString('hex'),
      '1f33627bc124e43ab1024fded2f5c0d6730430f3f4cb85172b10e77c055b3b65');

    assert.strictEqual(
      responder.sendCipher.key.toString('hex'),
      '5b943fc7215b1d55f7b440d43ad0057d6ef1cfde0e12ab69b1db6b4578e84469');

    for (let i = 0; i <= 1001; i++) {
      const packet = initiator.write(HELLO);

      switch (i) {
        case 0:
          assert.strictEqual(packet.toString('hex'), ''
            + '186a811dd5ebcd7c79b728cc8b72178ef5f8a44'
            + '7efac0f9b5477046ce72596296844e1702fe463');
          break;
        case 1:
          assert.strictEqual(packet.toString('hex'), ''
            + 'e338507655712eaa0ddc2f8d408599e80a0e266'
            + '2afc110add447e6a0ed512c46a9bdacd4cb946e');
          break;
        case 500:
          assert.strictEqual(packet.toString('hex'), ''
            + '46aee83987990b46271f678d1303d3e94ba4c45'
            + 'bb20d23ec21ca2b5f6de5cdfdad83183569bea5');
          break;
        case 501:
          assert.strictEqual(packet.toString('hex'), ''
            + '2a05bf99a1815b4781c1ac27547755c8a3ba86e'
            + 'de8c309880e6ab866cfa233036924769652601e');
          break;
        case 1000:
          assert.strictEqual(packet.toString('hex'), ''
            + 'bd2be824ec969430f9c4a4bd34eef8bbee4811d'
            + 'c287f98bbb718abbd5c8b78a59dc1eaf0d74375');
          break;
        case 1001:
          assert.strictEqual(packet.toString('hex'), ''
            + 'b837d23ea6d5de0fe380c91abe9110ce519791d'
            + '533ed151ddab4d9172c5561457dda713bfb7ce0');
          break;
      }

      const msg = responder.read(packet);

      assert.strictEqual(msg.toString('hex'), HELLO.toString('hex'));
    }
  });
});
