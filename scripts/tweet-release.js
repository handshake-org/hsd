'use strict';

const https = require('https');
const crypto = require('crypto');

const consumerKey = process.env.TWITTER_CONSUMER_KEY;
const consumerSecret = process.env.TWITTER_CONSUMER_SECRET;
const accessToken = process.env.TWITTER_ACCESS_TOKEN;
const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

async function sendTweet(status) {
  return new Promise((resolve, reject) => {
    const method = 'POST';
    const url = 'https://api.twitter.com/2/tweets';
    const urlObj = new URL(url);

    // OAuth 1.0a parameters
    const oauth = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: accessToken,
      oauth_version: '1.0'
    };

    // Twitter API v2 expects JSON body
    const body = JSON.stringify({ text: status });

    // Collect parameters for signature base string
    const params = {
      ...oauth
      // No body params for signature in v2 endpoint
    };

    // Create parameter string (sorted by key)
    const paramString = Object.keys(params)
      .sort()
      .map(key =>
        `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
      )
      .join('&');

    // Signature base string
    const baseString = [
      method,
      encodeURIComponent(urlObj.origin + urlObj.pathname),
      encodeURIComponent(paramString)
    ].join('&');

    // Signing key
    const signingKey = [
      encodeURIComponent(consumerSecret),
      encodeURIComponent(accessTokenSecret)
    ].join('&');

    // Signature
    const signature = crypto
      .createHmac('sha1', signingKey)
      .update(baseString)
      .digest('base64');

    oauth.oauth_signature = signature;

    // Build Authorization header
    const authHeader =
      'OAuth ' +
      Object.keys(oauth)
        .sort()
        .map(
          key =>
            `${encodeURIComponent(key)}="${encodeURIComponent(oauth[key])}"`
        )
        .join(', ');

    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request((options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          let errMsg = 'Twitter API error: '
           + `${res.statusCode} ${res.statusMessage}`;
          try {
            const errJson = JSON.parse(data);
            errMsg += `\n${JSON.stringify(errJson)}`;
          } catch (e) {
            errMsg += `\n${data}`;
          }
          reject(new Error(errMsg));
        }
      });
    }));

    req.on('error', err => reject(err));
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    console.error('Error: Twitter API credentials are not set.');
    console.error('Please set TWITTER_CONSUMER_KEY, '
      + 'TWITTER_CONSUMER_SECRET, TWITTER_ACCESS_TOKEN, '
      + 'and TWITTER_ACCESS_TOKEN_SECRET environment variables.');
    process.exit(1);
  }

  try {
    let status;
    if (process.argv[2]) {
      status = process.argv[2];
    } else {
      const pkg = require('../package.json');
      const version = pkg.version;
      const releaseUrl = 'https://github.com/handshake-org' +
      `/hsd/releases/tag/v${version}`;
      status = `🚀 New release! hsd v${version} is out now.
Check it out: ${releaseUrl}`;
    }
    await sendTweet(status);
    console.log('Tweet sent successfully!');
  } catch (error) {
    console.error('Error sending tweet:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
