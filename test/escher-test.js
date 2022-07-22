'use strict';

const assert = require('bsert');
const Escher = require('../lib/covenants/escher');
const FullNode = require('../lib/node/fullnode');
const plugin = require('../lib/wallet/plugin');
const rules = require('../lib/covenants/rules');
const {forValue} = require('./util/common');
const Networks = require('../lib/protocol/networks') ;
const network = Networks.regtest;
const random = require('bcrypto/lib/random');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

async function insert(tree, key, value) {
  const b = tree.batch();
  await b.insert(key, value);
  await b.commit();
  return tree.rootHash();
}

describe('Escher', function () {
  describe('Unit', function () {
    // Initialize tree (tracked by layer 2 nodes)
    const tree = Escher.tree();

    // Generate keypairs (for SLD buyer)
    const priv1 = Escher.algorithm.privateKeyGenerate();
    const pub1 = Escher.algorithm.publicKeyCreate(priv1);
    const priv2 = Escher.algorithm.privateKeyGenerate();
    const pub2 = Escher.algorithm.publicKeyCreate(priv2);

    // Note FQDN
    const name = 'campaign.chaos.';
    const namehash = Escher.namehashFromName(name);

    // Initialize Update Chain with empty tree root
    let current = Escher.initialState();

    function checkRoots() {
      assert.bufferEqual(
        tree.rootHash(),
        current.slice(1, Escher.BYTES + 1)
      );
    }

    before(async () => {
      await tree.open();
    });

    after(async () => {
      await tree.close();
    });

    it('should be empty', () => {
      // TLD owner initializes Escher Update chain
      checkRoots();
      assert.bufferEqual(
        tree.rootHash(),
        Buffer.alloc(Escher.BYTES, 0x00)
      );
    });

    it('should make REGISTER and verify', async () => {
      // SLD buyer's wallet makes this
      const proposed = await Escher.makeRegister(tree, namehash, pub1);

      // Blockchain verifies and confirms, extending Update Chain
      assert(Escher.verify(proposed, current));
      current = proposed;

      // Layer 2 nodes update when they see the block
      await insert(tree, namehash, pub1);

      checkRoots();
      assert.notBufferEqual(
        tree.rootHash(),
        Buffer.alloc(Escher.BYTES, 0x00)
      );
    });

    it('should make UPDATE and verify', async () => {
      // SLD owner's wallet makes this
      const proposed = await Escher.makeUpdate(tree, namehash, pub2, priv1);

      // Blockchain verifies and confirms, extending Update Chain
      assert(Escher.verify(proposed, current));
      current = proposed;

      // Layer 2 nodes update when they see the block
      await insert(tree, namehash, pub2);

      checkRoots();
    });

    it('should fail to make invalid REGISTER for existing name', async () => {
      await assert.rejects(
        Escher.makeRegister(tree, namehash, pub1),
        {message: 'Cannot make REGISTER for existing name.'}
      );
    });

    it('should fail to make invalid UPDATE for non-existent name', async () => {
      const randomNamehash = random.randomBytes(Escher.BYTES);
      await assert.rejects(
        Escher.makeUpdate(tree, randomNamehash, pub1, priv1),
        {message: 'Cannot make UPDATE for non-existent name.'}
      );
    });

    it('should fail to make invalid UPDATE with wrong key', async () => {
      const randomKey = random.randomBytes(Escher.KEY_SIZE);
      await assert.rejects(
        Escher.makeUpdate(tree, namehash, randomKey, randomKey),
        {message: 'Cannot sign UPDATE with wrong key.'}
      );
    });

    it('should invalidate REGISTER for existing name', async () => {
      // Attacker tries to use a non-existence proof for some other tree root.
      const emptyTree = Escher.tree();
      await emptyTree.open();
      const badProposed = await Escher.makeRegister(emptyTree, namehash, pub1);
      await emptyTree.close();

      assert.throws(
        () => Escher.check(badProposed, current),
        {message: 'Invalid non-existence proof for Escher REGISTER.'}
      );
    });

    it('should invalidate REGISTER for incorrect state', async () => {
      // Attacker submits a valid non-existence proof
      // but their proposed new tree root is incorrect
      const randomNamehash = random.randomBytes(Escher.BYTES);
      const badProposed = await Escher.makeRegister(tree, randomNamehash, pub1);
      // Proposed tree root starts at byte 1 (after version byte)
      // Flip a bit to corrupt it
      badProposed[1] ^= 1;

      assert.throws(
        () => Escher.check(badProposed, current),
        {message: 'Invalid Urkel insertion for Escher REGISTER.'}
      );
    });

    it('should invalidate UPDATE for non-existing name', async () => {
      // Attacker tries to use an existence proof for some other tree root.
      const fakeTree = Escher.tree();
      await fakeTree.open();
      await insert(fakeTree, namehash, pub1);

      const badUpdate = await Escher.makeUpdate(fakeTree, namehash, pub2, priv1);
      await fakeTree.close();

      assert.throws(
        () => Escher.check(badUpdate, current),
        {message: 'Invalid existence proof for Escher UPDATE.'}
      );
    });

    it('should invalidate UPDATE for incorrect state', async () => {
      // Attacker submits a valid existence proof
      // but their proposed new tree root is incorrect
      const badUpdate = await Escher.makeUpdate(tree, namehash, pub1, priv2);
      // Proposed tree root starts at byte 1 (after version byte)
      // Flip a bit to corrupt it
      badUpdate[1] ^= 1;

      assert.throws(
        () => Escher.check(badUpdate, current),
        {message: 'Invalid Urkel update for Escher UPDATE.'}
      );
    });

    it('should invalidate UPDATE for invalid signature', async () => {
      // Attacker submits a valid existence proof
      // but their signature is invalid
      const badUpdate = await Escher.makeUpdate(tree, namehash, pub1, priv2);
      // Flip a bit to corrupt signature
      badUpdate[
        1 +                // version
        Escher.BYTES +     // proposed root
        1 +                // opcode
        Escher.BYTES +     // namehash
        Escher.KEY_SIZE    // new key
                           // signature starts here
      ] ^= 1;

      assert.throws(
        () => Escher.check(badUpdate, current),
        {message: 'Invalid signature for Escher UPDATE.'}
      );
    });
  });

  describe('Integration', function () {
    // Layer 2 nodes track Escher tree
    const tree = Escher.tree();

    // Layer 1 nodes do this
    const node = new FullNode({
      memory: true,
      network: 'regtest'
    });
    node.use(plugin);
    const {wdb} = node.get('walletdb');
    let wallet, TLD, TLDhash;

    // Generate keypairs (for SLD buyer)
    const priv1 = Escher.algorithm.privateKeyGenerate();
    const pub1 = Escher.algorithm.publicKeyCreate(priv1);
    const priv2 = Escher.algorithm.privateKeyGenerate();
    const pub2 = Escher.algorithm.publicKeyCreate(priv2);

    // Note FQDN
    const name = 'campaign.chaos.';
    const namehash = Escher.namehashFromName(name);

    before(async () => {
      await tree.open();
      await node.open();
    });

    after(async () => {
      await node.close();
      await tree.close();
    });

    async function mineBlocks(n, tx) {
      for (; n > 0; n--) {
        const job = await node.miner.createJob();
        if (tx)
          job.pushTX(tx);
        job.refresh();
        const block = await job.mineAsync();
        assert(await node.chain.add(block));
      }
      await forValue(wdb, 'height', node.chain.height);
    }

    async function checkRoots() {
      const ns = await node.getNameStatus(TLDhash);
      const layer1Root = ns.data.slice(1, Escher.BYTES + 1);
      const layer2Root = tree.rootHash();

      // Ensure that the layer 2 nodes are in sync with the layer 1 chain
      assert.bufferEqual(layer1Root, layer2Root);
    }

    it('should fund wallet and win name', async () => {
      TLD = await rules.grindName(4, 10, network);
      TLDhash = rules.hashName(TLD);
      wallet = wdb.primary;

      node.miner.addresses.length = 0;
      node.miner.addAddress(await wallet.receiveAddress());

      await mineBlocks(10);
      await wallet.sendOpen(TLD, true);
      await mineBlocks(treeInterval + 1);
      await wallet.sendBid(TLD, 1e6, 1e6);
      await mineBlocks(biddingPeriod);
      await wallet.sendRevealAll();
      await mineBlocks(revealPeriod);
      await wallet.sendUpdate(TLD);
      await mineBlocks(1);
    });

    it('should update before Escher mode', async () => {
      // Update with irrelevant data (could be DNS records)
      await wallet.sendUpdate(TLD, Buffer.from([0, 1, 2, 3, 4, 5]));
      await mineBlocks(1);
    });

    it('should fail to initialize invalid Escher chain', async () => {
      // Incorrect initialization vector
      const tx = await wallet.createUpdate(TLD, Buffer.from([Escher.ESCHER_VERSION]));
      await assert.rejects(
        mineBlocks(1, tx.toTX()),
        {message: /bad-update-escher/}
      );
    });

    it('should initialize Escher chain', async () => {
      await wallet.sendUpdate(TLD, Escher.initialState());
      await mineBlocks(1);
      // Layer 2 tree is empty
      await checkRoots();
    });

    it('should stay in Escher mode forever', async () => {
      // Attempt to update with irrelevant data (could be DNS records)
      const tx = await wallet.createUpdate(TLD, Buffer.from([0, 1, 2, 3, 4, 5]));
      await assert.rejects(
        mineBlocks(1, tx.toTX()),
        {message: /bad-update-escher/}
      );
      await checkRoots();
    });

    it('should REGISTER', async () => {
      const register = await Escher.makeRegister(tree, namehash, pub1);
      await wallet.sendUpdate(TLD, register);
      await mineBlocks(1);

      await insert(tree, namehash, pub1);
      await checkRoots();
    });

    it('should UPDATE', async () => {
      const update = await Escher.makeUpdate(tree, namehash, pub2, priv1);
      await wallet.sendUpdate(TLD, update);
      await mineBlocks(1);

      await insert(tree, namehash, pub2);
      await checkRoots();
    });

    it('should UPDATE again', async () => {
      const update = await Escher.makeUpdate(tree, namehash, pub1, priv2);
      await wallet.sendUpdate(TLD, update);
      await mineBlocks(1);

      await insert(tree, namehash, pub1);
      await checkRoots();
    });

    it('should REGISTER another SLD', async () => {
      const randomNamehash = random.randomBytes(Escher.BYTES);
      const register = await Escher.makeRegister(tree, randomNamehash, pub1);
      await wallet.sendUpdate(TLD, register);
      await mineBlocks(1);

      await insert(tree, randomNamehash, pub1);
      await checkRoots();
    });
  });
});
