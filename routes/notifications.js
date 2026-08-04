'use strict';

const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { db }         = require('../config/firebase');
const { notifyUser } = require('../utils/pushNotification');
const {
  savePushToken:    tokenSchema,
  sendNotification: sendSchema,
} = require('../schemas');

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
