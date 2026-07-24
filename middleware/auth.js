const { auth } = require('../config/firebase');
const verifyToken = async (req, reply) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return reply.code(401).send({ success:false, error:'Token required' });
    const decoded = await auth.verifyIdToken(h.split('Bearer ')[1]);
    req.user = { uid: decoded.uid, phone: decoded.phone_number };
  } catch {
    return reply.code(401).send({ success:false, error:'Invalid token' });
  }
};
module.exports = { verifyToken };
