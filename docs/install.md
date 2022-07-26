Install `hsd`
=============

`hsd` requires Node.js v12 or higher.

Table of contents
-----------------

<!-- markdown-toc -i install.md -->

<!-- toc -->

- [Verifying keys](#verifying-keys)
- [Building From Source (git and npm)](#building-from-source-git-and-npm)
  * [Verifying](#verifying)
- [npm](#npm)
  * [Verifying](#verifying-1)
- [macOS](#macos)
  * [Verifying](#verifying-2)
- [Docker](#docker)
  * [Building an image](#building-an-image)
  * [Running a container](#running-a-container)
  * [Stopping a container](#stopping-a-container)

<!-- tocstop -->

## Verifying keys
  Every verifying process described below will need project maintainer
keys. You can get keys following [Security](../SECURITY.md) document.


## Building From Source (git and npm)
```
git clone --depth 1 --branch latest https://github.com/handshake-org/hsd.git
cd hsd
npm install --production
# run full node in foreground with default configuration
./bin/hsd
```

Note that `node-gyp` must be installed. See the
[node-gyp](https://github.com/nodejs/node-gyp) documentation for more
information.

### Verifying
  **Note this does not verify dependencies**,
they are downloaded from the `npm`.
  ```
  cd hsd
  git verify-tag latest
  ```
## npm

It is not recommended to install `hsd` from npm's repositories
but it is still possible to install with `npm` using a remote
`git` repository.

```
$ npm install -g https://github.com/handshake-org/hsd.git
```

A `git` ref can be used to install a particular version by appending
a `#` and the name of the `git` ref to the URL. For example,
`https://github.com/handshake-org/hsd.git#latest`. It is recommended
to use the [latest tagged release](https://github.com/handshake-org/hsd/releases).

If adding `hsd` as a dependency to a project, use the command:

```
$ npm install --save https://github.com/handshake-org/hsd.git
```

### Verifying
  Not supported.

## macOS

`hsd` is available via [Homebrew](https://formulae.brew.sh/formula/hsd). This
will install all required dependencies as well as `unbound`.

```
$ brew install hsd
```

### Verifying
  Not supported.

## Docker
### Building an image

To build a Docker image with the name `hsd:<version>-<commit>`, run:

```bash
$ VERSION=$(cat package.json | grep version | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
$ COMMIT=$(git rev-parse --short HEAD)
$ docker build -t hsd:$VERSION-$COMMIT .
```

### GitHub Hosted images

Baked images are available [here](https://github.com/handshake-org/hsd/pkgs/container/hsd).
```
docker pull ghcr.io/handshake-org/hsd:latest
```

### Running a container

To start a container named `hsd` on `main` network with an exposed
node API server, run:

```bash
$ docker run --name hsd \
    --publish 12037:12037 \
    --volume $HOME/.hsd:/root/.hsd \
    hsd:$VERSION-$COMMIT \
    --http-host 0.0.0.0 \
    --api-key=foo
```

To test connectivity, curl the info endpoint:
```bash
$ curl http://x:foo@localhost:12037/
```

> Note: by default, none of the container's ports are exposed. Depending
on the network used for your node, you will need to expose the correct ports
for the node's various services (node http api, wallet http api, recursive
name server, authoritative name server, p2p protocol, encrypted p2p protocol).
The default ports can be found [here](https://hsd-dev.org/api-docs/#introduction). The DNS
servers must also expose a UDP port. The syntax is different from TCP and can
be found [here](https://docs.docker.com/config/containers/container-networking/#published-ports).

### Stopping a container

To stop a container named `hsd`, run:

```bash
$ docker stop hsd
```

