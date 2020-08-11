# Contributing to Handshake

## Code style

This repository includes a file [.eslintrc.json](.eslintrc.json) which sets
linting preferences for the project. The continuous integration bot will
install [bslint](https://www.npmjs.com/package/bslint) which vendors a specific
version of eslint. Before submitting a pull request, please make sure your code
is clean of linting errors. If you choose to use bslint, it can be installed
globally in your development environment:

```
npm install bslint -g
cd hsd            # must be in repository root
npm run lint      # command is defined in package.json
```

## Testing

[bmocha](https://www.npmjs.com/package/bmocha) will be installed as a
"developer dependency" if installed without the `--production` flag. The
complete built-in testing suite can be run with the command:

```
cd hsd
npm run test
```

You can specify a single test file to run with (for example):

```
cd hsd
npm run test-file test/wallet-test.js
```

Before submitting a pull request, please make sure your code changes do not
break any of the existing regression tests or linting rules. We currently use
GitHub Workflows to run the testing suite on all new pull requests.

Recent workflow actions are available:
https://github.com/handshake-org/hsd/actions

All code changes should be covered by new tests if applicable. We currently use
Coveralls to examine test coverage, and a pull request that *decreases* test
coverage will likely not be reviewed by contributors or maintainers.

Current test coverage details are available:
https://coveralls.io/github/handshake-org/hsd

## Commit messages

Whenever possible, commits should prefixed by the module they change. The module
name is generally the folder name in the `lib/` directory in which the changes
occur (subdirectories can usually be ignored). Please see recent
[commits to master branch](https://github.com/handshake-org/hsd/commits/master)
for examples of the preferred pattern.

Additional examples:

```
test: increase timeouts
pkg: update CHANGELOG
wallet: expose importname in RPC
```

Additional commit details are always welcome after the short title. A good
example of this is in
[this commit](https://github.com/handshake-org/hsd/commit/c385fc59d488f5cd592a1d23554fe1c018bf26da).
Note how the author used a very brief commit message as the title but then added
a detailed description in the extended message.



