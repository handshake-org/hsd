# HSKD

**HSKD** is an implementation of the [Handshake][handshake] Protocol.

## Install

```
$ git clone git://github.com/handshake-org/hskd.git
$ cd hskd
$ npm install
$ ./bin/hskd
```

See the [Beginner's Guide][guide] for more in-depth installation instructions.

## Documentation

- API Docs: http://handshake.org/docs/
- REST Docs: http://handshake.org/api-docs/index.html
- Docs: [docs/](docs/README.md)

## Testnet

A testnet is currently running as of June 19th.

Current testnet seed nodes (`pubkey@ip`):

- `aoihqqagbhzz6wxg43itefqvmgda4uwtky362p22kbimcyg5fdp54@173.255.248.12`
- `ajdzrpoxsusaw4ixq4ttibxxsuh5fkkduc5qszyboidif2z25i362@66.175.217.103`
- `ajk57wutnhfdzvqwqrgab3wwh4wxoqgnkz4avbln54pgj5jwefcts@45.56.92.136`
- `am2lsmbzzxncaptqjo22jay3mztfwl33bxhkp7icfx7kmi5rvjaic@45.56.82.169`

Current public DNS servers:

- 173.255.248.12 - Recursive Server 1.
- 66.175.217.103 - Authoritative Server 1.
- 45.56.92.136 - Recursive Server 2.
- 45.56.82.169 - Authoritative Server 2.

Example:

``` js
$ dig @173.255.248.12 google.com A +short
172.217.0.46
```

``` js
$ dig @66.175.217.103 com NS
...
;; AUTHORITY SECTION:
com.                    86400   IN      NS      a.gtld-servers.net.
com.                    86400   IN      NS      b.gtld-servers.net.
com.                    86400   IN      NS      c.gtld-servers.net.
...
```

## Support

Join us on [freenode][freenode] in the [#handshake][irc] channel.

## Disclaimer

HSKD does not guarantee you against theft or lost funds due to bugs, mishaps,
or your own incompetence. You and you alone are responsible for securing your
money.

## Contribution and License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## License

- Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).

See LICENSE for more info.

[handshake]: https://handshake.org/
[guide]: https://github.com/handshake-org/hskd/blob/master/docs/Beginner's-Guide.md
[freenode]: https://freenode.net/
[irc]: irc://irc.freenode.net/handshake
[changelog]: https://github.com/handshake-org/hskd/blob/master/CHANGELOG.md
