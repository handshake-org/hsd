/*!
 * key.js - dnssec key for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const {Record} = require('bns').wire;

exports.priv = Buffer.from(''
  + 'MIIEpQIBAAKCAQEAsF965ZdEncXuSbwxhD0BV3LnhUkRPw85Ws+LTokucKfBaR6G'
  + 'GOV2qc/CyfBI3ZBmM0TpJthzSKVZWeddeVxcjMAZ+qUIw4U7NkPGXALiDVUQItx/'
  + 'ZgcBtiV2hmFfVpArQodMUxveKzMLzj8VbWpGTu2myzyCTQ1MIKddoee85S4QbfjM'
  + 'bM1nR00ML6bBqUhOpOKxfi+V4ycjjeafINV4XCIbacD7bp2AJuNrn2qAzixP5xge'
  + 'oTS1WQAUWbfOjLRzG+/Dr/cMx0eLuYf1Vs7OsFZittzdBoMv3xBS0KSUkwM0Y1ST'
  + 'TrHf9xyOqaUCIwD7ksiFHiZUPoq77S9hDvSIbwIDAQABAoIBAATpU8HK+ZUvKtiQ'
  + 'zgwxqrTltT7H7xwDb4Rw3R89wLZQZZloyTEuSqSl7XW0JENPPxlUZO24/1TZjehs'
  + 'AfVcNhORUefh6qGPNzvmnUJ4rhTS9pUR8NZFga2x02AgnAgMEbhTjjOORhyL2ltO'
  + '9GjMmdKe2ZM1RyegJCuQnZHhoyf6mYXB2r7dA09OnwZdBEa/O1DhBuAmTVre+OZk'
  + '10Rex4wTGhxzfWUASxfQfhC5cr9cR1R+Km6kOf9RX3BEDNArpQHV2d1x9FyekOzw'
  + 'BH1zuhgheSdzuAGR7rXQvLIMCSZ/0LvdSrUJiY0Zh1tkvhdUW4hZqs+Gz4Ul7QF1'
  + 'JGcSZXkCgYEA6Tl8llu5jiN0U2+XPFvfGrXPqSvhS3RHvlo94eRzNRZ0cQskLHIt'
  + '3jLHrCBI2VykGF35aVSqTbumv4cnsFlmQZVl/OmMLI44ugnWy005o3ySOqF3FsA0'
  + 'l8SQD0vIJk1UTTu9obAqV72Kbt9sx6fSeuR6xckSNlYgcWDljtHeUasCgYEAwZi6'
  + 'bBydJvJ61PKNrXQyEP15d4i1CnGh2OBfbGiQSMNpvzFcKfR79qn2K+XhV6eIrmE2'
  + 'bM3rzjgE66rv6fzQn5LDDN7ZuCoPBfAV9hH3/Dr7GqC1GvWoeG/deWobPuzBGxnW'
  + '1B2VVjKvqG18DZVZlgsjFN9NM6f3hogPNNI56E0CgYEAkwXcVmToaoRLNrXoHvLD'
  + 'iHEIwdqZohlhiMwWqqp7PgIz0Xd2jFZGOAbG/Ok1Q2E1SO8k5ZOr8GjVS3QGPxN8'
  + 'dOebbX5FEWlutUiykWLTbQ6AmFllW4A7J1mQfzQErrCc7js05hLJ/pnMBOzwBET1'
  + 'WOdjxf9lbb+JoC+3RvtiLRUCgYEApYEG5oPzyacEYWZWvpGWd7XqkMkbVKleXsU6'
  + 'brhZmQsOLThqfSeYjoAwhsjIw6HjFIjg+VV1oN99PWfuIJBUXgcenrMpV+sE2uOs'
  + 'Mqib41Mc9l+rVDftZcDkivauAjZuw9dsM/xyfbVpPEkVA5vJcZ9lx2M7YczXrHhG'
  + '37ZVcQUCgYEAqgVrQ5CfInj9MZSxTUVWjwL9imrgRQEX77y6hlCkblUH3ubpk91m'
  + 'HdX400I6Xo5nIp9IZobGPLGTyUHojmFAeFAHNSltduMwRb41dyjXNwG2s5v5uY9T'
  + 'E2dDJc22xqmzRb9nc2e8xZhFmRcweHWOK+isiqK/6quK77WfO9JHykU=',
  'base64'
);

// . 172800 IN DS 28834 8 2
// 305fadd310e0e468faa92d65d3d0c0fe1ff740f86f2b203bd46986bdf25582d5
exports.pub = Record.fromJSON({
  name: '.',
  ttl: 172800,
  class: 'INET',
  type: 'DNSKEY',
  data: {
    flags: 257,
    protocol: 3,
    algorithm: 8,
    publicKey: ''
      + 'AwEAAQCwX3rll0Sdxe5JvDGEPQFXcueFSRE/Dzlaz4tOiS5wp8FpHoYY5Xap'
      + 'z8LJ8EjdkGYzROkm2HNIpVlZ5115XFyMwBn6pQjDhTs2Q8ZcAuINVRAi3H9m'
      + 'BwG2JXaGYV9WkCtCh0xTG94rMwvOPxVtakZO7abLPIJNDUwgp12h57zlLhBt'
      + '+MxszWdHTQwvpsGpSE6k4rF+L5XjJyON5p8g1XhcIhtpwPtunYAm42ufaoDO'
      + 'LE/nGB6hNLVZABRZt86MtHMb78Ov9wzHR4u5h/VWzs6wVmK23N0Ggy/fEFLQ'
      + 'pJSTAzRjVJNOsd/3HI6ppQIjAPuSyIUeJlQ+irvtL2EO9Ihv'
  }
});
