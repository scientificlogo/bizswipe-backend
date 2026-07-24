const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');
const { FieldValue }  = require('firebase-admin/firestore');

// ── Server-side Contact Detection ─────────────────────────────────────────────
const WORD_TO_DIGIT = {
  'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5',
  'six':'6','seven':'7','eight':'8','nine':'9',
  'shunya':'0','ek':'1','do':'2','teen':'3','char':'4',
  'paanch':'5','chhe':'6','chheh':'6','saat':'7','aath':'8','nau':'9',
};

const convertWordsToDigits = (text) => {
  let c = text.toLowerCase();
  Object.entries(WORD_TO_DIGIT).forEach(([w,d]) => {
    c = c.replace(new RegExp(`\\b${w}\\b`,'gi'), d);
  });
  return c;
};

const countNumberWords = (text) => {
  let count = 0;
  Object.keys(WORD_TO_DIGIT).forEach(w => {
    const m = text.toLowerCase().match(new RegExp(`\\b${w}\\b`,'gi'));
    if (m) count += m.length;
  });
  return count;
};

const CONTACT_PATTERNS = [
  { pattern:/(\+91[\s\-,]*)?[6-9][\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d/, label:'phone number' },
  { pattern:/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, label:'email address' },
  { pattern:/whatsapp|wtsapp|wa\.me|on wa\b/i, label:'WhatsApp contact' },
  { pattern:/telegram|t\.me\//i, label:'Telegram contact' },
  { pattern:/\bcall me\b|\bping me\b|\bcontact me\b|\breach me\b|\bmy number\b|\bmy email\b|\bpe call\b|\bkaro call\b/i, label:'off-platform contact' },
];

const detectContactInfo = (text) => {
  if (!text) return null;
  if (countNumberWords(text) >= 6) return 'phone number (written in words)';
  const converted = convertWordsToDigits(text);
  for (const { pattern, label } of CONTACT_PATTERNS) {
    if (pattern.test(text) || pattern.test(converted)) return label;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (fastify) => {

  // Send message — server validates contact info before saving
  fastify.post('/send', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const { matchId, text, senderName } = req.body;

    if (!matchId) return reply.code(400).send({ success:false, error:'matchId required' });
    if (!text?.trim()) return reply.code(400).send({ success:false, error:'Message empty' });
    if (text.length > 500) return reply.code(400).send({ success:false, error:'Message too long (max 500)' });

    // ── Server-side contact detection ─────────────────────────────────────
    const detected = detectContactInfo(text.trim());
    if (detected) {
      // Log the attempt
      console.log(`[BLOCKED] User ${uid} tried to send ${detected} in match ${matchId}`);
      // Save flagged message to violations log
      await db.collection('violations').add({
        userId: uid, matchId,
        type: 'contact_info_attempt',
        detected, text: text.trim(),
        createdAt: FieldValue.serverTimestamp(),
      });
      return reply.code(422).send({
        success: false,
        error: `Message blocked: contains ${detected}. Keep conversations on BizSwipe.`,
        blocked: true,
        detected,
      });
    }

    // ── Verify user is part of this match ─────────────────────────────────
    const matchDoc = await db.collection('matches').doc(matchId).get();
    if (!matchDoc.exists) return reply.code(404).send({ success:false, error:'Match not found' });

    const match = matchDoc.data();
    if (match.buyerId !== uid && match.sellerId !== uid) {
      return reply.code(403).send({ success:false, error:'Unauthorized' });
    }

    // ── Save message ──────────────────────────────────────────────────────
    const msgRef = await db.collection('messages').add({
      matchId,
      senderId:   uid,
      senderName: senderName || 'User',
      text:       text.trim(),
      read:       false,
      createdAt:  FieldValue.serverTimestamp(),
    });

    return reply.send({ success:true, messageId: msgRef.id });
  });

  // Get violations log (admin only)
  fastify.get('/violations', { preHandler: verifyToken }, async (req, reply) => {
    const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').filter(Boolean);
    if (!ADMIN_UIDS.includes(req.user.uid)) {
      return reply.code(403).send({ success:false, error:'Admin only' });
    }
    const snap = await db.collection('violations')
      .orderBy('createdAt','desc').limit(50).get();
    return reply.send({
      success: true,
      violations: snap.docs.map(d => ({ id:d.id, ...d.data() })),
    });
  });
};
