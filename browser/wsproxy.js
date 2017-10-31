'use strict';

const assert = require('assert');
const net = require('net');
const EventEmitter = require('events');
const bsock = require('bsock');
const digest = require('bcrypto/lib/digest');
const IP = require('../lib/utils/ip');
const BufferWriter = require('../lib/utils/writer');

const TARGET = Buffer.from(
  '0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex');

function WSProxy(options) {
  if (!(this instanceof WSProxy))
    return new WSProxy(options);

  EventEmitter.call(this);

  if (!options)
    options = {};

  this.options = options;
  this.target = options.target || TARGET;
  this.pow = options.pow === true;
  this.ports = new Set();
  this.io = bsock.server();
  this.sockets = new WeakMap();

  if (options.ports) {
    for (const port of options.ports)
      this.ports.add(port);
  }

  this.init();
}

Object.setPrototypeOf(WSProxy.prototype, EventEmitter.prototype);

WSProxy.prototype.init = function init() {
  this.io.on('error', (err) => {
    this.emit('error', err);
  });

  this.io.on('socket', (ws) => {
    this.handleSocket(ws);
  });
};

WSProxy.prototype.handleSocket = function handleSocket(ws) {
  const state = new SocketState(this, ws);

  // Use a weak map to avoid
  // mutating the websocket object.
  this.sockets.set(ws, state);

  ws.fire('info', state.toInfo());

  ws.on('error', (err) => {
    this.emit('error', err);
  });

  ws.listen('tcp connect', (port, host, nonce) => {
    this.handleConnect(ws, port, host, nonce);
  });
};

WSProxy.prototype.handleConnect = function handleConnect(ws, port, host, nonce) {
  const state = this.sockets.get(ws);
  assert(state);

  if (state.socket) {
    this.log('Client is trying to reconnect (%s).', state.host);
    return;
  }

  if ((port & 0xffff) !== port
      || typeof host !== 'string'
      || host.length === 0) {
    this.log('Client gave bad arguments (%s).', state.host);
    ws.fire('tcp close');
    ws.destroy();
    return;
  }

  if (this.pow) {
    if ((nonce >>> 0) !== nonce) {
      this.log('Client did not solve proof of work (%s).', state.host);
      ws.fire('tcp close');
      ws.destroy();
      return;
    }

    const bw = new BufferWriter();
    bw.writeU32(nonce);
    bw.writeBytes(state.snonce);
    bw.writeU32(port);
    bw.writeString(host, 'ascii');

    const pow = bw.render();

    if (digest.hash256(pow).compare(this.target) > 0) {
      this.log('Client did not solve proof of work (%s).', state.host);
      ws.fire('tcp close');
      ws.destroy();
      return;
    }
  }

  let raw, addr;
  try {
    raw = IP.toBuffer(host);
    addr = IP.toString(raw);
  } catch (e) {
    this.log('Client gave a bad host: %s (%s).', host, state.host);
    ws.fire('tcp error', {
      message: 'EHOSTUNREACH',
      code: 'EHOSTUNREACH'
    });
    ws.destroy();
    return;
  }

  if (!IP.isRoutable(raw) || IP.isOnion(raw)) {
    this.log(
      'Client is trying to connect to a bad ip: %s (%s).',
      addr, state.host);
    ws.fire('tcp error', {
      message: 'ENETUNREACH',
      code: 'ENETUNREACH'
    });
    ws.destroy();
    return;
  }

  if (!this.ports.has(port)) {
    this.log('Client is connecting to non-whitelist port (%s).', state.host);
    ws.fire('tcp error', {
      message: 'ENETUNREACH',
      code: 'ENETUNREACH'
    });
    ws.destroy();
    return;
  }

  let socket;
  try {
    socket = state.connect(port, addr);
    this.log('Connecting to %s (%s).', state.remoteHost, state.host);
  } catch (e) {
    this.log(e.message);
    this.log('Closing %s (%s).', state.remoteHost, state.host);
    ws.fire('tcp error', {
      message: 'ENETUNREACH',
      code: 'ENETUNREACH'
    });
    ws.destroy();
    return;
  }

  socket.on('connect', () => {
    ws.fire('tcp connect', socket.remoteAddress, socket.remotePort);
  });

  socket.on('data', (data) => {
    ws.fire('tcp data', data.toString('hex'));
  });

  socket.on('error', (err) => {
    ws.fire('tcp error', {
      message: err.message,
      code: err.code || null
    });
  });

  socket.on('timeout', () => {
    ws.fire('tcp timeout');
  });

  socket.on('close', () => {
    this.log('Closing %s (%s).', state.remoteHost, state.host);
    ws.fire('tcp close');
    ws.destroy();
  });

  ws.listen('tcp data', (data) => {
    if (typeof data !== 'string')
      return;
    socket.write(Buffer.from(data, 'hex'));
  });

  ws.listen('tcp keep alive', (enable, delay) => {
    socket.setKeepAlive(enable, delay);
  });

  ws.listen('tcp no delay', (enable) => {
    socket.setNoDelay(enable);
  });

  ws.listen('tcp set timeout', (timeout) => {
    socket.setTimeout(timeout);
  });

  ws.listen('tcp pause', () => {
    socket.pause();
  });

  ws.listen('tcp resume', () => {
    socket.resume();
  });

  ws.listen('disconnect', () => {
    socket.destroy();
  });
};

WSProxy.prototype.log = function log(...args) {
  process.stdout.write('wsproxy: ');
  console.log(...args);
};

WSProxy.prototype.attach = function attach(server) {
  this.io.attach(server);
};

function SocketState(server, socket) {
  this.pow = server.pow;
  this.target = server.target;
  this.snonce = nonce();
  this.socket = null;
  this.host = IP.normalize(socket.conn.remoteAddress);
  this.remoteHost = null;
}

SocketState.prototype.toInfo = function toInfo() {
  return {
    pow: this.pow,
    target: this.target.toString('hex'),
    snonce: this.snonce.toString('hex')
  };
};

SocketState.prototype.connect = function connect(port, host) {
  this.socket = net.connect(port, host);
  this.remoteHost = IP.toHostname(host, port);
  return this.socket;
};

function nonce() {
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(Math.random() * 0x100000000, 0, true);
  buf.writeUInt32LE(Math.random() * 0x100000000, 4, true);
  return buf;
}

module.exports = WSProxy;