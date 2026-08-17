'use strict';

const { verifyToken }     = require('../middleware/auth');
const { idempotency }     = require('../middleware/idempotency');
const { db }              = require('../config/firebase');
const { sanitizeListing } = require('../utils/sanitize');
const { FieldValue }      = require('firebase-admin/firestore');
const { createListing: createSchema, pagination } = require('../schemas');
const cache = require('../utils/cache');

const MAX_LIMIT = 50;

module.exports = async (fastify) => {

  // ── Create Listing ────────────────────────────────────────────────────────
  fastify.post('/create', {
    preHandler: [verifyToken, idempotency], // Fix #8 — Idempotency
    schema:     createSchema,
    config:     { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid } = req.user;
    const data    = req.body;
    const start   = Date.now();

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

    // ProfileScreen's completeness meter checks users/{uid}.hasListing, which
    // nothing ever wrote — so a seller with a live listing was permanently
    // stuck at 80% with "Listing created" unticked.
    // set/merge, not update: verifyToken does not require a user document to
    // exist, and update() would throw NOT_FOUND after the listing was written.
    await db.collection('users').doc(uid).set({ hasListing: true }, { merge: true });

    // Invalidate feed cache
    setImmediate(() => cache.delPattern('feed:*'));

    req.log.info({
      event:     'listing_created',
      userId:    uid,
      listingId: docRef.id,
      duration:  Date.now() - start,
      requestId: req.id,
    }, 'Listing created');

    return reply.code(201).send({
      success:   true,
      listingId: docRef.id,
      message:   'Listing is now live on BizSwipe!',
    });
  });

  // ── Feed — with Redis Cache ───────────────────────────────────────────────
  fastify.get('/feed', {
    preHandler: verifyToken,
    schema:     { querystring: pagination },
    config: {
      rateLimit: {
        max:          60,
        timeWindow:   '1 minute',
        keyGenerator: (req) => req.user?.uid || req.ip,
      },
    },
  }, async (req, reply) => {
    const { uid }    = req.user;
    const limit      = Math.min(parseInt(req.query.limit) || 20, MAX_LIMIT);
    const { lastId } = req.query;
    const start      = Date.now();

    // Check Redis cache (first page only)
    if (!lastId) {
      const cacheKey   = cache.keys.listingsFeed(uid, limit);
      const cachedData = await cache.get(cacheKey);
      if (cachedData) {
        req.log.info({ event: 'feed_cache_hit', userId: uid, duration: Date.now() - start, requestId: req.id }, 'Feed from cache');
        return reply.send(cachedData);
      }
    }

    // Validate cursor
    let lastDoc = null;
    if (lastId) {
      lastDoc = await db.collection('listings').doc(lastId).get();
      if (!lastDoc.exists || lastDoc.data().status !== 'active') {
        return reply.code(400).send({ success: false, error: 'Invalid pagination cursor', requestId: req.id });
      }
    }

    // Blocks were applied on the phone, which only worked because the client
    // could see every listing's sellerId. The feed no longer ships sellerId at
    // all, so the filter has to happen here.
    const [swipedSnap, blockedSnap] = await Promise.all([
      db.collection('swipes').where('buyerId',  '==', uid).get(),
      db.collection('blocks').where('blockerId', '==', uid).get(),
    ]);
    const swipedIds  = swipedSnap.docs.map(d => d.data().listingId);
    const blockedIds = new Set(blockedSnap.docs.map(d => d.data().blockedUserId).filter(Boolean));

    const fetchSize = limit + swipedIds.length + blockedIds.size + 1;

    let q = db.collection('listings')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(fetchSize);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap    = await q.get();
    const visible = snap.docs.filter(d =>
      !swipedIds.includes(d.id) &&
      d.data().sellerId !== uid &&
      !blockedIds.has(d.data().sellerId)
    );

    const listings = visible
      .slice(0, limit)
      .map(d => ({
        id:           d.id,
        industry:     d.data().industry,
        emoji:        d.data().emoji,
        bannerColor:  d.data().bannerColor,
        accentColor:  d.data().accentColor,
        location:     d.data().location,
        // The buyer's saved preferences match on state, and the seller types
        // it as its own field — without it every location preference silently
        // fell back to substring-matching the free-text location line.
        state:        d.data().state,
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
      }));

    // Cursor off the last *fetched* doc, not the last returned one, whenever
    // the window was filled. A page where everything was swiped or blocked
    // returns zero listings — anchoring the cursor to the returned list would
    // hand back null and strand the client on an empty feed with more to see.
    const filledWindow = snap.docs.length === fetchSize;
    const nextCursor   = listings.length === limit
      ? listings[listings.length - 1].id
      : (filledWindow ? snap.docs[snap.docs.length - 1].id : null);

    const response = {
      success:    true,
      listings,
      hasMore:    visible.length > limit || filledWindow,
      nextCursor,
      source:     'firestore',
    };

    if (!lastId) {
      const cacheKey = cache.keys.listingsFeed(uid, limit);
      setImmediate(() => cache.set(cacheKey, response, cache.TTL.LISTINGS_FEED));
    }

    req.log.info({ event: 'feed_firestore_hit', userId: uid, count: listings.length, duration: Date.now() - start, requestId: req.id }, 'Feed from Firestore');

    return reply.send(response);
  });

  // ── Increment view count ──────────────────────────────────────────────────
  fastify.post('/:listingId/view', {
    preHandler: verifyToken,
    config: {
      rateLimit: {
        max:          10,
        timeWindow:   '1 minute',
        // The `|| req.ip` matters: without it an unauthenticated request keyed
        // every caller onto the single bucket "view_undefined_<listingId>".
        keyGenerator: (req) => `view_${req.user?.uid || req.ip}_${req.params.listingId}`,
      },
    },
  }, async (req, reply) => {
    const { listingId } = req.params;
    const { uid }       = req.user;

    const doc = await db.collection('listings').doc(listingId).get();
    if (!doc.exists) {
      return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    }
    const listing = doc.data();

    // A seller looking at their own listing is not a view.
    if (listing.sellerId === uid) return reply.send({ success: true, counted: false });

    // The de-duplication and the listingViews document used to live in
    // SwipeScreen, which needed the listing's sellerId to write them — the one
    // field the feed exists to withhold. Without the dedupe here the counter
    // would climb every time a card scrolled back into view.
    const seen = await db.collection('listingViews')
      .where('listingId', '==', listingId)
      .where('viewerId',  '==', uid)
      .limit(1).get();

    if (!seen.empty) return reply.send({ success: true, counted: false });

    const viewerDoc = await db.collection('users').doc(uid).get();

    await db.collection('listingViews').add({
      listingId,
      sellerId:   listing.sellerId,
      viewerId:   uid,
      viewerName: viewerDoc.data()?.name || 'Buyer',
      viewedAt:   FieldValue.serverTimestamp(),
    });
    await db.collection('listings').doc(listingId).update({ views: FieldValue.increment(1) });

    return reply.send({ success: true, counted: true });
  });

  // ── Get seller's listing ──────────────────────────────────────────────────
  fastify.get('/my-listing', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uid } = req.user;
    const snap    = await db.collection('listings').where('sellerId', '==', uid).limit(1).get();
    if (snap.empty) return reply.send({ success: true, listing: null });
    const d = snap.docs[0];
    return reply.send({ success: true, listing: { id: d.id, ...d.data() } });
  });

  // ── Get single listing ────────────────────────────────────────────────────
  fastify.get('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { listingId } = req.params;
    const { uid }       = req.user;
    const doc = await db.collection('listings').doc(listingId).get();
    if (!doc.exists) {
      return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    }
    const data    = doc.data();
    const isOwner = data.sellerId === uid;
    let isMatched = false;
    if (!isOwner) {
      const matchSnap = await db.collection('matches')
        .where('buyerId', '==', uid).where('listingId', '==', listingId).limit(1).get();
      isMatched = !matchSnap.empty;
    }

    // Blanking businessName out of a `...data` spread was not enough: sellerName,
    // sellerPhone and sellerId rode along in the same spread. Every listing id is
    // handed to every buyer by the feed, so anyone could walk those ids and
    // collect the phone number of every seller on the platform — the whole point
    // of masking the business name, undone one field over.
    //
    // Allow-list, not deny-list, and the same field set the feed sends. A field
    // added to a listing tomorrow is invisible here until someone decides it is
    // safe, which is the right default.
    const publicListing = {
      id:           doc.id,
      industry:     data.industry,
      emoji:        data.emoji,
      bannerColor:  data.bannerColor,
      accentColor:  data.accentColor,
      location:     data.location,
      state:        data.state,
      type:         data.type,
      age:          data.age,
      employees:    data.employees,
      turnover:     data.turnover,
      askingPrice:  data.askingPrice,
      profitStatus: data.profitStatus,
      hasDebt:      data.hasDebt,
      tags:         data.tags,
      interested:   data.interested,
      views:        data.views,
      status:       data.status,
    };

    // description and reason are free text the seller types — they routinely
    // name the business — so they are held back with the identity fields.
    const identity = {
      businessName: data.businessName,
      sellerName:   data.sellerName,
      sellerPhone:  data.sellerPhone,
      sellerId:     data.sellerId,
      description:  data.description,
      reason:       data.reason,
      debtAmount:   data.debtAmount,
      createdAt:    data.createdAt,
    };

    return reply.send({
      success: true,
      listing: (isOwner || isMatched) ? { ...publicListing, ...identity } : publicListing,
    });
  });

  // ── Update listing ────────────────────────────────────────────────────────
  fastify.put('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid }       = req.user;
    const { listingId } = req.params;
    const doc = await db.collection('listings').doc(listingId).get();
    if (!doc.exists) return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    if (doc.data().sellerId !== uid) return reply.code(403).send({ success: false, error: 'Unauthorized', requestId: req.id });
    await db.collection('listings').doc(listingId).update({
      ...sanitizeListing({ ...doc.data(), ...req.body }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    setImmediate(() => cache.delPattern('feed:*'));
    req.log.info({ event: 'listing_updated', userId: uid, listingId, requestId: req.id }, 'Listing updated');
    return reply.send({ success: true, message: 'Listing updated!' });
  });

  // ── Deactivate listing ────────────────────────────────────────────────────
  fastify.delete('/:listingId', {
    preHandler: verifyToken,
    config:     { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { uid }       = req.user;
    const { listingId } = req.params;
    const doc = await db.collection('listings').doc(listingId).get();
    if (!doc.exists) return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    if (doc.data().sellerId !== uid) return reply.code(403).send({ success: false, error: 'Unauthorized', requestId: req.id });
    await db.collection('listings').doc(listingId).update({ status: 'inactive', deactivatedAt: FieldValue.serverTimestamp() });
    await db.collection('users').doc(uid).set({ hasListing: false }, { merge: true });
    setImmediate(() => cache.delPattern('feed:*'));
    req.log.info({ event: 'listing_deactivated', userId: uid, listingId, requestId: req.id }, 'Listing deactivated');
    return reply.send({ success: true, message: 'Listing deactivated' });
  });
};