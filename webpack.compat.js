'use strict';

const Path = require('path');
const webpack = require('webpack');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const str = JSON.stringify;
const env = process.env;

module.exports = {
  target: 'web',
  entry: {
    'hskd': './lib/hskd',
    'hskd-worker': './lib/workers/worker'
  },
  output: {
    library: 'hskd',
    libraryTarget: 'umd',
    path: Path.join(__dirname, 'browser'),
    filename: '[name].js'
  },
  resolve: {
    modules: ['node_modules'],
    extensions: ['-compat.js', '-browser.js', '.js', '.json']
  },
  module: {
    rules: [{
      test: /\.js$/,
      loader: 'babel-loader'
    }]
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.HSKD_NETWORK':
        str(env.HSKD_NETWORK || 'main'),
      'process.env.HSKD_WORKER_FILE':
        str(env.HSKD_WORKER_FILE || '/hskd-worker.js')
    }),
    new UglifyJsPlugin()
  ]
};
