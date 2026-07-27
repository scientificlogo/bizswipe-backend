'use strict';

const { verifyToken }  = require('../middleware/auth');
const { db }           = require('../config/firebase');
const { FieldValue }   = require('firebase-admin/firestore');
const { notifyUser }   = require('../utils/pushNotification');
const { NotFoundError, ForbiddenError, ConflictError } = require('../utils/errors');

// ── Schemas ───────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (fastify) => {

  // ── Accept Interest → Atomic Transaction ──────────────────────────────────
  fastify.post('/accept', {
    preHandler: verifyToken,
    schema:     acceptSchema,
    config:     { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }        = req.user;
    const { interestId } = req.body;
    const start          = Date.now();

    // ── Pre-transaction reads ─────────────────────────────────────────────
    const interestRef = db.collection('interests').doc(interestId);
    const interestDoc = await interestRef.get();

    if (!interestDoc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'Interest not found',
        requestId: req.id,
      });
    }

    const interest = interestDoc.data();

    // Only seller can accept
    if (interest.sellerId !== uid) {
      req.log.warn({ uid, interestId, requestId: req.id }, 'Unauthorized accept attempt');
      return reply.code(403).send({
        success:   false,
        error:     'Only the seller can accept this interest',
        requestId: req.id,
      });
    }

    // Already processed
    if (interest.status !== 'pending') {
      return reply.send({
        success: true,
        message: 'Already processed',
        status:  interest.status,
      });
    }

    // Get seller + listing data (outside transaction for reads)
    const [sellerDoc, listingDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('listings').doc(interest.listingId).get(),
    ]);

    const seller  = sellerDoc.data()  || {};
    const listing = listingDoc.data() || {};

    // ── ATOMIC TRANSACTION ────────────────────────────────────────────────
    // All 3 writes happen together or none at all!
    let matchId;

    try {
      matchId = await db.runTransaction(async (tx) => {

        // Re-read inside transaction (prevents race condition)
        const freshInterest = await tx.get(interestRef);
        if (freshInterest.data().status !== 'pending') {
          throw new ConflictError('Interest already processed');
        }

        // Check for existing match (inside transaction)
        const existingMatchSnap = await db.collection('matches')
          .where('buyerId',   '==', interest.buyerId)
          .where('sellerId',  '==', uid)
          .where('listingId', '==', interest.listingId)
          .limit(1).get();

        if (!existingMatchSnap.empty) {
          // Match exists — just update interest and return
          tx.update(interestRef, { status: 'accepted' });
          return existingMatchSnap.docs[0].id;
        }

        // Create new match ref
        const matchRef   = db.collection('matches').doc();
        const messageRef = db.collection('messages').doc();

        // Write 1: Update interest status
        tx.update(interestRef, {
          status:     'accepted',
          acceptedAt: FieldValue.serverTimestamp(),
        });

        // Write 2: Create match
        tx.set(matchRef, {
          buyerId:     interest.buyerId,
          buyerName:   interest.buyerName,
          buyerPhone:  interest.buyerPhone  || '',
          sellerId:    uid,
          sellerName:  seller.name          || 'Seller',
          sellerPhone: seller.phone         || '',
          listingId:   interest.listingId,
          listingName: interest.listingName || '',
          businessName: listing.businessName || '', // Revealed after match!
          createdAt:   FieldValue.serverTimestamp(),
        });

        // Write 3: System message
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
        return reply.send({ success: true, message: err.message });
      }
      req.log.error({ err, interestId, uid, requestId: req.id }, 'Transaction failed');
      return reply.code(500).send({
        success:   false,
        error:     'Could not create match — please try again',
        requestId: req.id,
      });
    }

    req.log.info({
      uid,
      matchId,
      buyerId:   interest.buyerId,
      interestId,
      duration:  Date.now() - start,
      requestId: req.id,
    }, 'Match created successfully');

    // ── Push notification (fire and forget — don't block response) ────────
    setImmediate(async () => {
      try {
        await notifyUser(
          db,
          interest.buyerId,
          "It's a Match! 🎉",
          `${seller.name || 'Seller'} accepted your interest. Start chatting now!`,
          { type: 'match', matchId, screen: 'Matches' }
        );
      } catch (err) {
        req.log.warn({ err: err.message, buyerId: interest.buyerId }, 'Push notification failed');
      }
    });

    return reply.code(201).send({
      success: true,
      matchId,
      message: 'Match created successfully!',
    });
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
      return reply.code(404).send({
        success:   false,
        error:     'Interest not found',
        requestId: req.id,
      });
    }

    const interest = interestDoc.data();

    if (interest.sellerId !== uid) {
      return reply.code(403).send({
        success:   false,
        error:     'Unauthorized',
        requestId: req.id,
      });
    }

    if (interest.status !== 'pending') {
      return reply.send({ success: true, message: 'Already processed' });
    }

    await interestRef.update({
      status:     'declined',
      declinedAt: FieldValue.serverTimestamp(),
    });

    req.log.info({ uid, interestId, requestId: req.id }, 'Interest declined');

    return reply.send({ success: true });
  });

  // ── Get matches for user ──────────────────────────────────────────────────
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
    const { uid }   = req.user;
    const { role }  = req.query;
    const limit     = Math.min(parseInt(req.query.limit) || 50, 50);

    const field = role === 'seller' ? 'sellerId' : 'buyerId';

    const snap = await db.collection('matches')
      .where(field, '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

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
      return reply.code(404).send({
        success:   false,
        error:     'Match not found',
        requestId: req.id,
      });
    }

    const match = matchDoc.data();

    // Only buyer or seller can view
    if (match.buyerId !== uid && match.sellerId !== uid) {
      return reply.code(403).send({
        success:   false,
        error:     'Unauthorized',
        requestId: req.id,
      });
    }

    return reply.send({
      success: true,
      match:   { id: matchDoc.id, ...match },
    });
  });
};