'use strict';

const assert = require('bsert');
const {BufferReader, BufferWriter} = require('bufio');
const blake2b160 = require('bcrypto/lib/blake2b160');
const ed25519 = require('bcrypto/lib/ed25519');
const {Tree, Proof} = require('urkel');
const {codes} = Proof;
const {MAX_RESOURCE_SIZE} = require('./rules');
const {encoding} = require('bns');

/**
* Escher protocol: Data must fit inside 512 byte UPDATE covenant item
*
* 1     version (0x01)
* 20    current tree root
* 1     method (REGISTER: 0x00, UPDATE: 0x01)
* 20    compound namehash (H(sld.tld) = key)
* ...   params
*
* REGISTER: 0x00
* 32    NEW ed25519 public key
* 4-438 Urkel proof-of-nonexistence of namehash
*
* UPDATE:   0x01
* 32    NEW ed25519 public key
* 64    signature
* 4-374 urkel proof of OLD public key at namehash
*/

// Escher constants
const ESCHER_VERSION = 0x80;
const MAGIC_STRING = Buffer.from('EscherMessage', 'ascii');

// Tree options
const BYTES = 20;
const NULL_ROOT = Buffer.alloc(BYTES, 0x00);
const bits = BYTES * 8;
const hash = blake2b160;

// Tree functions
const opcodes = {
  REGISTER: 0x00,
  UPDATE:   0x01
};

// DNSSEC key (SLD owner)
const algorithm = ed25519;
const KEY_SIZE = 32; // public and private
const SIG_SIZE = 64;

exports.initialState = function () {
  const buf = Buffer.alloc(BYTES + 1, 0x00);
  buf[0] = ESCHER_VERSION;
  return buf;
};

exports.tree = function () {
  // Store in memory for now (no `prefix` option passed to Tree)
  return new Tree({hash, bits});
};

exports.verify = function (data, state) {
  try {
    exports.check(data, state);
  } catch (e) {
    // Log errors here when debugging.
    // console.log(e);
    return false;
  }
  return true;
};

exports.check = function (data, state) {
  const current = new BufferReader(state);
  const proposed = new BufferReader(data);

  // Name is not currently in Escher mode
  if (!current.getSize() || current.readU8() !== ESCHER_VERSION) {
    // Name wants to enter Escher mode
    if (proposed.getSize() && proposed.readU8() === ESCHER_VERSION) {
      // Escher tree MUST be initialized exactly this way
      if (proposed.left() !== BYTES)
        throw new Error('Invalid Escher tree initialization size.');

      if (!proposed.readBytes(BYTES).equals(NULL_ROOT))
        throw new Error('Invalid Escher tree initialization root.');
    }

    // Name is not now nor is it about to be in Escher mode
    return;
  }

  // Name is currently in Escher mode, and must remain in Escher mode
  if (proposed.readU8() !== ESCHER_VERSION)
    throw new Error('Can not escape Escher mode.');

  // Proposal must at least include:
  //  New tree root
  //  Opcode
  //  Compound namehash (hash of DNS wire format of complete domain sld.tld)
  //  Arguments
  if (proposed.left() < BYTES + 1 + BYTES + 1)
    throw new Error('Invalid Escher proposal.');

  const proposedRoot = proposed.readBytes(BYTES);
  const opcode = proposed.readU8();
  const namehash = proposed.readBytes(BYTES);

  assert(current.getSize() >= BYTES + 1);
  const currentRoot = current.readBytes(BYTES);

  switch (opcode) {
    // Add a new SLD to the TLD's Escher tree
    case opcodes.REGISTER: {
      const newKey = proposed.readBytes(KEY_SIZE);
      let proof;
      try {
        proof = Proof.readBR(proposed, hash, bits);

        // Prove that the namehash does not exist in the Escher tree
        const [code, value] = proof.verify(currentRoot, namehash, hash, bits);
        assert.strictEqual(code, codes.PROOF_OK);
        assert.strictEqual(value, null);
      } catch (e) {
        throw new Error('Invalid non-existence proof for Escher REGISTER.');
      }

      // Insert the new value into the proof for this namehash
      proof.insert(namehash, newKey, hash);

      // Verify propsed tree root is correct after insertion
      if(!proposedRoot.equals(proof.computeRoot(namehash, hash, bits)))
        throw new Error('Invalid Urkel insertion for Escher REGISTER.');

      break;
    }

    // Update the SLD owner's DNSSEC key in the TLD's Escher tree
    case opcodes.UPDATE: {
      const newKey = proposed.readBytes(KEY_SIZE);
      const sig = proposed.readBytes(SIG_SIZE);
      let proof, oldKey;
      try {
        proof = Proof.readBR(proposed, hash, bits);

        // Prove that the namehash does exist in the Escher tree,
        // and get the old public key from the proof.
        const [code, value] = proof.verify(currentRoot, namehash, hash, bits);
        assert.strictEqual(code, codes.PROOF_OK);
        assert(value && value.length === KEY_SIZE);
        oldKey = value;
      } catch (e) {
        throw new Error('Invalid existence proof for Escher UPDATE.');
      }

      // Insert the new value into the proof for this namehash
      proof.insert(namehash, newKey, hash);

      // Verify propsed tree root is correct after insertion
      if(!proposedRoot.equals(proof.computeRoot(namehash, hash, bits)))
        throw new Error('Invalid Urkel update for Escher UPDATE.');

      // Finally, verify signature from current SLD owner to new owner
      const msg = Buffer.allocUnsafe(MAGIC_STRING.length + BYTES + KEY_SIZE);
      MAGIC_STRING.copy(msg);
      currentRoot.copy(msg, MAGIC_STRING.length);
      newKey.copy(msg, MAGIC_STRING.length + BYTES);
      if(!algorithm.verify(msg, sig, oldKey))
        throw new Error('Invalid signature for Escher UPDATE.');

      break;
    }

    default: {
      // Unknown opcode
      throw new Error('Unknown Escher opcode.');
    }
  }
};

exports.makeRegister = async function (tree, namehash, newKey) {
  assert(tree instanceof Tree);
  assert(Buffer.isBuffer(namehash));
  assert(Buffer.isBuffer(newKey));
  assert.strictEqual(namehash.length, BYTES);
  assert.strictEqual(newKey.length, KEY_SIZE);

  // Get proof of nonexistence first
  const nonProof = await tree.prove(namehash);
  // const TYPE_DEADEND = 0;
  // const TYPE_SHORT = 1;
  // const TYPE_COLLISION = 2;
  // const TYPE_EXISTS = 3;
  assert(nonProof.type < 3, 'Cannot make REGISTER for existing name.');

  // Get new root after inserting into tree
  // but DO NOT commit the insertion!
  const b = tree.batch();
  await b.insert(namehash, newKey);
  const proposedRoot = b.rootHash();

  const size =
    1 +         // version
    BYTES +     // current tree root
    1 +         // opcode
    BYTES +     // namehash
    KEY_SIZE +  // new public key
    nonProof.getSize(hash, bits);
  assert(size <= MAX_RESOURCE_SIZE, 'Escher message exceeds size limit.');

  // Serialize
  const bw = new BufferWriter(size);
  bw.writeU8(ESCHER_VERSION);
  bw.writeBytes(proposedRoot);
  bw.writeU8(0x00); // REGISTER
  bw.writeBytes(namehash);
  bw.writeBytes(newKey);
  bw.writeBytes(nonProof.encode(hash, bits));

  return bw.render();
};

exports.makeUpdate = async function (tree, namehash, newKey, priv) {
  assert(tree instanceof Tree);
  assert(Buffer.isBuffer(namehash));
  assert(Buffer.isBuffer(newKey));
  assert(Buffer.isBuffer(priv));
  assert.strictEqual(namehash.length, BYTES);
  assert.strictEqual(newKey.length, KEY_SIZE);
  assert.strictEqual(priv.length, KEY_SIZE);

  // Get proof of existence of old key first
  const oldkeyProof = await tree.prove(namehash);
  // const TYPE_DEADEND = 0;
  // const TYPE_SHORT = 1;
  // const TYPE_COLLISION = 2;
  // const TYPE_EXISTS = 3;
  assert(oldkeyProof.type === 3, 'Cannot make UPDATE for non-existent name.');
  // Make sure we have the right key
  assert.bufferEqual(
    oldkeyProof.value,
    algorithm.publicKeyCreate(priv),
    'Cannot sign UPDATE with wrong key.'
  );

  // Sign new key with old key
  const msg = Buffer.allocUnsafe(MAGIC_STRING.length + BYTES + KEY_SIZE);
  MAGIC_STRING.copy(msg);
  tree.rootHash().copy(msg, MAGIC_STRING.length);
  newKey.copy(msg, MAGIC_STRING.length + BYTES);
  const sig = algorithm.sign(msg, priv);

  // Get new root after inserting into tree
  // but DO NOT commit the insertion!
  const b = tree.batch();
  await b.insert(namehash, newKey);
  const proposedRoot = b.rootHash();

  const size =
    1 +         // version
    BYTES +     // current tree root
    1 +         // opcode
    BYTES +     // namehash
    KEY_SIZE +  // new public key
    SIG_SIZE +  // signature
    oldkeyProof.getSize(hash, bits);
  assert(size <= MAX_RESOURCE_SIZE, 'Escher message exceeds size limit.');

  // Serialize
  const bw = new BufferWriter(size);
  bw.writeU8(ESCHER_VERSION);
  bw.writeBytes(proposedRoot);
  bw.writeU8(0x01); // UPDATE
  bw.writeBytes(namehash);
  bw.writeBytes(newKey);
  bw.writeBytes(sig);
  bw.writeBytes(oldkeyProof.encode(hash, bits));

  return bw.render();
};

exports.namehashFromWire = function (buf) {
  assert(Buffer.isBuffer(buf));
  return hash.digest(buf);
};

exports.namehashFromName = function (name) {
  assert(typeof name === 'string');

  const size = encoding.sizeName(name);
  const data = Buffer.allocUnsafe(size);
  encoding.writeName(data, name, 0);
  return exports.namehashFromWire(data);
};

exports.ESCHER_VERSION = ESCHER_VERSION;
exports.BYTES = BYTES;
exports.KEY_SIZE = KEY_SIZE;
exports.algorithm = algorithm;
