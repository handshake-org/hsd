'use strict';

const Path = require('path');
const webpack = require('webpack');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const str = JSON.stringify;
const env = process.env;

module.exports = {
  target: 'web',
  entry: {
    'hsd': './lib/hsd',
    'hsd-worker': './lib/workers/worker'
  },
  output: {
    library: 'hsd',
    libraryTarget: 'umd',
    path: Path.join(__dirname, 'browser'),
    filename: '[name].js'
  },
  resolve: {
    modules: ['node_modules'],
    extensions: ['-browser.js', '.js', '.json']
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.HSD_NETWORK':
        str(env.HSD_NETWORK || 'main'),
      'process.env.HSD_WORKER_FILE':
        str(env.HSD_WORKER_FILE || '/hsd-worker.js')
    }),
    new UglifyJsPlugin()
  ]
};
