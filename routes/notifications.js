const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');

module.exports = async (fastify) => {

  // Save push token (called when user opens app)
  fastify.post('/token', { preHandler: verifyToken }, async (req, reply) => {
    const { uid }  = req.user;
    const { token } = req.body;

    if (!token) return reply.code(400).send({ success:false, error:'Token required' });

    await db.collection('users').doc(uid).update({
      pushToken:          token,
      pushTokenUpdatedAt: new Date().toISOString(),
    });

    return reply.send({ success:true });
  });

  // Send notification to specific user (internal use)
  fastify.post('/send', { preHandler: verifyToken }, async (req, reply) => {
    const { userId, title, body, data } = req.body;

    const userDoc  = await db.collection('users').doc(userId).get();
    const pushToken = userDoc.data()?.pushToken;

    if (!pushToken) {
      return reply.send({ success:false, message:'No push token for user' });
    }

    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify({ to:pushToken, sound:'default', title, body, data:data||{}, priority:'high' }),
    });

    return reply.send({ success:true });
  });
};
