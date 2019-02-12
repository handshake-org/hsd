'use strict';

const assert = require('bsert');
const bio = require('bufio');

const Address = require('../primitives/address');
const {opcodes} = require('../script/common');
const rules = require('../covenants/rules');
const Script = require('../script/script');

class Account extends bio.Struct {
  /**
   * Create an account.
   * @constructor
   * @param {Object} options
   */

  constructor() {
    super();
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Options are required.');

    this.name = options.name;

    this.conditions = {};
    this.policies = {};
    this.keys = {};

    for (const condition in options.conditions) {
      assert(condition in rules.types);

      const policy = options.conditions[condition];
      this.conditions[condition] = policy;

      if (policy in this.policies) {
        continue;
      }
      assert(policy in options.policies);
      this.policies[policy] = options.policies[policy];
    }
    assert(rules.typesByVal[rules.types.NONE] in this.conditions);

    for (const policy in this.policies) {
      for (const key of this.policies[policy].keys) {
        if (key in this.keys) {
          continue;
        }
        this.keys[key] = Buffer.from(options.keys[key], 'hex');
      }
    }

    return this;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Get the redeem script.
   * @private
   * @param {Number} depth - depth nonce
   * @returns {Script}
   */

  getScript(depth) {
    const script = new Script();

    for (const covenant in rules.types) {
      script.pushSmall(rules.types[covenant]);
      script.pushOp(opcodes.OP_TYPE);
      script.pushOp(opcodes.OP_EQUAL);
      script.pushOp(opcodes.OP_IF);

      let policy;
      if (covenant in this.conditions) {
        policy = this.policies[this.conditions[covenant]];
      } else {
        policy = this.policies[this.conditions[rules.types.NONE]];
      }

      script.pushSmall(policy.m);
      for (const key of policy.keys) {
        script.pushData(this.keys[key]);
      }
      script.pushSmall(policy.n);
      script.pushOp(opcodes.OP_CHECKMULTISIG);

      script.pushOp(opcodes.OP_ENDIF);
    }

    return script;
  }

  getAddress(depth) {
    const script = this.getScript(depth);
    return Address.fromScript(script);
  }

  /**
   * Serialize the account.
   * @returns {Buffer}
   */

  write(bw) {
    // TODO(sidd)
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {Object}
   */

  read(br) {
    // TODO(sidd)
  }
}

module.exports = Account;
