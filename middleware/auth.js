'use strict';

const { auth }              = require('../config/firebase');
const { AuthError, ForbiddenError, TokenExpiredError } = require('../utils/errors');

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
