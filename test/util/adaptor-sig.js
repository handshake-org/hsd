'use strict';

const secp256k1 = require('bcrypto/lib/js/secp256k1');
const rng = require('crypto');
const HmacDRBG = require('bcrypto/lib/js/hmac-drbg');
const blake2b = require('bcrypto/lib/blake2b');
const bio = require('bufio');

/*
* This code uses unaudited experimental cryptography, using this code will likely
* end up with you writing crpyto libraries at Oracle.
* References:
* [ADAPTOR-SIG] https://github.com/LLFourn/one-time-VES/blob/master/main.pdf
* [BIP-SCHNORR] https://github.com/sipa/bips/blob/d194620/bip-schnorr.mediawiki
* [BCRYPTO-ECDSA] https://github.com/bcoin-org/bcrypto/blob/master/lib/js/ecdsa.js
*/
class Adaptor {
   generateTweakPoint() {
    // This is effectively a private and public key pair
    const G = secp256k1.curve.g;
    const t = secp256k1.curve.randomScalar(rng);
    const T = G.mulBlind(t);
    return [t, T];
  }

  signTweaked(msg, key, T) {
    const {
      n
    } = secp256k1.curve;
    const G = secp256k1.curve.g;
    const a = secp256k1.curve.decodeScalar(key);

    if (a.isZero() || a.cmp(n) >= 0)
      throw new Error('Invalid private key.');

    const m = secp256k1._reduce(msg);
    const nonce = secp256k1.curve.encodeScalar(m);
    const drbg = new HmacDRBG(secp256k1.hash, key, nonce);

    for (;;) {
      const bytes = drbg.generate(secp256k1.curve.scalarSize);
      const k = secp256k1._truncate(bytes);

      if (k.isZero() || k.cmp(n) >= 0)
        continue;

      // P = kG
      // Q = ktG = tP

      // note that k must remain secret
      const P = G.mulBlind(k);
      const Q = T.mulBlind(k);

      if (Q.isInfinity())
        continue;

      const q = Q.getX().mod(n);

      if (q.isZero())
        continue;

      // The code would usually look like this:

      // const k_inverse = k.fermat(n);
      // const s_numerator = q.mul(a).add(m).mod(n);
      // const s_tweaked = s_numerator.mul(k_inverse).mod(n);

      // but to protect from side channel attacks,
      // we'll use a random integer to mess with timings

      const b = secp256k1.curve.randomScalar(rng);
      const kb_inverse = k.mul(b).fermat(n);
      const bm = m.mul(b).mod(n);
      const ba = a.mul(b).mod(n);
      const s_numerator = q.mul(ba).add(bm).mod(n);
      const s_tweaked = s_numerator.mul(kb_inverse).mod(n);

      const proof = this.generateDLEQ(P, Q, T, k);
      return [P, Q, s_tweaked, proof];
    }
  }

  generateDLEQ(P, Q, T, k) {
    const { n } = secp256k1.curve;
    const G = secp256k1.curve.g;

    const p = P.getX().mod(n);
    const q = Q.getX().mod(n);

    for(;;) {
      // DLEQ proof
      // It is important r2 stays secret, can probably be deteminstic,
      // don't wanna mess with determinstic stuff rn though
      // Will need extra protections against side channel attacks if deteministic
      // it is also important r2 is not reused since a implementaion like this
      // will leak k (which will leak to private key leakage)

      const r2 = secp256k1.curve.randomScalar(rng);
      const G_r2 = G.mulBlind(r2);
      const T_r2 = T.mulBlind(r2);

      if (G_r2.isInfinity() || T_r2.isInfinity())
        continue;

      const dp = G_r2.getX();
      const dq = T_r2.getX();

      if (dp.isZero() || dq.isZero())
        continue;

      const arr = [p.toBuffer(), q.toBuffer(), dp.toBuffer(), dq.toBuffer()];
      const hash = blake2b.digest(Buffer.concat(arr));
      const e = secp256k1._truncate(hash).mod(n);
      // random oracle
      if (e.isZero() || e.cmp(n) >= 0)
          continue;

      const ke = k.mul(e).mod(n);
      const pi = r2.add(ke).mod(n);

      // if r2 is leaked, pi can be used to calculate k
      // as k = (pi - r2)/e
      // which would leak the private key

      return {
          dp,
          dq,
          pi
      };
    }
  }

  verifyDLEQ(P, Q, T, proof) {
      const {p, n} = secp256k1.curve;
      const G = secp256k1.curve.g;

      const {dp, dq, pi} = proof;
      // DLEQ proofs are basically schnorr signatures
      // BIP schnorr
      if(dp.isZero() || dp.cmp(p) >= 0)
        return false;

      if(dq.isZero() || dq.cmp(p) >= 0)
        return false;

      const P_point = P.getX().mod(n);
      const Q_point = Q.getX().mod(n);
      // Oracle
      // This can probably be imporved but works well enough for a PoC
      const arr = [P_point.toBuffer(), Q_point.toBuffer(), dp.toBuffer(), dq.toBuffer()];
      const hash = blake2b.digest(Buffer.concat(arr));
      const e = secp256k1._truncate(hash);

      // e really shouldn't be zero but just in case
      if (e.isZero() || e.cmp(n) >= 0)
          return false;

      const e_negative = e.neg().mod(n);
      // P = kG
      // Q = ktG = kT
      // pi = r2 + ke
      // r2*G = pi*G - e*P
      // r2*T = pi*T - e*Q
      // Since e depends on r2G and r2T
      // one cannot just select a e and pass the corresponding
      // points as proof.

      const G_r2 = G.mulAdd(pi, P, e_negative);
      const T_r2 = T.mulAdd(pi, Q, e_negative);

      if(G_r2.isInfinity() || T_r2.isInfinity())
        return false;

      return G_r2.eqR(dp) && T_r2.eqR(dq);
  }

  verifyTweakedSignature(msg, P, Q, se, proof, T, pubKey) {
      const {n} = secp256k1.curve;
      const G = secp256k1.curve.g;
      const m = secp256k1._reduce(msg);
      const A = secp256k1.curve.decodePoint(pubKey);

      const p = P.getX().mod(n);
      const q = Q.getX().mod(n);

      if (p.isZero() || p.cmp(n) >= 0)
        return false;
      if (q.isZero() || q.cmp(n) >= 0)
        return false;
      if (se.isZero() || se.cmp(n) >= 0)
        return false;

      if(!this.verifyDLEQ(P, Q, T, proof))
        return false;

      const si = se.invert(n);

      const u1 = m.mul(si).mod(n);
      const u2 = q.mul(si).mod(n);

      // Shamir's trick
      const R = G.mulAdd(u1, A, u2);
      return R.eqR(p);
  }

  untweakSignature(Q, se, t) {
      const { n , nh } = secp256k1.curve;
      const t_inverse = t.fermat(n);
      // s = se / t
      const s = se.mul(t_inverse).mod(n);
      const r = Q.getX().mod(n);

      // BIP 66, return LOW_S
      if (s.cmp(nh) > 0) {
        s.ineg().imod(n);
      }

      return [r, s];
  }

  extractTweakPoint(s, se) {
      // s = se / t
      const { n } = secp256k1.curve;
      const s_inverse = s.invert(n);
      const t = se.mul(s_inverse).mod(n);
      const T = secp256k1.curve.g.mul(t);
      return [t, T];
  }

  // Helper

  untweakCompact(Q, se, t, type) {
    const [r, s] = this.untweakSignature(Q, se, t);
    const sig = secp256k1._encodeCompact(r, s);
    const bw = bio.write(65);
    bw.writeBytes(sig);
    bw.writeU8(type);
    return bw.render();
  }
}

module.exports = new Adaptor();

// Example usage

// const adaptor = new Adaptor();

// const msg = Buffer.from("deadbeef", 'hex')
// const key = secp256k1.privateKeyGenerate();
// const pubKey = secp256k1.publicKeyCreate(key);

// // You can literally use a pub/private key for this
// [t, T] = adaptor.generateTweakPoint();

// [P, Q, se, proof] = adaptor.signTweaked(msg, key, T);

// console.log(adaptor.verifyTweakedSignature(msg, P, Q, se, proof, T, pubKey));

// const [r, s] = adaptor.untweakSignature(Q, se, t);

// [t_extracted, T_extracted] = adaptor.extractTweakPoint(s, se);

// // t_extracted may not be equal to orignal t (it might be equal to -t mod n),
// // but it doesn't matter for untweaking (but it matters for obtaining the orignal point T)

// console.log(secp256k1._verify(msg, r, s, pubKey));
