/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const NameState = require('../lib/covenants/namestate');
const rules = require('../lib/covenants/rules');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  renewalWindow,
  claimPeriod,
  lockupPeriod
} = network.names;

describe('Namestate', function() {
  describe('open auction name', function() {
    const name = 'handshake';
    const nameHash = rules.hashName(name);
    let height = 0;

    const ns = new NameState();
    ns.nameHash = nameHash;
    ns.set(Buffer.from(name, 'ascii'), height);

    // After this height transfers and expirations return different stats
    const auctionLifespan = treeInterval + 1 + biddingPeriod + revealPeriod;

    describe('single auction flow', function() {
      it('should be OPENING', () => {
        while (height < treeInterval + 1) {
          const json = ns.getJSON(height, network);

          assert.strictEqual(json.state, 'OPENING');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'openPeriodStart',
              'openPeriodEnd',
              'blocksUntilBidding',
              'hoursUntilBidding'
            ]
          );
          height++;
        }
      });

      it('should be BIDDING', () => {
        while (height < treeInterval + 1 + biddingPeriod) {
          const json = ns.getJSON(height, network);

          assert.strictEqual(json.state, 'BIDDING');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'bidPeriodStart',
              'bidPeriodEnd',
              'blocksUntilReveal',
              'hoursUntilReveal'
            ]
          );
          height++;
        }
      });

      it('should be REVEALING', () => {
        while (height < treeInterval + 1 + biddingPeriod + revealPeriod) {
          const json = ns.getJSON(height, network);

          assert.strictEqual(json.state, 'REVEAL');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'revealPeriodStart',
              'revealPeriodEnd',
              'blocksUntilClose',
              'hoursUntilClose'
            ]
          );
          height++;
        }
      });

      it('should be CLOSED without owner', () => {
        const json = ns.getJSON(height, network);

        assert.strictEqual(json.state, 'CLOSED');
        assert(json.stats === null);
      });
    });

    describe('post-auction states', function() {
      it('should be CLOSED until expiration with owner', () => {
        // Start right after auction is over
        let heightWithOwner = auctionLifespan;

        // Someone won the name
        ns.owner.hash = Buffer.alloc(32, 0x01);
        ns.owner.index = 0;

        while (heightWithOwner < renewalWindow) {
          const json = ns.getJSON(heightWithOwner, network);

          assert.strictEqual(json.state, 'CLOSED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'renewalPeriodStart',
              'renewalPeriodEnd',
              'blocksUntilExpire',
              'daysUntilExpire'
            ]
          );
          heightWithOwner++;
        }

        // Expired without renewal
        while (heightWithOwner < renewalWindow + 10) {
          const json = ns.getJSON(heightWithOwner, network);

          assert.strictEqual(json.state, 'CLOSED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'blocksSinceExpired'
            ]
          );
          heightWithOwner++;
        }
      });

      it('should be CLOSED with transfer statistics', () => {
        // Start right after auction is over
        let heightWithTransfer = auctionLifespan;

        // Someone won the name
        ns.owner.hash = Buffer.alloc(32, 0x01);
        ns.owner.index = 0;

        // Winner confirmed a TRANSFER
        ns.transfer = heightWithTransfer;

        while (heightWithTransfer < renewalWindow) {
          const json = ns.getJSON(heightWithTransfer, network);

          assert.strictEqual(json.state, 'CLOSED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'renewalPeriodStart',
              'renewalPeriodEnd',
              'blocksUntilExpire',
              'daysUntilExpire',
              'transferLockupStart',
              'transferLockupEnd',
              'blocksUntilValidFinalize',
              'hoursUntilValidFinalize'
            ]
          );

          heightWithTransfer++;
        }

        // Expired before FINALIZE (which resets everything)
        while (heightWithTransfer < renewalWindow + 10) {
          const json = ns.getJSON(heightWithTransfer, network);

          assert.strictEqual(json.state, 'CLOSED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'blocksSinceExpired'
            ]
          );
          heightWithTransfer++;
        }
      });

      it('should be REVOKED', () => {
        // Start right after auction is over
        let heightWithRevoke = auctionLifespan;

        // Someone won the name
        ns.owner.hash = Buffer.alloc(32, 0x01);
        ns.owner.index = 0;

        // Winner confirmed a TRANSFER
        ns.transfer = heightWithRevoke;

        while (heightWithRevoke < height + 10) {
          const json = ns.getJSON(heightWithRevoke, network);

          assert.strictEqual(json.state, 'CLOSED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'renewalPeriodStart',
              'renewalPeriodEnd',
              'blocksUntilExpire',
              'daysUntilExpire',
              'transferLockupStart',
              'transferLockupEnd',
              'blocksUntilValidFinalize',
              'hoursUntilValidFinalize'
            ]
          );
          heightWithRevoke++;
        }

        // Winner REVOKEd before FINALIZE
        ns.transfer = 0;
        ns.revoked = heightWithRevoke;
        const revokedHeight = heightWithRevoke;

        // Revoked stats remain until re-opened
        while (heightWithRevoke < revokedHeight + renewalWindow) {
          const json = ns.getJSON(heightWithRevoke, network);

          assert.strictEqual(json.state, 'REVOKED');

          const stats = Object.keys(json.stats);
          assert.deepStrictEqual(
            stats,
            [
              'revokePeriodStart',
              'revokePeriodEnd',
              'blocksUntilReopen',
              'hoursUntilReopen'
            ]
          );
          heightWithRevoke++;
        }
      });
    });
  });

  describe('reserved name', function() {
    const name = 'handshake';
    const nameHash = rules.hashName(name);
    let height = 1; // ns.claimed can not be 0

    const ns = new NameState();
    ns.nameHash = nameHash;
    ns.set(Buffer.from(name, 'ascii'), height);
    // Someone claimed the name
    ns.owner.hash = Buffer.alloc(32, 0x01);
    ns.owner.index = 0;
    ns.claimed = height;

    it('should be LOCKED', () => {
      while (height - 1 < lockupPeriod) {
        const json = ns.getJSON(height, network);

        assert.strictEqual(json.state, 'LOCKED');

        const stats = Object.keys(json.stats);
        assert.deepStrictEqual(
          stats,
          [
            'lockupPeriodStart',
            'lockupPeriodEnd',
            'blocksUntilClosed',
            'hoursUntilClosed'
          ]
        );
        height++;
      }
    });

    it('should be CLOSED', () => {
      while (height < claimPeriod) {
        const json = ns.getJSON(height, network);

        assert.strictEqual(json.state, 'CLOSED');

        const stats = Object.keys(json.stats);
        assert.deepStrictEqual(
          stats,
          [
            'renewalPeriodStart',
            'renewalPeriodEnd',
            'blocksUntilExpire',
            'daysUntilExpire'
          ]
        );
        height++;
      }
    });

    it('should be CLOSED and expired', () => {
      // Expired without renewal
      while (height < claimPeriod + 10) {
        const json = ns.getJSON(height, network);

        assert.strictEqual(json.state, 'CLOSED');

        const stats = Object.keys(json.stats);
        assert.deepStrictEqual(
          stats,
          [
            'blocksSinceExpired'
          ]
        );
        height++;
      }
    });
  });
});
