'use strict';

const assert = require('bsert');
const {resolve} = require('path');
const fs = require('fs');
const {BloomFilter} = require('bfilter');
const {nonce} = require('../lib/net/common');
const consensus = require('../lib/protocol/consensus');
const Parser = require('../lib/net/parser');
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
const UrkelProof = require('urkel').Proof;
const blake2b = require('bcrypto/lib/blake2b');
const AirdropProof = require('../lib/primitives/airdropproof');
const util = require('../lib/utils/util');
const pkg = require('../lib/pkg');
const Pool = require('../lib/net/pool');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');

const AIRDROP_PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const read = file => Buffer.from(fs.readFileSync(file, 'binary'), 'base64');

describe('Net', function() {
  describe('Packets', function() {
    let parser, framer;

    beforeEach(() => {
      parser = new Parser();
      framer = new Framer();
    });

    function wireTest(type, payload, test, ...extra) {
      return new Promise((resolve, reject) => {
        parser.once('packet', (packet) => {
          try {
            assert.strictEqual(packet.rawType, type);
            test(packet, ...extra);
          } catch (e) {
            reject(e);
            return;
          }
          resolve();
        });

        const raw = framer.packet(type, payload.encode());
        parser.feed(raw);
      });
    }

    it('should encode/decode version packets', async () => {
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

      pkt = packets.decode(packets.types.VERSION, pkt.encode());
      check(pkt);

      await wireTest(packets.types.VERSION, pkt, check);
    });

    it('should encode/decode version packets (2)', async () => {
      const network = Network.get('main');
      const agent = `/${pkg.name}:${pkg.version}/`;

      const check1 = (pkt) => {
        assert.strictEqual(pkt.version, 300);
        assert.strictEqual(pkt.agent, agent);
        assert.strictEqual(pkt.height, 0);
        assert.strictEqual(pkt.noRelay, false);
      };

      const check2 = (pkt) => {
        assert.strictEqual(pkt.version, 300);
        assert.strictEqual(pkt.agent, agent);
        assert.strictEqual(pkt.height, 10);
        assert.strictEqual(pkt.noRelay, true);
      };

      let pkt;
      pkt = packets.VersionPacket.fromOptions({
        version: 300,
        services: 1,
        time: network.now(),
        remote: new NetAddress(),
        nonce: Buffer.allocUnsafe(8),
        agent: agent,
        height: 0,
        noRelay: false
      });

      check1(pkt);

      pkt = packets.VersionPacket.decode(pkt.encode());
      check1(pkt);

      pkt = packets.decode(packets.types.VERSION, pkt.encode());
      check1(pkt);

      await wireTest(packets.types.VERSION, pkt, check1);

      pkt = packets.VersionPacket.fromOptions({
        version: 300,
        services: 1,
        time: network.now(),
        remote: new NetAddress(),
        nonce: Buffer.allocUnsafe(8),
        agent: agent,
        height: 10,
        noRelay: true
      });

      check2(pkt);

      pkt = packets.VersionPacket.decode(pkt.encode());
      check2(pkt);

      pkt = packets.decode(packets.types.VERSION, pkt.encode());
      check2(pkt);

      await wireTest(packets.types.VERSION, pkt, check2);
    });

    it('should encode/decode verack packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.VERACK);
      };

      let pkt = new packets.VerackPacket();
      check(pkt);

      pkt = packets.VerackPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.VERACK, pkt.encode());
      check(pkt);

      await wireTest(packets.types.VERACK, pkt, check);
    });

    it('should encode/decode ping packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.PING);
        assert.bufferEqual(pkt.nonce, Buffer.alloc(8, 0x01));
      };

      let pkt = new packets.PingPacket(Buffer.alloc(8, 0x01));
      check(pkt);

      pkt = packets.PingPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.PING, pkt.encode());
      check(pkt);

      await wireTest(packets.types.PING, pkt, check);
    });

    it('should encode/decode pong packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.PONG);
        assert.bufferEqual(pkt.nonce, Buffer.alloc(8, 0x01));
      };

      let pkt = new packets.PongPacket(Buffer.alloc(8, 0x01));
      check(pkt);

      pkt = packets.PongPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.PONG, pkt.encode());
      check(pkt);

      await wireTest(packets.types.PONG, pkt, check);
    });

    it('should encode/decode getaddr packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETADDR);
      };

      let pkt = new packets.GetAddrPacket();
      check(pkt);

      pkt = packets.GetAddrPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.GETADDR, pkt.encode());
      check(pkt);

      await wireTest(packets.types.GETADDR, pkt, check);
    });

    it('should encode/decode addr packets', async () => {
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

      pkt = packets.decode(packets.types.ADDR, pkt.encode());
      check(pkt);

      await wireTest(packets.types.ADDR, pkt, check);
    });

    it('should encode/decode addr packets (2)', async () => {
      const hosts = [
        new NetAddress({
          services: 1,
          host: '127.0.0.1',
          port: 8333,
          time: util.now()
        }),
        new NetAddress({
          services: 1,
          host: '::123:456:789a',
          port: 18333,
          time: util.now()
        })
      ];

      const check = (payload) => {
        assert(Array.isArray(payload.items));
        assert.strictEqual(payload.items.length, 2);

        assert(typeof payload.items[0].time === 'number');
        assert.strictEqual(payload.items[0].services, 1);
        assert.strictEqual(payload.items[0].host, hosts[0].host);
        assert.strictEqual(payload.items[0].port, hosts[0].port);

        assert(typeof payload.items[1].time === 'number');
        assert.strictEqual(payload.items[1].services, 1);
        assert.strictEqual(payload.items[1].host, hosts[1].host);
        assert.strictEqual(payload.items[1].port, hosts[1].port);
      };

      let pkt = new packets.AddrPacket(hosts);
      check(pkt);

      pkt = packets.AddrPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.ADDR, pkt.encode());
      check(pkt);

      await wireTest(packets.types.ADDR, pkt, check);
    });

    it('should encode/decode inv packets', async () => {
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

      pkt = packets.decode(packets.types.INV, pkt.encode());
      check(pkt, false);

      await wireTest(packets.types.INV, pkt, check, false);

      while (items.length < 254)
        items.push(new InvItem(InvItem.types.TX, Buffer.alloc(32, 0x03)));

      pkt = new packets.InvPacket(items);
      check(pkt, true);

      pkt = packets.InvPacket.decode(pkt.encode());
      check(pkt, true);

      pkt = packets.decode(packets.types.INV, pkt.encode());
      check(pkt, true);

      await wireTest(packets.types.INV, pkt, check, true);
    });

    it('should encode/decode getdata packets', async () => {
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

      pkt = packets.decode(packets.types.GETDATA, pkt.encode());
      check(pkt);

      await wireTest(packets.types.GETDATA, pkt, check);
    });

    it('should encode/decode notfound packets', async () => {
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

      pkt = packets.decode(packets.types.NOTFOUND, pkt.encode());
      check(pkt);

      await wireTest(packets.types.NOTFOUND, pkt, check);
    });

    it('should encode/decode getblocks packets', async () => {
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

      pkt = packets.decode(packets.types.GETBLOCKS, pkt.encode());
      check(pkt, true);

      await wireTest(packets.types.GETBLOCKS, pkt, check, true);

      pkt = new packets.GetBlocksPacket();
      check(pkt, false);

      pkt = packets.GetBlocksPacket.decode(pkt.encode());
      check(pkt, false);

      pkt = packets.decode(packets.types.GETBLOCKS, pkt.encode());
      check(pkt, false);

      await wireTest(packets.types.GETBLOCKS, pkt, check, false);
    });

    it('should encode/decode getheaders packets', async () => {
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

      pkt = packets.decode(packets.types.GETHEADERS, pkt.encode());
      check(pkt, true);

      await wireTest(packets.types.GETHEADERS, pkt, check, true);

      pkt = new packets.GetHeadersPacket();
      check(pkt, false);

      pkt = packets.GetHeadersPacket.decode(pkt.encode());
      check(pkt, false);

      pkt = packets.decode(packets.types.GETHEADERS, pkt.encode());
      check(pkt, false);

      await wireTest(packets.types.GETHEADERS, pkt, check, false);
    });

    it('should encode/decode headers packets', async () => {
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

      pkt = packets.decode(packets.types.HEADERS, pkt.encode());
      check(pkt, false);

      await wireTest(packets.types.HEADERS, pkt, check, false);

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

      pkt = packets.decode(packets.types.HEADERS, pkt.encode());
      check(pkt, true);

      await wireTest(packets.types.HEADERS, pkt, check, true);
    });

    it('should encode/decode sendheaders packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.SENDHEADERS);
      };

      let pkt = new packets.SendHeadersPacket();
      check(pkt);

      pkt = packets.SendHeadersPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.SENDHEADERS, pkt.encode());
      check(pkt);

      await wireTest(packets.types.SENDHEADERS, pkt, check);
    });

    it('should encode/decode block packets', async () => {
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

      pkt = packets.decode(packets.types.BLOCK, pkt.encode());
      check(pkt);

      await wireTest(packets.types.BLOCK, pkt, check);
    });

    it('should encode/decode tx packets', async () => {
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

      pkt = packets.decode(packets.types.TX, pkt.encode());
      check(pkt);

      await wireTest(packets.types.TX, pkt, check);
    });

    it('should encode/decode reject packets', async () => {
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

      pkt = packets.decode(packets.types.REJECT, pkt.encode());
      check(pkt);

      await wireTest(packets.types.REJECT, pkt, check);

      pkt = packets.RejectPacket.fromReason(
        'invalid',
        'block',
        packets.types.BLOCK,
        Buffer.alloc(32, 0x01)
      );

      check(pkt);

      pkt = packets.RejectPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.REJECT, pkt.encode());
      check(pkt);

      await wireTest(packets.types.REJECT, pkt, check);
    });

    it('should encode/decode mempool packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.MEMPOOL);
      };

      let pkt = new packets.MempoolPacket();
      check(pkt);

      pkt = packets.MempoolPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.MEMPOOL, pkt.encode());
      check(pkt);

      await wireTest(packets.types.MEMPOOL, pkt, check);
    });

    it('should encode/decode filterload packets', async () => {
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

      pkt = packets.decode(packets.types.FILTERLOAD, pkt.encode());
      check(pkt);

      await wireTest(packets.types.FILTERLOAD, pkt, check);
    });

    it('should encode/decode filteradd packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FILTERADD);
        assert.bufferEqual(pkt.data, Buffer.alloc(32, 0x02));
      };

      let pkt = new packets.FilterAddPacket(Buffer.alloc(32, 0x02));
      check(pkt);

      pkt = packets.FilterAddPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.FILTERADD, pkt.encode());
      check(pkt);

      await wireTest(packets.types.FILTERADD, pkt, check);
    });

    it('should encode/decode filterclear packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FILTERCLEAR);
      };

      let pkt = new packets.FilterClearPacket();
      check(pkt);

      pkt = packets.FilterClearPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.FILTERCLEAR, pkt.encode());
      check(pkt);

      await wireTest(packets.types.FILTERCLEAR, pkt, check);
    });

    it('should encode/decode merkleblock packets', async () => {
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

      pkt = packets.decode(packets.types.MERKLEBLOCK, pkt.encode());
      check(pkt);

      await wireTest(packets.types.MERKLEBLOCK, pkt, check);
    });

    it('should encode/decode feefilter packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.FEEFILTER);
        assert.equal(pkt.rate, 120000);
      };

      let pkt = new packets.FeeFilterPacket(120000);
      check(pkt);

      pkt = packets.FeeFilterPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.FEEFILTER, pkt.encode());
      check(pkt);

      await wireTest(packets.types.FEEFILTER, pkt, check);
    });

    it('should encode/decode sendcmpct packets', async () => {
      const check = (pkt, mode, version) => {
        assert.equal(pkt.type, packets.types.SENDCMPCT);
        assert.equal(pkt.mode, mode);
        assert.equal(pkt.version, version);
      };

      let pkt = new packets.SendCmpctPacket();
      check(pkt, 0, 1);

      pkt = packets.SendCmpctPacket.decode(pkt.encode());
      check(pkt, 0, 1);

      pkt = packets.decode(packets.types.SENDCMPCT, pkt.encode());
      check(pkt, 0, 1);

      await wireTest(packets.types.SENDCMPCT, pkt, check, 0, 1);

      pkt = new packets.SendCmpctPacket(1, 2);
      check(pkt, 1, 2);

      pkt = packets.SendCmpctPacket.decode(pkt.encode());
      check(pkt, 1, 2);

      pkt = packets.decode(packets.types.SENDCMPCT, pkt.encode());
      check(pkt, 1, 2);

      await wireTest(packets.types.SENDCMPCT, pkt, check, 1, 2);
    });

    it('should encode/decode cmpctblock packets', async () => {
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

      pkt = packets.decode(packets.types.CMPCTBLOCK, pkt.encode());
      check(pkt);

      await wireTest(packets.types.CMPCTBLOCK, pkt, check);
    });

    it('should encode/decode getblocktxn packets', async () => {
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

      pkt = packets.decode(packets.types.GETBLOCKTXN, pkt.encode());
      check(pkt);

      await wireTest(packets.types.GETBLOCKTXN, pkt, check);
    });

    it('should encode/decode blocktxn packets', async () => {
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

      pkt = packets.decode(packets.types.BLOCKTXN, pkt.encode());
      check(pkt);

      await wireTest(packets.types.BLOCKTXN, pkt, check);
    });

    it('should encode/decode getproof packets', async () => {
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.GETPROOF);
        assert.bufferEqual(pkt.root, Buffer.alloc(32, 0x01));
        assert.bufferEqual(pkt.key, Buffer.alloc(32, 0x02));
      };

      let pkt = new packets.GetProofPacket(Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02));
      check(pkt);

      pkt = packets.GetProofPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.GETPROOF, pkt.encode());
      check(pkt);

      await wireTest(packets.types.GETPROOF, pkt, check);
    });

    it('should encode/decode proof packets', async () => {
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

      pkt = packets.decode(packets.types.PROOF, pkt.encode());
      check(pkt);

      await wireTest(packets.types.PROOF, pkt, check);
    });

    it('should encode/decode claim packets', async () => {
      const claim = new Claim();
      const check = (pkt) => {
        assert.equal(pkt.type, packets.types.CLAIM);
        assert.bufferEqual(pkt.claim.encode(), claim.encode());
      };

      let pkt = new packets.ClaimPacket();
      check(pkt);

      pkt = packets.ClaimPacket.decode(pkt.encode());
      check(pkt);

      pkt = packets.decode(packets.types.CLAIM, pkt.encode());
      check(pkt);

      await wireTest(packets.types.CLAIM, pkt, check);
    });

    it('should encode/decode airdrop packets', async () => {
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

      pkt = packets.decode(packets.types.AIRDROP, pkt.encode());
      check(pkt);

      await wireTest(packets.types.AIRDROP, pkt, check);
    });

    it('should encode/decode unknown packets', async () => {
      const check = (pkt, rawType) => {
        assert.strictEqual(pkt.type, packets.types.UNKNOWN);
        assert.strictEqual(pkt.rawType, rawType);
        assert.bufferEqual(pkt.data, Buffer.alloc(12, 0x01));
      };

      let pkt = new packets.UnknownPacket(packets.types.UNKNOWN, Buffer.alloc(12, 0x01));
      check(pkt, packets.types.UNKNOWN);

      pkt = packets.UnknownPacket.decode(pkt.encode(), packets.types.UNKNOWN);
      check(pkt, packets.types.UNKNOWN);

      pkt = packets.decode(packets.types.UNKNOWN, pkt.encode());
      check(pkt, packets.types.UNKNOWN);

      await wireTest(packets.types.UNKNOWN, pkt, check, packets.types.UNKNOWN);

      // real UnknownPacket
      const RAW_TYPE = 255;

      pkt = new packets.UnknownPacket(RAW_TYPE, Buffer.alloc(12, 0x01));
      check(pkt, RAW_TYPE);

      pkt = packets.decode(RAW_TYPE, pkt.encode());
      check(pkt, RAW_TYPE);

      await wireTest(RAW_TYPE, pkt, check, RAW_TYPE);
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

  describe('User Agent', function() {
    const blocks = new BlockStore({memory: true});
    const chain = new Chain({blocks, memory: true});

    it('should reject slashes', async () => {
      let err;
      try {
        new Pool({
          chain,
          agent: 'face/off'
        });
      } catch (e) {
        err = e.message;
      }
      assert.strictEqual(err, 'User agent can not include /');
    });

    it('should reject too long', async () => {
      let err;
      try {
        new Pool({
          chain,
          agent: '*'.repeat(255)
        });
      } catch (e) {
        err = e.message;
      }
      assert.strictEqual(err, 'User agent exceeds maximum length');
    });

    it('should extend user agent with comment', async () => {
      const pool = new Pool({
        chain,
        agent: 'bob-wallet:v0.9.0'
      });

      const peer = pool.createOutbound(
        new NetAddress({
          host: '100.200.0.1',
          port: 10000
        })
      );

      let agent;
      peer.send = (packet) => {
        agent = packet.agent;
      };

      pool.peers.add(peer);

      peer.sendVersion();
      peer.destroy();

      assert.strictEqual(
        agent,
        `/${pkg.name}:${pkg.version}/bob-wallet:v0.9.0/`
      );
    });

    it('should send default user agent', async () => {
      const pool = new Pool({
        chain
      });

      const peer = pool.createOutbound(
        new NetAddress({
          host: '100.200.0.1',
          port: 10000
        })
      );

      let agent;
      peer.send = (packet) => {
        agent = packet.agent;
      };

      pool.peers.add(peer);

      peer.sendVersion();
      peer.destroy();

      assert.strictEqual(
        agent,
        `/${pkg.name}:${pkg.version}/`
      );
    });
  });
});
