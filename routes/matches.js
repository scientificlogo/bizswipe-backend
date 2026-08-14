'use strict';

const { verifyToken }   = require('../middleware/auth');
const { idempotency }   = require('../middleware/idempotency');
const { db }            = require('../config/firebase');
const { FieldValue }    = require('firebase-admin/firestore');
const { ConflictError } = require('../utils/errors');
const { addPushJob }    = require('../utils/queue');

const acceptSchema = {
  body: {
    type: 'object',
    required: ['interestId'],
    additionalProperties: false,
    properties: {
      interestId: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};

const declineSchema = {
  body: {
    type: 'object',
    required: ['interestId'],
    additionalProperties: false,
    properties: {
      interestId: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};

// The match for a (buyer, seller, listing) triple, or null. Used on the paths
// where the interest was already processed, so the caller still gets an id to
// open the chat with.
const findMatch = async (buyerId, sellerId, listingId) => {
  const snap = await db.collection('matches')
    .where('buyerId',   '==', buyerId)
    .where('sellerId',  '==', sellerId)
    .where('listingId', '==', listingId)
    .limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
};

module.exports = async (fastify) => {

  // ── Accept Interest → Atomic Transaction ──────────────────────────────────
  fastify.post('/accept', {
    preHandler: [verifyToken, idempotency], // Fix #8 — Idempotency
    schema:     acceptSchema,
    config:     { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }        = req.user;
    const { interestId } = req.body;
    const start          = Date.now();

    const interestRef = db.collection('interests').doc(interestId);
    const interestDoc = await interestRef.get();

    if (!interestDoc.exists) {
      return reply.code(404).send({ success: false, error: 'Interest not found', requestId: req.id });
    }

    const interest = interestDoc.data();

    if (interest.sellerId !== uid) {
      req.log.warn({ uid, interestId, requestId: req.id }, 'Unauthorized accept attempt');
      return reply.code(403).send({ success: false, error: 'Only the seller can accept', requestId: req.id });
    }

    // Already-accepted has to hand back the match id, not just a message: the
    // seller's next tap needs somewhere to navigate, and the client used to
    // find that match by querying Firestore itself.
    if (interest.status !== 'pending') {
      const existing = await findMatch(interest.buyerId, uid, interest.listingId);
      return reply.send({
        success: true,
        message: 'Already processed',
        status:  interest.status,
        matchId: existing,
      });
    }

    const [sellerDoc, listingDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('listings').doc(interest.listingId).get(),
    ]);

    const seller  = sellerDoc.data()  || {};
    const listing = listingDoc.data() || {};

    // ── ATOMIC TRANSACTION ────────────────────────────────────────────────
    let matchId;

    try {
      matchId = await db.runTransaction(async (tx) => {
        const freshInterest = await tx.get(interestRef);
        if (freshInterest.data().status !== 'pending') {
          throw new ConflictError('Interest already processed');
        }

        const existingMatchSnap = await db.collection('matches')
          .where('buyerId',   '==', interest.buyerId)
          .where('sellerId',  '==', uid)
          .where('listingId', '==', interest.listingId)
          .limit(1).get();

        if (!existingMatchSnap.empty) {
          tx.update(interestRef, { status: 'accepted' });
          return existingMatchSnap.docs[0].id;
        }

        const matchRef   = db.collection('matches').doc();
        const messageRef = db.collection('messages').doc();

        tx.update(interestRef, {
          status:     'accepted',
          acceptedAt: FieldValue.serverTimestamp(),
        });

        tx.set(matchRef, {
          buyerId:      interest.buyerId,
          buyerName:    interest.buyerName,
          buyerPhone:   interest.buyerPhone  || '',
          sellerId:     uid,
          sellerName:   seller.name          || 'Seller',
          sellerPhone:  seller.phone         || '',
          listingId:    interest.listingId,
          listingName:  interest.listingName || '',
          businessName: listing.businessName || '',
          createdAt:    FieldValue.serverTimestamp(),
        });

        tx.set(messageRef, {
          matchId:   matchRef.id,
          senderId:  'system',
          text:      `🎉 It's a Match! ${interest.buyerName} and ${seller.name || 'Seller'} can now chat.`,
          read:      false,
          createdAt: FieldValue.serverTimestamp(),
        });

        return matchRef.id;
      });

    } catch (err) {
      if (err instanceof ConflictError) {
        // Two accepts raced. The winner created the match; hand its id back so
        // the loser opens the same chat instead of a dead end.
        const existing = await findMatch(interest.buyerId, uid, interest.listingId);
        return reply.send({ success: true, message: err.message, matchId: existing });
      }
      req.log.error({ err, interestId, uid, requestId: req.id }, 'Transaction failed');
      return reply.code(500).send({ success: false, error: 'Could not create match — try again', requestId: req.id });
    }

    req.log.info({
      event:     'match_created',
      uid, matchId,
      buyerId:   interest.buyerId,
      duration:  Date.now() - start,
      requestId: req.id,
    }, 'Match created');

    // Push via Bull queue (non-blocking)
    addPushJob(
      interest.buyerId,
      "It's a Match! 🎉",
      `${seller.name || 'Seller'} accepted your interest. Start chatting!`,
      { type: 'match', matchId, screen: 'Matches' }
    );

    return reply.code(201).send({ success: true, matchId, message: 'Match created!' });
  });

  // ── Decline Interest ──────────────────────────────────────────────────────
  fastify.post('/decline', {
    preHandler: verifyToken,
    schema:     declineSchema,
    config:     { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }        = req.user;
    const { interestId } = req.body;

    const interestRef = db.collection('interests').doc(interestId);
    const interestDoc = await interestRef.get();

    if (!interestDoc.exists) {
      return reply.code(404).send({ success: false, error: 'Interest not found', requestId: req.id });
    }

    const interest = interestDoc.data();

    if (interest.sellerId !== uid) {
      return reply.code(403).send({ success: false, error: 'Unauthorized', requestId: req.id });
    }

    if (interest.status !== 'pending') {
      return reply.send({ success: true, message: 'Already processed' });
    }

    await interestRef.update({ status: 'declined', declinedAt: FieldValue.serverTimestamp() });

    req.log.info({ event: 'interest_declined', uid, interestId, requestId: req.id }, 'Interest declined');

    return reply.send({ success: true });
  });

  // ── Get matches ───────────────────────────────────────────────────────────
  fastify.get('/', {
    preHandler: verifyToken,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          role:  { type: 'string', enum: ['buyer', 'seller'] },
          limit: { type: 'string', pattern: '^[0-9]+$' },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }  = req.user;
    const { role } = req.query;
    const limit    = Math.min(parseInt(req.query.limit) || 50, 50);
    const field    = role === 'seller' ? 'sellerId' : 'buyerId';

    const snap = await db.collection('matches')
      .where(field, '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit).get();

    return reply.send({
      success: true,
      count:   snap.docs.length,
      matches: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });

  // ── Get single match ──────────────────────────────────────────────────────
  fastify.get('/:matchId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }     = req.user;
    const { matchId } = req.params;

    const matchDoc = await db.collection('matches').doc(matchId).get();

    if (!matchDoc.exists) {
      return reply.code(404).send({ success: false, error: 'Match not found', requestId: req.id });
    }

    const match = matchDoc.data();
    if (match.buyerId !== uid && match.sellerId !== uid) {
      return reply.code(403).send({ success: false, error: 'Unauthorized', requestId: req.id });
    }

    return reply.send({ success: true, match: { id: matchDoc.id, ...match } });
  });
};