'use strict';

const { verifyToken }     = require('../middleware/auth');
const { db }              = require('../config/firebase');
const { sanitizeListing } = require('../utils/sanitize');
const { FieldValue }      = require('firebase-admin/firestore');
const { createListing: createSchema, pagination } = require('../schemas');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const MAX_LIMIT = 50;

module.exports = async (fastify) => {

  // ── Create Listing ────────────────────────────────────────────────────────
  fastify.post('/create', {
    preHandler: verifyToken,
    schema:     createSchema,
    config:     { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid } = req.user;
    const data    = req.body;
    const start   = Date.now();

    // Check existing listing
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

    req.log.info({
      event:     'listing_created',
      userId:    uid,
      listingId: docRef.id,
      duration:  Date.now() - start,
      requestId: req.id,
    }, 'Listing created successfully');

    return reply.code(201).send({
      success:   true,
      listingId: docRef.id,
      message:   'Listing is now live on BizSwipe!',
    });
  });

  // ── Feed — Paginated listings ─────────────────────────────────────────────
  fastify.get('/feed', {
    preHandler: verifyToken,
    schema:     { querystring: pagination },
    // Fix #11 — Rate limit per UID (not per IP)
    config: {
      rateLimit: {
        max:        60,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.user?.uid || req.ip,
      },
    },
  }, async (req, reply) => {
    const { uid }    = req.user;
    const limit      = Math.min(parseInt(req.query.limit) || 20, MAX_LIMIT);
    const { lastId } = req.query;
    const start      = Date.now();

    // Fix #6 — Validate pagination cursor
    let lastDoc = null;
    if (lastId) {
      // Validate lastId is a real listing that exists
      lastDoc = await db.collection('listings').doc(lastId).get();
      if (!lastDoc.exists) {
        return reply.code(400).send({
          success:   false,
          error:     'Invalid pagination cursor',
          requestId: req.id,
        });
      }
      // Security: can't use someone's private listing as cursor
      if (lastDoc.data().status !== 'active') {
        return reply.code(400).send({
          success:   false,
          error:     'Invalid pagination cursor',
          requestId: req.id,
        });
      }
    }

    // Get swiped IDs
    const swipedSnap = await db.collection('swipes')
      .where('buyerId', '==', uid).get();
    const swipedIds  = swipedSnap.docs.map(d => d.data().listingId);

    // Build query
    let q = db.collection('listings')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(limit + swipedIds.length + 1);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap     = await q.get();
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
        // businessName INTENTIONALLY hidden until match
      }));

    req.log.info({
      event:     'feed_fetched',
      userId:    uid,
      count:     listings.length,
      duration:  Date.now() - start,
      requestId: req.id,
    }, 'Listings feed fetched');

    return reply.send({
      success: true,
      listings,
      hasMore: snap.docs.length > limit,
      // Return last ID for next page cursor
      nextCursor: listings.length > 0 ? listings[listings.length - 1].id : null,
    });
  });

  // ── Increment view count ──────────────────────────────────────────────────
  fastify.post('/:listingId/view', {
    preHandler: verifyToken,
    config: {
      rateLimit: {
        max:        10,
        timeWindow: '1 minute',
        // Fix #11 — per UID rate limit
        keyGenerator: (req) => `view_${req.user?.uid}_${req.params.listingId}`,
      },
    },
  }, async (req, reply) => {
    const { listingId } = req.params;

    // Validate listing exists
    const listingDoc = await db.collection('listings').doc(listingId).get();
    if (!listingDoc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'Listing not found',
        requestId: req.id,
      });
    }

    await db.collection('listings').doc(listingId).update({
      views: FieldValue.increment(1),
    });

    return reply.send({ success: true });
  });

  // ── Get seller's own listing ──────────────────────────────────────────────
  fastify.get('/my-listing', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid } = req.user;

    const snap = await db.collection('listings')
      .where('sellerId', '==', uid)
      .limit(1).get();

    if (snap.empty) {
      return reply.send({ success: true, listing: null });
    }

    const d = snap.docs[0];
    return reply.send({
      success: true,
      listing: { id: d.id, ...d.data() },
    });
  });

  // ── Get single listing (authenticated) ───────────────────────────────────
  fastify.get('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { listingId } = req.params;
    const { uid }       = req.user;

    const doc = await db.collection('listings').doc(listingId).get();

    if (!doc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'Listing not found',
        requestId: req.id,
      });
    }

    const data = doc.data();

    // Hide business name unless it's seller's own listing or matched
    const isOwner = data.sellerId === uid;

    // Check if buyer is matched with this listing
    let isMatched = false;
    if (!isOwner) {
      const matchSnap = await db.collection('matches')
        .where('buyerId',   '==', uid)
        .where('listingId', '==', listingId)
        .limit(1).get();
      isMatched = !matchSnap.empty;
    }

    return reply.send({
      success: true,
      listing: {
        id:           doc.id,
        ...data,
        // Only reveal businessName to owner or matched buyer
        businessName: (isOwner || isMatched) ? data.businessName : undefined,
      },
    });
  });

  // ── Update listing (seller only) ──────────────────────────────────────────
  fastify.put('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid }       = req.user;
    const { listingId } = req.params;
    const data          = req.body;

    const doc = await db.collection('listings').doc(listingId).get();

    if (!doc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'Listing not found',
        requestId: req.id,
      });
    }

    if (doc.data().sellerId !== uid) {
      return reply.code(403).send({
        success:   false,
        error:     'You can only edit your own listing',
        requestId: req.id,
      });
    }

    const updated = {
      ...sanitizeListing({ ...doc.data(), ...data }),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await db.collection('listings').doc(listingId).update(updated);

    req.log.info({
      event:     'listing_updated',
      userId:    uid,
      listingId,
      requestId: req.id,
    }, 'Listing updated');

    return reply.send({ success: true, message: 'Listing updated!' });
  });

  // ── Delete/Deactivate listing (seller only) ───────────────────────────────
  fastify.delete('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid }       = req.user;
    const { listingId } = req.params;

    const doc = await db.collection('listings').doc(listingId).get();

    if (!doc.exists) {
      return reply.code(404).send({
        success:   false,
        error:     'Listing not found',
        requestId: req.id,
      });
    }

    if (doc.data().sellerId !== uid) {
      return reply.code(403).send({
        success:   false,
        error:     'You can only delete your own listing',
        requestId: req.id,
      });
    }

    // Soft delete — set status to 'inactive'
    await db.collection('listings').doc(listingId).update({
      status:      'inactive',
      deactivatedAt: FieldValue.serverTimestamp(),
    });

    req.log.info({
      event:     'listing_deactivated',
      userId:    uid,
      listingId,
      requestId: req.id,
    }, 'Listing deactivated');

    return reply.send({ success: true, message: 'Listing deactivated' });
  });
};