'use strict';

const rc = require('bslintrc');

module.exports = [
  rc.configs.recommended,
  rc.configs.bcoin,
  {
    languageOptions: {
      globals: {
        ...rc.globals.node
      },
      ecmaVersion: 'latest'
    }
  },
  {
    files: [
      'bin/cli',
      'bin/hsd',
      'bin/node',
      'bin/hs-seeder',
      'bin/node',
      'bin/_seeder',
      'bin/spvnode',
      'bin/wallet',
      'bin/hsd-cli',
      'bin/hsw-cli',
      'etc/genesis',
      '**/*.js',
      '*.js'
    ],
    languageOptions: {
      sourceType: 'commonjs'
    }
  },
  {
    files: ['test/{,**/}*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        ...rc.globals.mocha,
        register: 'readable'
      }
    },
    rules: {
      'max-len': 'off',
      'prefer-arrow-callback': 'off',
      'no-return-assign': 'off'
    }
  }
];
