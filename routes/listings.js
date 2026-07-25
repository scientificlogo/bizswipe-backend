'use strict';

const { verifyToken }    = require('../middleware/auth');
const { db }             = require('../config/firebase');
const { sanitizeListing } = require('../utils/sanitize');
const { FieldValue }     = require('firebase-admin/firestore');
const { createListing: createSchema } = require('../schemas');
const { notifyUser }     = require('../utils/pushNotification');

const MAX_LIMIT = 50; // Never allow more than 50 listings per request

module.exports = async (fastify) => {

  // ── Create listing (directly active for beta) ─────────────────────────────
  fastify.post('/create', {
    preHandler: verifyToken,
    schema:     createSchema,
    config:     { rateLimit: { max: 5, timeWindow: '1 hour' } }, // Max 5 listings per hour
  }, async (req, reply) => {
    const { uid } = req.user;
    const data    = req.body;

    // Check for existing active listing
    const existing = await db.collection('listings')
      .where('sellerId', '==', uid)
      .where('status', 'in', ['active'])
      .limit(1).get();

    if (!existing.empty) {
      return reply.code(409).send({
        success:   false,
        error:     'You already have an active listing',
        listingId: existing.docs[0].id,
        requestId: req.id,
      });
    }

    // Get seller profile
    const sellerDoc = await db.collection('users').doc(uid).get();
    const seller    = sellerDoc.data() || {};

    const listing = {
      ...sanitizeListing(data),
      sellerId:    uid,
      sellerName:  seller.name  || 'Seller',
      sellerPhone: seller.phone || '',
      status:      'active',
      interested:  0,
      views:       0,
      createdAt:   FieldValue.serverTimestamp(),
      updatedAt:   FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('listings').add(listing);

    req.log.info({ userId: uid, listingId: docRef.id, requestId: req.id }, 'Listing created');

    return reply.code(201).send({
      success:   true,
      listingId: docRef.id,
      message:   'Listing is now live on BizSwipe!',
    });
  });

  // ── Get active listings feed (paginated) ──────────────────────────────────
  fastify.get('/feed', {
    preHandler: verifyToken,
    schema:     { querystring: require('../schemas').pagination },
    config:     { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid }  = req.user;
    const limit    = Math.min(parseInt(req.query.limit) || 20, MAX_LIMIT); // ← Pagination cap
    const { lastId } = req.query;

    // Swiped IDs
    const swipedSnap = await db.collection('swipes').where('buyerId', '==', uid).get();
    const swipedIds  = swipedSnap.docs.map(d => d.data().listingId);

    let q = db.collection('listings')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(limit + swipedIds.length + 1);

    if (lastId) {
      const lastDoc = await db.collection('listings').doc(lastId).get();
      if (lastDoc.exists) q = q.startAfter(lastDoc);
    }

    const snap    = await q.get();
    const listings = snap.docs
      .filter(d => !swipedIds.includes(d.id) && d.data().sellerId !== uid)
      .slice(0, limit)
      .map(d => ({
        id:           d.id,
        industry:     d.data().industry,
        emoji:        d.data().emoji,
        bannerColor:  d.data().bannerColor,
        accentColor:  d.data().accentColor,
        location:     d.data().location,
        type:         d.data().type,
        age:          d.data().age,
        employees:    d.data().employees,
        turnover:     d.data().turnover,
        askingPrice:  d.data().askingPrice,
        profitStatus: d.data().profitStatus,
        hasDebt:      d.data().hasDebt,
        tags:         d.data().tags,
        interested:   d.data().interested,
        views:        d.data().views,
        // businessName intentionally HIDDEN until match
      }));

    return reply.send({ success: true, listings, hasMore: snap.docs.length > limit });
  });

  // ── Increment view count ───────────────────────────────────────────────────
  fastify.post('/:listingId/view', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 100, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    await db.collection('listings').doc(req.params.listingId).update({
      views: FieldValue.increment(1),
    });
    return reply.send({ success: true });
  });

  // ── Get seller's own listing ───────────────────────────────────────────────
  fastify.get('/my-listing', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    const { uid } = req.user;
    const snap    = await db.collection('listings').where('sellerId', '==', uid).limit(1).get();
    if (snap.empty) return reply.send({ success: true, listing: null });
    const d = snap.docs[0];
    return reply.send({ success: true, listing: { id: d.id, ...d.data() } });
  });
};
