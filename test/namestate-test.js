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

    it('should be CLOSED until expiration with owner', () => {
      // Fork the timeline;
      let heightWithOwner = height;

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
      // Fork the timeline;
      let heightWithTransfer = height;

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
      // Fork the timeline;
      let heightWithRevoke = height;

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

    it('should be CLOSED until claim period ends', () => {
      // Fork the timeline;
      let heightWithOwner = height;

      while (heightWithOwner < claimPeriod) {
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
      while (heightWithOwner < claimPeriod + 10) {
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
  });
});
