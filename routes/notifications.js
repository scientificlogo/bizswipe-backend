'use strict';

const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { db }         = require('../config/firebase');
const { notifyUser } = require('../utils/pushNotification');
const {
  savePushToken:     tokenSchema,
  sendNotification:  sendSchema,
  relayNotification: relaySchema,
} = require('../schemas');

// ── Relay templates ───────────────────────────────────────────────────────────
// The caller chooses a template, never a title or body, so this route cannot
// be used to put arbitrary text in front of another user.
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

const TEMPLATES = {
  interest: (senderName) => ({
    title: 'New Interest!',
    body:  `${senderName} is interested in your business`,
  }),
  match: (senderName) => ({
    title: "It's a Match!",
    body:  `${senderName} accepted your interest. Start chatting now!`,
  }),
  message: (senderName, preview) => ({
    title: senderName,
    body:  oneLine(preview) || 'Sent you a message',
  }),
};

module.exports = async (fastify) => {

  // ── Save push token ────────────────────────────────────────────────────────
  fastify.post('/token', {
    preHandler: verifyToken,
    schema:     tokenSchema,
    config:     { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }   = req.user;
    const { token } = req.body;

    await db.collection('users').doc(uid).update({
      pushToken:          token,
      pushTokenUpdatedAt: new Date().toISOString(),
    });

    req.log.info({ userId: uid, requestId: req.id }, 'Push token saved');

    return reply.send({ success: true });
  });

  // ── Relay a templated notification to a counterparty ───────────────────────
  // Replaces the app reading another user's pushToken straight out of
  // Firestore. The server checks the two users are genuinely related before
  // sending, and owns the wording, so no user can harvest tokens or spam.
  fastify.post('/relay', {
    preHandler: verifyToken,
    schema:     relaySchema,
    config:     { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid } = req.user;
    const { toUserId, type, matchId, listingId, preview } = req.body;

    if (toUserId === uid) {
      return reply.code(400).send({
        success:   false,
        error:     'Cannot notify yourself',
        requestId: req.id,
      });
    }

    let related = false;

    if (type === 'interest') {
      // Caller must have registered an interest in this seller's listing.
      let q = db.collection('interests')
        .where('buyerId',  '==', uid)
        .where('sellerId', '==', toUserId);
      if (listingId) q = q.where('listingId', '==', listingId);

      related = !(await q.limit(1).get()).empty;

    } else if (type === 'match' || type === 'message') {
      // Both users must be the two parties on the match.
      if (!matchId) {
        return reply.code(400).send({
          success:   false,
          error:     'matchId is required for this notification type',
          requestId: req.id,
        });
      }

      const matchDoc = await db.collection('matches').doc(matchId).get();

      if (matchDoc.exists) {
        const { buyerId, sellerId } = matchDoc.data();
        const parties = [buyerId, sellerId];
        related = parties.includes(uid) && parties.includes(toUserId);
      }
    }

    if (!related) {
      req.log.warn({ uid, toUserId, type, requestId: req.id }, 'Unrelated notification relay blocked');

      return reply.code(403).send({
        success:   false,
        error:     'You are not connected to this user',
        code:      'NOT_RELATED',
        requestId: req.id,
      });
    }

    const senderDoc  = await db.collection('users').doc(uid).get();
    const senderName = oneLine(senderDoc.data()?.name) || 'A BizSwipe user';

    const { title, body } = TEMPLATES[type](senderName, preview);

    await notifyUser(db, toUserId, title, body, { type, matchId, listingId });

    req.log.info({ uid, toUserId, type, requestId: req.id }, 'Notification relayed');

    return reply.send({ success: true });
  });

  // ── Send notification (ADMIN ONLY) ─────────────────────────────────────────
  // This route sends an arbitrary title and body to any user. Behind plain
  // verifyToken it let any logged-in user push-spam any other user they could
  // guess the uid of — a phishing vector ("verify your PAN at ..."). It is
  // admin-only, schema-validated and audit-logged.
  fastify.post('/send', {
    preHandler: verifyAdmin,
    schema:     sendSchema,
    config:     { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { userId, title, body, data } = req.body;

    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'User not found',
        requestId: req.id,
      });
    }

    if (!userDoc.data()?.pushToken) {
      return reply.send({ success: false, message: 'No push token for user' });
    }

    await notifyUser(db, userId, title, body, data || {});

    req.log.info({
      adminId:   req.user.uid,
      userId,
      title,
      requestId: req.id,
    }, 'Admin push notification sent');

    return reply.send({ success: true });
  });
};
