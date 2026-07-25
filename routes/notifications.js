'use strict';

const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');
const { savePushToken: tokenSchema } = require('../schemas');

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

  // ── Send notification (admin or internal use) ──────────────────────────────
  fastify.post('/send', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return reply.code(400).send({
        success:   false,
        error:     'userId, title, and body are required',
        requestId: req.id,
      });
    }

    const userDoc   = await db.collection('users').doc(userId).get();
    const pushToken = userDoc.data()?.pushToken;

    if (!pushToken) {
      return reply.send({ success: false, message: 'No push token for user' });
    }

    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ to: pushToken, sound: 'default', title, body, data: data || {}, priority: 'high' }),
    });

    req.log.info({ userId, title, requestId: req.id }, 'Push notification sent');

    return reply.send({ success: true });
  });
};
