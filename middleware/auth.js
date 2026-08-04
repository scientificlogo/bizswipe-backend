'use strict';

const { auth, db }          = require('../config/firebase');
const cache                 = require('../utils/cache');
const { AuthError, ForbiddenError, TokenExpiredError } = require('../utils/errors');

// ── Ban check ─────────────────────────────────────────────────────────────────
// admin.js sets banned:true on the user document, but nothing used to read it,
// so a banned user carried on swiping and messaging normally.
//
// Checked on every authenticated request, so the result is cached for 5
// minutes to keep this from becoming a Firestore read per request. A ban
// therefore takes effect within 5 minutes; banUser clears the key so in
// practice it is immediate.
const BAN_CACHE_TTL = 5 * 60;

const isBanned = async (uid) => {
  try {
    const key = `banned:${uid}`;

    // Stored as strings, not 0/1 — cache.get() returns `data || null`, so a
    // falsy cached value would look like a miss and re-read Firestore on
    // every request, which is the common case.
    const cached = await cache.get(key);
    if (cached === 'yes') return true;
    if (cached === 'no')  return false;

    const snap   = await db.collection('users').doc(uid).get();
    const banned = snap.exists && snap.data()?.banned === true;

    await cache.set(key, banned ? 'yes' : 'no', BAN_CACHE_TTL);
    return banned;
  } catch (err) {
    // Fail open — a Firestore or Redis hiccup must not lock every user out.
    console.error('Ban check failed, allowing request:', err.message);
    return false;
  }
};

// ── Verify Firebase JWT Token ─────────────────────────────────────────────────
const verifyToken = async (req, reply) => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({
        success:   false,
        error:     'Authorization header required (Bearer token)',
        code:      'AUTH_REQUIRED',
        requestId: req.id,
      });
    }

    const token = header.split('Bearer ')[1];

    if (!token || token.length < 10) {
      return reply.code(401).send({
        success:   false,
        error:     'Invalid token format',
        code:      'INVALID_TOKEN',
        requestId: req.id,
      });
    }

    const decoded = await auth.verifyIdToken(token);

    if (await isBanned(decoded.uid)) {
      req.log.warn({ uid: decoded.uid, requestId: req.id, route: req.url }, 'Banned user blocked');

      return reply.code(403).send({
        success:   false,
        error:     'Your account has been suspended. Contact support.',
        code:      'ACCOUNT_BANNED',
        requestId: req.id,
      });
    }

    req.user = {
      uid:   decoded.uid,
      phone: decoded.phone_number || null,
    };

    req.log.info({ uid: decoded.uid, requestId: req.id }, 'Token verified');

  } catch (err) {
    req.log.warn({
      error:     err.message,
      code:      err.code,
      requestId: req.id,
    }, 'Token verification failed');

    const isExpired = err.code === 'auth/id-token-expired';

    return reply.code(401).send({
      success:   false,
      error:     isExpired ? 'Token expired — please refresh and retry' : 'Invalid or expired token',
      code:      isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      requestId: req.id,
    });
  }
};

// ── Admin-only middleware ─────────────────────────────────────────────────────
const verifyAdmin = async (req, reply) => {
  await verifyToken(req, reply);
  if (reply.sent) return; // verifyToken already replied with error

  const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').filter(Boolean);

  if (!ADMIN_UIDS.includes(req.user?.uid)) {
    req.log.warn({
      uid:       req.user?.uid,
      requestId: req.id,
      route:     req.url,
    }, 'Admin access denied');

    return reply.code(403).send({
      success:   false,
      error:     'Admin access required',
      code:      'FORBIDDEN',
      requestId: req.id,
    });
  }

  req.log.info({ uid: req.user?.uid, requestId: req.id }, 'Admin access granted');
};

module.exports = { verifyToken, verifyAdmin };
