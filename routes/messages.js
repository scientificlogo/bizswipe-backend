'use strict';

const { verifyToken }          = require('../middleware/auth');
const { db }                   = require('../config/firebase');
const { FieldValue }           = require('firebase-admin/firestore');
const { BlockedContentError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { sendMessage: msgSchema } = require('../schemas');

// ── Contact Detection ─────────────────────────────────────────────────────────
const WORD_TO_DIGIT = {
  'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5',
  'six':'6','seven':'7','eight':'8','nine':'9',
  'shunya':'0','ek':'1','do':'2','teen':'3','char':'4',
  'paanch':'5','chhe':'6','chheh':'6','saat':'7','aath':'8','nau':'9',
};

const convertWordsToDigits = (text) => {
  let c = text.toLowerCase();
  Object.entries(WORD_TO_DIGIT).forEach(([w,d]) => {
    c = c.replace(new RegExp(`\\b${w}\\b`, 'gi'), d);
  });
  return c;
};

const countNumberWords = (text) => {
  let count = 0;
  Object.keys(WORD_TO_DIGIT).forEach(w => {
    const m = text.toLowerCase().match(new RegExp(`\\b${w}\\b`, 'gi'));
    if (m) count += m.length;
  });
  return count;
};

const CONTACT_PATTERNS = [
  { pattern: /(\+91[\s\-,]*)?[6-9][\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d[\s\-,]?\d/, label: 'phone number' },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,    label: 'email address' },
  { pattern: /whatsapp|wtsapp|wa\.me/i,                              label: 'WhatsApp contact' },
  { pattern: /telegram|t\.me\//i,                                    label: 'Telegram contact' },
  { pattern: /\bcall me\b|\bping me\b|\bmy number\b|\bmy email\b/i, label: 'off-platform contact' },
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

  // ── Send message (server-side contact detection + auth check) ─────────────
  fastify.post('/send', {
    preHandler: verifyToken,
    schema:     msgSchema,
    config:     { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }                     = req.user;
    const { matchId, text, senderName } = req.body;

    // Contact info detection
    const detected = detectContactInfo(text.trim());
    if (detected) {
      req.log.warn({ userId: uid, matchId, detected, requestId: req.id }, 'Contact info blocked');

      // Log violation
      db.collection('violations').add({
        userId:    uid,
        matchId,
        type:      'contact_info_attempt',
        detected,
        text:      text.trim().substring(0, 200), // truncate for storage
        createdAt: FieldValue.serverTimestamp(),
      }).catch(() => {});

      return reply.code(422).send({
        success:   false,
        blocked:   true,
        detected,
        error:     `Message blocked: contains ${detected}. Keep all conversations on BizSwipe platform.`,
        requestId: req.id,
      });
    }

    // Verify match exists + user is part of it
    const matchDoc = await db.collection('matches').doc(matchId).get();
    if (!matchDoc.exists) {
      return reply.code(404).send({ success: false, error: 'Match not found', requestId: req.id });
    }

    const match = matchDoc.data();
    if (match.buyerId !== uid && match.sellerId !== uid) {
      req.log.warn({ userId: uid, matchId, requestId: req.id }, 'Unauthorized message attempt');
      return reply.code(403).send({ success: false, error: 'Not authorized', requestId: req.id });
    }

    // Save message to Firestore
    const msgRef = await db.collection('messages').add({
      matchId,
      senderId:   uid,
      senderName: senderName || 'User',
      text:       text.trim(),
      read:       false,
      createdAt:  FieldValue.serverTimestamp(),
    });

    req.log.info({ userId: uid, matchId, messageId: msgRef.id, requestId: req.id }, 'Message sent');

    return reply.send({ success: true, messageId: msgRef.id });
  });

  // ── Get violations (admin only) ───────────────────────────────────────────
  fastify.get('/violations', {
    preHandler: require('../middleware/auth').verifyAdmin,
  }, async (req, reply) => {
    const snap = await db.collection('violations')
      .orderBy('createdAt', 'desc').limit(100).get();
    return reply.send({
      success:    true,
      count:      snap.docs.length,
      violations: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });
};
