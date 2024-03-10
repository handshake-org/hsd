/*!
 * wsclient.js - WS Client for Node and Wallet.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

/** @typedef {import('bcurl').Client} Client */
/** @typedef {import('bsock').Socket} Socket */

/**
 * Websocket Client
 * @alias module:client.WSClient
 */

class WSClient {
  /** @type {Client} */
  client;

  /** @type {Socket} */
  socket;

  /**
   * @param {Client} client
   */

  constructor(client) {
    this.client = client;
    this.socket = client.socket;
  }

  /**
   * @returns {Boolean}
   */

  get opened() {
    return this.client.opened;
  }

  /**
   * Open websocket.
   * @returns {Promise}
   */

  async open() {
    return this.client.open();
  }

  /**
   * Close websocket.
   * @returns {Promise}
   */

  async close() {
    return this.client.close();
  }

  /**
   * Alias for hook.
   * @param {String} event
   * @param {Function} handler
   */

  hook(event, handler) {
    return this.client.hook(event, handler);
  }

  /**
   * Alias for unhook.
   * @param {String} event
   * @param {Function} handler
   */

  unhook(event, handler) {
    return this.client.unhook(event, handler);
  }

  /**
   * Alias call.
   * @param {String} event
   * @param {...*} args
   * @returns {Promise}
   */

  async call(event, ...args) {
    return this.client.call(event, ...args);
  }

  /**
   * Add an event listener.
   * @param {String} event
   * @param {Function} handler
   */

  bind(event, handler) {
    return this.socket.bind(event, handler);
  }

  /**
   * Remove an event listener.
   * @param {String} event
   * @param {Function} handler
   */

  unbind(event, handler) {
    return this.socket.unbind(event, handler);
  }

  /**
   * Fire an event.
   * @param {String} event
   * @param {...*} args
   */

  fire(event, ...args) {
    return this.socket.fire(event, ...args);
  }
}

/*
 * Expose
 */

module.exports = WSClient;
