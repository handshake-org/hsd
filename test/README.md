# test

The `test` directory contains packages that correspond to
packages found in the `lib` directory. This directory
structure helps to keep tests scoped well and organized.
There is also an `integration` directory specifically for
integration tests. The test files themselves have suffixes
that correspond to their type of test. The different
types include `unit`, `integration` and `e2e`. This was
chosen because the testing framework `bmocha` can `grep`
on filename. For more documentation on `bmocha`, see
[here](https://github.com/bcoin-org/bmocha).

## Usage

The tests are divided by type to allow isolated runs.

To run all tests:
```bash
$ npm run test
```

To run all tests with the `bcrypto` JavaScript backend:
```bash
$ npm run test-js
```

To run all tests in the default headless browser
```bash
$ npm run test-browser
```

To run the unit tests:
```bash
$ npm run test-unit
```

To run integration tests:
```bash
$ npm run test-integration
```

To run a specific test file:
```bash
$ npm run test-file <absolute path to file>
```

## Contributing

More tests are always useful for a cryptocurrency project.
If you are adding any functionality to `hsd`, please
be sure to add tests and follow the format that we have
adopted.
