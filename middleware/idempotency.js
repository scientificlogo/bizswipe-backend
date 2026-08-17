'use strict';

const crypto = require('crypto');
const cache  = require('../utils/cache');

// ── Idempotency ───────────────────────────────────────────────────────────────
// Protects non-idempotent POSTs (create listing, accept interest) against
// double-taps, client retries and duplicated network requests.
//
// Key resolution:
//   1. The `Idempotency-Key` header, when the client sends one (preferred —
//      the client controls the retry window).
//   2. Otherwise a fingerprint of uid + method + route + body, so a
//      double-tapping client is protected without any app changes.
//
// Flow:
//   • First request wins the key (SET NX) and proceeds. Its response is
//     recorded so replays can be answered with the identical result.
//   • A replay while the first request is still running gets 409 IN_PROGRESS.
//   • A replay after completion gets the recorded status code and body back,
//     with `X-Idempotent-Replay: true`.
//
// Redis is best-effort everywhere else in this codebase and it is here too:
// if Redis is down we let the request through rather than block writes.

const TTL_SECONDS = 24 * 60 * 60; // how long a completed result is replayable
const LOCK_SECONDS = 60;          // max time a request may hold the key unfinished

const IN_PROGRESS = '__in_progress__';

const fingerprint = (req) => {
  const body = req.body ? JSON.stringify(req.body) : '';
  return crypto
    .createHash('sha256')
    // routeOptions.url, not routerPath — routerPath is deprecated in Fastify 4
    // and removed in 5.
    .update(`${req.user?.uid || 'anon'}|${req.method}|${req.routeOptions?.url || req.url}|${body}`)
    .digest('hex')
    .slice(0, 32);
};

const idempotency = async (req, reply) => {
  // verifyToken runs before this and replies on failure — don't double-handle.
  if (reply.sent) return;

  const header = req.headers['idempotency-key'];

  if (header && (typeof header !== 'string' || header.length > 200)) {
    return reply.code(400).send({
      success:   false,
      error:     'Idempotency-Key must be a string of at most 200 characters',
      code:      'INVALID_IDEMPOTENCY_KEY',
      requestId: req.id,
    });
  }

  const scope = req.user?.uid || req.ip;
  const key   = `idem:${scope}:${header ? crypto.createHash('sha256').update(header).digest('hex').slice(0, 32) : fingerprint(req)}`;

  const won = await cache.setNX(key, IN_PROGRESS, LOCK_SECONDS);

  // Redis unavailable — fail open. A duplicate write is better than an
  // outage, and both protected routes have their own conflict checks.
  if (won === null) {
    req.log.warn({ requestId: req.id }, 'Idempotency check skipped — cache unavailable');
    return;
  }

  if (!won) {
    const stored = await cache.get(key);

    if (stored && stored !== IN_PROGRESS) {
      req.log.info({ uid: req.user?.uid, requestId: req.id }, 'Idempotent replay served from cache');
      reply.header('X-Idempotent-Replay', 'true');
      return reply.code(stored.statusCode || 200).send(stored.payload);
    }

    req.log.info({ uid: req.user?.uid, requestId: req.id }, 'Duplicate request while original in flight');
    return reply.code(409).send({
      success:   false,
      error:     'An identical request is already being processed',
      code:      'REQUEST_IN_PROGRESS',
      requestId: req.id,
    });
  }

  // We own the key. Record the outcome so replays can be answered, and release
  // the key on failure so the client can legitimately retry.
  const originalSend = reply.send.bind(reply);

  reply.send = (payload) => {
    const statusCode = reply.statusCode || 200;

    // Only a completed write is worth replaying. Everything else releases the
    // key so the client can legitimately try again.
    //
    // This used to record any status below 500 for a full day, which turned a
    // transient refusal into a permanent one: the rate limiter's 429 runs
    // through this same reply.send, so a seller who hit "5 listings an hour"
    // had that 429 replayed at them for the next 24 hours every time they
    // submitted the same form. Both protected routes re-check for a duplicate
    // themselves, so releasing the key on an error cannot let a double write
    // through.
    if (statusCode >= 200 && statusCode < 300) {
      cache.set(key, { statusCode, payload }, TTL_SECONDS).catch(() => {});
    } else {
      cache.del(key).catch(() => {});
    }

    return originalSend(payload);
  };
};

module.exports = { idempotency };
