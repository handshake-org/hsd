/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const {resolve} = require('path');
const fs = require('fs');
const {BloomFilter} = require('bfilter');
const {nonce} = require('../lib/net/common');
const consensus = require('../lib/protocol/consensus');
const Framer = require('../lib/net/framer');
const packets = require('../lib/net/packets');
const NetAddress = require('../lib/net/netaddress');
const {CompactBlock, TXRequest, TXResponse} = require('../lib/net/bip152');
const InvItem = require('../lib/primitives/invitem');
const Headers = require('../lib/primitives/headers');
const Block = require('../lib/primitives/block');
const MemBlock = require('../lib/primitives/memblock');
const MerkleBlock = require('../lib/primitives/merkleblock');
const TX = require('../lib/primitives/tx');
const Claim = require('../lib/primitives/claim');
const Network = require('../lib/protocol/network');
const genesis = require('../lib/protocol/genesis');
const UrkelProof = require('urkel/radix').Proof;
const blake2b = require('bcrypto/lib/blake2b');
const AirdropProof = require('../lib/primitives/airdropproof');
const HostList = require('../lib/net/hostlist');

const AIRDROP_PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const read = file => Buffer.from(fs.readFileSync(file, 'binary'), 'base64');

describe('Net', function() {
  describe('Packets', function() {
    it('should encode/decode version packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.VERSION);
        assert.equal(pkt.version, 70012);
        assert.equal(pkt.services, 10);
        assert.equal(pkt.time, 1558405603);
        assert.equal(pkt.remote.host, '127.0.0.1');
        assert.equal(pkt.remote.port, 8334);
        assert.bufferEqual(pkt.nonce, Buffer.alloc(8, 0x00));
        assert.equal(pkt.agent, 'hsd');
        assert.equal(pkt.height, 500000);
        assert.equal(pkt.noRelay, true);
      };

      let pkt = new packets.VersionPacket({
        version: 70012,
        services: 10,
        time: 1558405603,
        remote: {
          host: '127.0.0.1',
          port: 8334
        },
        local: {
          host: '127.0.0.1',
          port: 8335
        },
        nonce: Buffer.alloc(8, 0x00),
        agent: 'hsd',
        height: 500000,
        noRelay: true
      });
      check(pkt);

      pkt = packets.VersionPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode verack packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.VERACK);
      };

      let pkt = new packets.VerackPacket();
      check(pkt);

      pkt = packets.VerackPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode ping packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.PING);
        assert.bufferEqual(pkt.nonce, Buffer.alloc(8, 0x01));
      };

      let pkt = new packets.PingPacket(Buffer.alloc(8, 0x01));
      check(pkt);

      pkt = packets.PingPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode pong packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.PONG);
        assert.bufferEqual(pkt.nonce, Buffer.alloc(8, 0x01));
      };

      let pkt = new packets.PongPacket(Buffer.alloc(8, 0x01));
      check(pkt);

      pkt = packets.PongPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode getaddr packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETADDR);
      };

      let pkt = new packets.GetAddrPacket();
      check(pkt);

      pkt = packets.GetAddrPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode addr packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.ADDR);

        let addr = pkt.items[0];
        assert.equal(addr.host, '127.0.0.2');
        assert.equal(addr.port, 8334);
        assert.equal(addr.services, 101);
        assert.equal(addr.time, 1558405603);

        addr = pkt.items[1];
        assert.equal(addr.host, '127.0.0.3');
        assert.equal(addr.port, 8333);
        assert.equal(addr.services, 102);
        assert.equal(addr.time, 1558405602);
      };

      const items = [
        new NetAddress({
          host: '127.0.0.2',
          port: 8334,
          services: 101,
          time: 1558405603
        }),
        new NetAddress({
          host: '127.0.0.3',
          port: 8333,
          services: 102,
          time: 1558405602
        })
      ];

      let pkt = new packets.AddrPacket(items);
      check(pkt);

      pkt = packets.AddrPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode inv packets', () => {
      const check = (pkt, many) => {
        assert.equal(pkt.type, packets.types.INV);

        let item = pkt.items[0];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x01));

        item = pkt.items[1];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x02));

        if (many) {
          for (let i = 2; i < 254; i++) {
            item = pkt.items[i];
            assert.equal(item.type, 1);
            assert.bufferEqual(item.hash, Buffer.alloc(32, 0x03));
          }
        }
      };

      const items = [
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x01)),
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x02))
      ];

      let pkt = new packets.InvPacket(items);
      check(pkt, false);

      pkt = packets.InvPacket.decode(pkt.encode());
      check(pkt, false);

      while (items.length < 254)
        items.push(new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x03)));

      pkt = new packets.InvPacket(items);
      check(pkt, true);

      pkt = packets.InvPacket.decode(pkt.encode());
      check(pkt, true);
    });

    it('should encode/decode getdata packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETDATA);

        let item = pkt.items[0];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x01));

        item = pkt.items[1];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x02));
      };

      const items = [
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x01)),
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x02))
      ];

      let pkt = new packets.GetDataPacket(items);
      check(pkt);

      pkt = packets.GetDataPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode notfound packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.NOTFOUND);

        let item = pkt.items[0];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x01));

        item = pkt.items[1];
        assert.equal(item.type, 1);
        assert.bufferEqual(item.hash, Buffer.alloc(32, 0x02));
      };

      const items = [
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x01)),
        new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x02))
      ];

      let pkt = new packets.NotFoundPacket(items);
      check(pkt);

      pkt = packets.NotFoundPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode getblocks packets', () => {
      const check = (pkt, values) => {
        assert.equal(pkt.type, packets.types.GETBLOCKS);

        if (values) {
          assert.equal(pkt.locator.length, 2);
          assert.bufferEqual(pkt.locator[0], Buffer.alloc(32, 0x01));
          assert.bufferEqual(pkt.locator[1], Buffer.alloc(32, 0x02));
          assert.bufferEqual(pkt.stop, Buffer.alloc(32, 0x03));
        } else {
          assert.equal(pkt.locator.length, 0);
          assert.bufferEqual(pkt.stop, Buffer.alloc(32, 0x00));
        }
      };

      const locator = [
        Buffer.alloc(32, 0x01),
        Buffer.alloc(32, 0x02)
      ];

      const stop = Buffer.alloc(32, 0x03);

      let pkt = new packets.GetBlocksPacket(locator, stop);
      check(pkt, true);

      pkt = packets.GetBlocksPacket.decode(pkt.encode());
      check(pkt, true);

      pkt = new packets.GetBlocksPacket();
      check(pkt, false);

      pkt = packets.GetBlocksPacket.decode(pkt.encode());
      check(pkt, false);
    });

    it('should encode/decode getheaders packets', () => {
      const check = (pkt, values) => {
        assert.equal(pkt.type, packets.types.GETHEADERS);

        if (values) {
          assert.equal(pkt.locator.length, 2);
          assert.bufferEqual(pkt.locator[0], Buffer.alloc(32, 0x01));
          assert.bufferEqual(pkt.locator[1], Buffer.alloc(32, 0x02));
          assert.bufferEqual(pkt.stop, Buffer.alloc(32, 0x03));
        } else {
          assert.equal(pkt.locator.length, 0);
          assert.bufferEqual(pkt.stop, Buffer.alloc(32, 0x00));
        }
      };

      const locator = [
        Buffer.alloc(32, 0x01),
        Buffer.alloc(32, 0x02)
      ];

      const stop = Buffer.alloc(32, 0x03);

      let pkt = new packets.GetHeadersPacket(locator, stop);
      check(pkt, true);

      pkt = packets.GetHeadersPacket.decode(pkt.encode());
      check(pkt, true);

      pkt = new packets.GetHeadersPacket();
      check(pkt, false);

      pkt = packets.GetHeadersPacket.decode(pkt.encode());
      check(pkt, false);
    });

    it('should encode/decode headers packets', () => {
      const check = (pkt, values, many) => {
        assert.equal(pkt.type, packets.types.HEADERS);

        assert.equal(pkt.items[0].version, 0);
        assert.bufferEqual(pkt.items[0].prevBlock, Buffer.alloc(32, 0x01));
        assert.bufferEqual(pkt.items[0].merkleRoot, Buffer.alloc(32, 0x02));
        assert.bufferEqual(pkt.items[0].witnessRoot, Buffer.alloc(32, 0x03));
        assert.bufferEqual(pkt.items[0].treeRoot, Buffer.alloc(32, 0x04));
        assert.bufferEqual(pkt.items[0].reservedRoot, Buffer.alloc(32, 0x06));
        assert.equal(pkt.items[0].time, 1558405603);
        assert.equal(pkt.items[0].bits, 403014710);
        assert.equal(pkt.items[0].nonce, 0x11);
        assert.bufferEqual(pkt.items[0].extraNonce, Buffer.alloc(consensus.NONCE_SIZE, 0x11));

        if (many) {
          for (let i = 1; i < 254; i++) {
            const item = pkt.items[i];
            assert.equal(item.version, 0);
            assert.bufferEqual(pkt.items[1].prevBlock, Buffer.alloc(32, 0x04));
            assert.bufferEqual(pkt.items[1].merkleRoot, Buffer.alloc(32, 0x05));
            assert.equal(pkt.items[1].time, 1558405605);
            assert.equal(pkt.items[1].bits, 403014712);
            assert.equal(pkt.items[1].nonce, 0x11);
            assert.bufferEqual(pkt.items[1].extraNonce, Buffer.alloc(consensus.NONCE_SIZE, 0x11));
          }
        }
      };

      const items = [
        new Headers({
          version: 0,
          prevBlock: Buffer.alloc(32, 0x01),
          merkleRoot: Buffer.alloc(32, 0x02),
          witnessRoot: Buffer.alloc(32, 0x03),
          treeRoot: Buffer.alloc(32, 0x04),
          reservedRoot: Buffer.alloc(32, 0x06),
          time: 1558405603,
          bits: 403014710,
          nonce: 0x11,
          extraNonce: Buffer.alloc(consensus.NONCE_SIZE, 0x11),
          mask: Buffer.alloc(32, 0x00)
        })
      ];

      let pkt = new packets.HeadersPacket(items);
      check(pkt, false);

      pkt = packets.HeadersPacket.decode(pkt.encode());
      check(pkt, false);

      while (items.length < 254) {
        items.push(new Headers({
          version: 0,
          prevBlock: Buffer.alloc(32, 0x04),
          merkleRoot: Buffer.alloc(32, 0x05),
          witnessRoot: Buffer.alloc(32, 0x03),
          treeRoot: Buffer.alloc(32, 0x04),
          reservedRoot: Buffer.alloc(32, 0x06),
          time: 1558405605,
          bits: 403014712,
          nonce: 0x11,
          extraNonce: Buffer.alloc(consensus.NONCE_SIZE, 0x11),
          mask: Buffer.alloc(32, 0x00)
        }));
      }

      pkt = new packets.HeadersPacket(items);
      check(pkt, true);

      pkt = packets.HeadersPacket.decode(pkt.encode());
      check(pkt, true);
    });

    it('should encode/decode sendheaders packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.SENDHEADERS);
      };

      let pkt = new packets.SendHeadersPacket();
      check(pkt);

      pkt = packets.SendHeadersPacket.fromRaw(pkt.toRaw());
      check(pkt);
    });

    it('should encode/decode block packets', () => {
      const block = new Block(genesis.main);
      const memblock = MemBlock.decode(block.encode());

      // sanity check
      assert.bufferEqual(block.encode(), memblock.encode());

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.BLOCK);
        assert.bufferEqual(pkt.block.hash(), block.hash());
      };

      let pkt = new packets.BlockPacket(memblock);
      check(pkt);

      pkt = packets.BlockPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode tx packets', () => {
      const tx = new TX({
        inputs: [{
          prevout: {index: 0, hash: Buffer.alloc(32, 0x00)}
        }],
        outputs: [{address: {hash: Buffer.alloc(20, 0x00), version: 0}}]
      });

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.TX);
        assert.bufferEqual(pkt.tx.hash(), tx.hash());
      };

      let pkt = new packets.TXPacket(tx);
      check(pkt);

      pkt = packets.TXPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode reject packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.REJECT);
        assert.equal(pkt.message, packets.types.BLOCK);
        assert.equal(pkt.reason, 'block');
        assert.equal(packets.typesByVal[pkt.message], 'BLOCK');
        assert.equal(pkt.getCode(), 'invalid');
        assert.bufferEqual(pkt.hash, Buffer.alloc(32, 0x01));
      };

      let pkt = new packets.RejectPacket({
        message: packets.types.BLOCK,
        code: packets.RejectPacket.codes.INVALID,
        reason: 'block',
        hash: Buffer.alloc(32, 0x01)
      });

      check(pkt);

      pkt = packets.RejectPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.RejectPacket.fromReason(
        'invalid',
        'block',
        packets.types.BLOCK,
        Buffer.alloc(32, 0x01)
      );

      check(pkt);

      pkt = packets.RejectPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode mempool packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.MEMPOOL);
      };

      let pkt = new packets.MempoolPacket();
      check(pkt);

      pkt = packets.MempoolPacket.decode(pkt.encode());
    });

    it('should encode/decode filterload packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FILTERLOAD);
        assert.equal(pkt.filter.test(Buffer.alloc(32, 0x01)), true);
      };

      const filter = BloomFilter.fromRate(
        20000, 0.001, BloomFilter.flags.ALL);

      filter.add(Buffer.alloc(32, 0x01));

      let pkt = new packets.FilterLoadPacket(filter);
      check(pkt);

      pkt = packets.FilterLoadPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode filteradd packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FILTERADD);
        assert.bufferEqual(pkt.data, Buffer.alloc(32, 0x02));
      };

      let pkt = new packets.FilterAddPacket(Buffer.alloc(32, 0x02));
      check(pkt);

      pkt = packets.FilterAddPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode filterclear packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FILTERCLEAR);
      };

      let pkt = new packets.FilterClearPacket();
      check(pkt);

      pkt = packets.FilterClearPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode merkleblock packets', () => {
      const block = new Block();
      block.txs = [new TX({
        inputs: [{prevout: {hash: Buffer.alloc(32), index: 0}}],
        outputs: [{value: 1000}]
      })];

      const filter = new BloomFilter();
      const merkleblock = MerkleBlock.fromBlock(block, filter);

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.MERKLEBLOCK);
        assert.bufferEqual(pkt.block.hash(), block.hash());
      };

      let pkt = new packets.MerkleBlockPacket(merkleblock);
      check(pkt);

      pkt = packets.MerkleBlockPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode feefilter packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FEEFILTER);
        assert.equal(pkt.rate, 120000);
      };

      let pkt = new packets.FeeFilterPacket(120000);
      check(pkt);

      pkt = packets.FeeFilterPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode sendcmpct packets', () => {
      const check = (pkt, mode, version) => {
        assert.equal(pkt.type, packets.types.SENDCMPCT);
        assert.equal(pkt.mode, mode);
        assert.equal(pkt.version, version);
      };

      let pkt = new packets.SendCmpctPacket();
      check(pkt, 0, 1);

      pkt = packets.SendCmpctPacket.decode(pkt.encode());
      check(pkt, 0, 1);

      pkt = new packets.SendCmpctPacket(1, 2);
      check(pkt, 1, 2);

      pkt = packets.SendCmpctPacket.decode(pkt.encode());
      check(pkt, 1, 2);
    });

    it('should encode/decode cmpctblock packets', () => {
      const block = new Block();
      block.txs = [new TX({
        inputs: [{prevout: {hash: Buffer.alloc(32), index: 0}}],
        outputs: [{value: 1000}]
      })];

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.CMPCTBLOCK);
        assert.bufferEqual(pkt.block.hash(), block.hash());
      };

      const compact = CompactBlock.fromBlock(block);

      let pkt = new packets.CmpctBlockPacket(compact);
      check(pkt);

      pkt = packets.CmpctBlockPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode getblocktxn packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETBLOCKTXN);
        assert.bufferEqual(pkt.request.hash, Buffer.alloc(32, 0x01));
        assert.deepEqual(pkt.request.indexes, [2, 3, 5, 7, 11]);
      };

      const request = new TXRequest({
        hash: Buffer.alloc(32, 0x01),
        indexes: [2, 3, 5, 7, 11]
      });

      let pkt = new packets.GetBlockTxnPacket(request);
      check(pkt);

      pkt = packets.GetBlockTxnPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode blocktxn packets', () => {
      const block = new Block();
      block.txs = [new TX({
        inputs: [{prevout: {hash: Buffer.alloc(32), index: 0}}],
        outputs: [{value: 1000}]
      })];

      const tx = block.txs[0];

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.BLOCKTXN);
        assert.bufferEqual(pkt.response.hash, Buffer.alloc(32, 0x01));
        assert.bufferEqual(pkt.response.txs[0].hash(), tx.hash());
      };

      const response = new TXResponse({
        hash: Buffer.alloc(32, 0x01),
        txs: [tx]
      });

      let pkt = new packets.BlockTxnPacket(response);
      check(pkt);

      pkt = packets.BlockTxnPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode getproof packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETPROOF);
        assert.bufferEqual(pkt.root, Buffer.alloc(32, 0x01));
        assert.bufferEqual(pkt.key, Buffer.alloc(32, 0x02));
      };

      let pkt = new packets.GetProofPacket(Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02));

      check(pkt);

      pkt = packets.GetProofPacket.decode(pkt.encode());

      check(pkt);
    });

    it('should encode/decode proof packets', () => {
      const root = Buffer.alloc(32, 0x00);
      const key = Buffer.alloc(32, 0x01);
      const proof = new UrkelProof();

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.PROOF);
        assert.bufferEqual(pkt.root, root);
        assert.bufferEqual(pkt.key, key);
        assert.bufferEqual(pkt.proof.encode(blake2b, 256), proof.encode(blake2b, 256));
      };

      let pkt = new packets.ProofPacket(root, key, proof);
      check(pkt);

      pkt = packets.ProofPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode claim packets', () => {
      const claim = new Claim();
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.CLAIM);
        assert.bufferEqual(pkt.claim.encode(), claim.encode());
      };

      let pkt = new packets.ClaimPacket();
      check(pkt);

      pkt = packets.ClaimPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode airdrop packets', () => {
      const rawProof = read(AIRDROP_PROOF_FILE);
      const proof = AirdropProof.decode(rawProof);

      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.AIRDROP);
        assert.bufferEqual(pkt.proof.encode(), proof.encode());
      };

      let pkt = new packets.AirdropPacket(proof);
      check(pkt);

      pkt = packets.AirdropPacket.decode(pkt.encode());
      check(pkt);
    });

    it('should encode/decode unknown packets', () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.UNKNOWN);
        assert.bufferEqual(pkt.data, Buffer.alloc(12, 0x01));
      };

      let pkt = new packets.UnknownPacket(packets.types.UNKNOWN, Buffer.alloc(12, 0x01));
      check(pkt);

      pkt = packets.UnknownPacket.decode(pkt.encode(), packets.types.UNKNOWN);
      check(pkt);
    });
  });

  describe('Framer', function() {
    it('will construct with network (primary)', () => {
      const framer = new Framer();
      assert.strictEqual(framer.network, Network.get('main'));
    });

    it('will construct with network (custom)', () => {
      const framer = new Framer('regtest');
      assert.strictEqual(framer.network, Network.get('regtest'));
    });

    it('throw with long command', () => {
      const framer = new Framer('regtest');
      let err = null;

      // Packet types are defined by a uint8.
      // Pass a number that is too large and
      // assert there is an error.
      try {
        framer.packet(256, Buffer.alloc(2, 0x00));
      } catch (e) {
        err = e;
      }
      assert(err);
      assert(err.type, 'AssertionError');
    });

    it('will frame payload with header', () => {
      const framer = new Framer('regtest');
      const network = Network.get('regtest');
      const buf = Buffer.alloc(2, 0x01);

      const pkt = framer.packet(packets.types.PING, buf);

      const magic = pkt.slice(0, 4);
      assert.equal(magic.readUInt32LE(), network.magic);

      const cmd = pkt.slice(4, 5);
      assert.equal(cmd.readUInt8(), packets.types.PING);

      const len = pkt.slice(5, 9).readUInt32LE();

      const cmdbuf = pkt.slice(9, 9 + len);
      assert.bufferEqual(cmdbuf, buf);
    });
  });

  describe('Common', function() {
    it('will give nonce', async () => {
      const n = nonce();
      assert(Buffer.isBuffer(n));
      assert.equal(n.length, 8);
    });
  });

  describe('HostList', function() {
    let hosts;

    beforeEach(async () => {
      hosts = new HostList({
        memory: true
      });
      await hosts.open();
    });

    afterEach(async () => {
      await hosts.close();
    });

    it('should index hosts by fullname', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 0,
        time: 1576942048,
        key: Buffer.alloc(33, 0x01)
      });

      hosts.add(addr1);

      assert.strictEqual(hosts.map.size, 1);

      const test1 = hosts.map.get(addr1.fullname());
      assert.deepStrictEqual(addr1.getJSON(), test1.addr.getJSON());
    });

    it('should add/remove duplicate host with different key', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Different key from addr1 (same hostname, different fullname)
      // Other differences so we can test which addr gets saved.
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x02)
      });

      // Add both
      hosts.add(addr1);
      hosts.add(addr2);

      // Both are there
      assert.strictEqual(hosts.map.size, 2);

      const test1 = hosts.map.get(addr1.fullname());
      assert.deepStrictEqual(addr1.getJSON(), test1.addr.getJSON());

      const test2 = hosts.map.get(addr2.fullname());
      assert.deepStrictEqual(addr2.getJSON(), test2.addr.getJSON());

      // Remove one
      hosts.remove(addr1.fullname());

      // Only one removed
      assert.strictEqual(hosts.map.size, 1);
      assert.strictEqual(hosts.map.get(addr1.fullname(), null));
      assert.deepStrictEqual(addr2.getJSON(), test2.addr.getJSON());
    });

    it('should not add duplicate host with duplicate key', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Same fullname as addr1, but different services and time
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x01)
      });

      hosts.add(addr1);
      hosts.add(addr2);

      assert.strictEqual(hosts.map.size, 1);

      const test1 = hosts.map.get(addr1.fullname());
      assert.deepStrictEqual(addr1.getJSON(), test1.addr.getJSON());

      const test2 = hosts.map.get(addr2.fullname());
      assert.notDeepStrictEqual(addr2.getJSON(), test2.addr.getJSON());
    });

    it('should index banned hosts by IP only', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Same IP as addr1, different everything else
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 5678,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x02)
      });

      hosts.ban(addr1.host);

      // One ban applies to both addresses
      assert(hosts.banned.size, 1);
      assert(hosts.isBanned(addr1.host));
      assert(hosts.isBanned(addr2.host));
    });

    it('should mark attempt', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1000001,
        key: Buffer.alloc(33, 0x01)
      });

      assert(!hosts.map.get(addr1.fullname()));
      assert(hosts.add(addr1));

      const test1 = hosts.map.get(addr1.fullname());
      assert.strictEqual(test1.attempts, 0);
      assert.strictEqual(test1.lastAttempt, 0);

      hosts.markAttempt(addr1.fullname());

      const test2 = hosts.map.get(addr1.fullname());
      assert.strictEqual(test2.attempts, 1);
      // Bitcoin genesis block timestamp (01/03/2009 @ 6:15pm (UTC))
      assert(test2.lastAttempt > 1231006505);
    });

    it('should mark success', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1000001,
        key: Buffer.alloc(33, 0x01)
      });

      assert(!hosts.map.get(addr1.fullname()));
      assert(hosts.add(addr1));

      const test1 = hosts.map.get(addr1.fullname());
      assert.strictEqual(test1.addr.time, 1000001);

      hosts.markSuccess(addr1.fullname());

      const test2 = hosts.map.get(addr1.fullname());
      // Bitcoin genesis block timestamp (01/03/2009 @ 6:15pm (UTC))
      assert(test2.addr.time > 1231006505);
    });

    it('should sort hosts into used bucket by IP only', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Same IP as addr1, different everything else
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 5678,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x02)
      });

      // Different IP as addr1, same everything else
      const addr3 = new NetAddress({
        host: '50.60.70.80',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // These functions expect a HostEntry, but the constructor is not exposed
      const used1 = hosts.usedBucket({addr: addr1});
      const used2 = hosts.usedBucket({addr: addr2});
      const used3 = hosts.usedBucket({addr: addr3});

      assert(used1 === used2);
      assert(used1 !== used3);
    });

    it('should sort hosts into fresh bucket by IP only', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Same IP as addr1, different everything else
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 5678,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x02)
      });

      // Different IP as addr1, same everything else
      const addr3 = new NetAddress({
        host: '50.60.70.80',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // These functions expect a HostEntry, but the constructor is not exposed
      const used1 = hosts.freshBucket({addr: addr1, src: new NetAddress()});
      const used2 = hosts.freshBucket({addr: addr2, src: new NetAddress()});
      const used3 = hosts.freshBucket({addr: addr3, src: new NetAddress()});

      assert(used1 === used2);
      assert(used1 !== used3);
    });

    it('should index hosts by fullname within each fresh bucket', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 1,
        time: 1576111111,
        key: Buffer.alloc(33, 0x01)
      });

      // Same IP as addr1, different everything else
      const addr2 = new NetAddress({
        host: '10.20.30.40',
        port: 5678,
        services: 2,
        time: 1576222222,
        key: Buffer.alloc(33, 0x02)
      });

      const used1 = hosts.freshBucket({addr: addr1, src: new NetAddress()});

      hosts.add(addr1);
      hosts.add(addr2);

      assert.strictEqual(used1.size, 2);
      used1.has(addr1.fullname());
      used1.has(addr2.fullname());
    });

    it('should mark ACK', () => {
      const addr1 = new NetAddress({
        host: '10.20.30.40',
        port: 1234,
        services: 0,
        time: 0,
        key: Buffer.alloc(33, 0x01)
      });

      assert(!hosts.map.get(addr1.fullname()));
      assert(hosts.add(addr1));

      const test1 = hosts.map.get(addr1.fullname());
      assert.strictEqual(test1.addr.services, 0);
      assert.strictEqual(test1.lastSuccess, 0);
      assert.strictEqual(test1.lastAttempt, 0);
      assert(!test1.used);

      // All 'used' buckets are empty
      for (const bucket of hosts.used) {
        assert.strictEqual(bucket.size, 0);
      }

      const services = 5678;
      hosts.markAck(addr1.fullname(), services);

      const test2 = hosts.map.get(addr1.fullname());
      // Bitcoin genesis block timestamp (01/03/2009 @ 6:15pm (UTC))
      assert(test2.lastSuccess > 1231006505);
      assert(test2.lastAttempt > 1231006505);
      assert(test2.used);
      assert.strictEqual(test2.addr.services, services);

      // Addr should be in exactly one 'used' bucket
      let count = 0;
      for (const bucket of hosts.used) {
        count += bucket.size;
      }
      assert.strictEqual(count, 1);

      // Addr is in the 'used' bucket we expect it to be in
      const bucket = hosts.usedBucket(test2);
      const test3 = bucket.pop();
      assert.deepStrictEqual(test3.toJSON(), test2.toJSON());
    });
  });
});
