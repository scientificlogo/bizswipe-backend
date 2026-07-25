'use strict';

const { verifyAdmin }  = require('../middleware/auth');
const { db }           = require('../config/firebase');
const { FieldValue }   = require('firebase-admin/firestore');
const { notifyUser }   = require('../utils/pushNotification');
const { rejectListing: rejectSchema, banUser: banSchema } = require('../schemas');

module.exports = async (fastify) => {

  // ── Dashboard stats ────────────────────────────────────────────────────────
  fastify.get('/stats', { preHandler: verifyAdmin }, async (req, reply) => {
    const [users, activeListings, pendingListings, matches, reports, violations] =
      await Promise.all([
        db.collection('users').count().get(),
        db.collection('listings').where('status','==','active').count().get(),
        db.collection('listings').where('status','==','pending_approval').count().get(),
        db.collection('matches').count().get(),
        db.collection('reports').count().get(),
        db.collection('violations').count().get(),
      ]);

    req.log.info({ adminId: req.user.uid, requestId: req.id }, 'Admin stats fetched');

    return reply.send({
      success: true,
      stats: {
        totalUsers:       users.data().count,
        activeListings:   activeListings.data().count,
        pendingListings:  pendingListings.data().count,
        totalMatches:     matches.data().count,
        totalReports:     reports.data().count,
        totalViolations:  violations.data().count,
      },
    });
  });

  // ── Pending listings ───────────────────────────────────────────────────────
  fastify.get('/listings/pending', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('listings')
      .where('status','==','pending_approval')
      .orderBy('createdAt','asc').get();
    return reply.send({
      success:  true,
      count:    snap.docs.length,
      listings: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });

  // ── Approve listing ────────────────────────────────────────────────────────
  fastify.post('/listings/:listingId/approve', {
    preHandler: verifyAdmin,
  }, async (req, reply) => {
    const { listingId } = req.params;
    const ref           = db.collection('listings').doc(listingId);
    const doc           = await ref.get();

    if (!doc.exists) {
      return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    }

    await ref.update({
      status:     'active',
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: req.user.uid,
    });

    req.log.info({ adminId: req.user.uid, listingId, requestId: req.id }, 'Listing approved');

    // Notify seller
    await notifyUser(db, doc.data().sellerId,
      'Listing Approved!',
      'Your business listing is now live on BizSwipe.',
      { type: 'listing_approved', listingId }
    );

    return reply.send({ success: true, message: 'Listing approved and live!' });
  });

  // ── Reject listing ─────────────────────────────────────────────────────────
  fastify.post('/listings/:listingId/reject', {
    preHandler: verifyAdmin,
    schema:     rejectSchema,
  }, async (req, reply) => {
    const { listingId }   = req.params;
    const { reason = 'Does not meet platform guidelines' } = req.body;
    const ref             = db.collection('listings').doc(listingId);
    const doc             = await ref.get();

    if (!doc.exists) {
      return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    }

    await ref.update({
      status:       'rejected',
      rejectedAt:   FieldValue.serverTimestamp(),
      rejectedBy:   req.user.uid,
      rejectReason: reason,
    });

    req.log.info({ adminId: req.user.uid, listingId, reason, requestId: req.id }, 'Listing rejected');

    // Notify seller
    await notifyUser(db, doc.data().sellerId,
      'Listing Needs Changes',
      reason,
      { type: 'listing_rejected', listingId }
    );

    return reply.send({ success: true, message: 'Listing rejected' });
  });

  // ── All reports ────────────────────────────────────────────────────────────
  fastify.get('/reports', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('reports')
      .orderBy('createdAt','desc').limit(100).get();
    return reply.send({
      success: true,
      count:   snap.docs.length,
      reports: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });

  // ── All violations ─────────────────────────────────────────────────────────
  fastify.get('/violations', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('violations')
      .orderBy('createdAt','desc').limit(100).get();
    return reply.send({
      success:    true,
      count:      snap.docs.length,
      violations: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });

  // ── Ban user ───────────────────────────────────────────────────────────────
  fastify.post('/users/:userId/ban', {
    preHandler: verifyAdmin,
    schema:     banSchema,
  }, async (req, reply) => {
    const { userId } = req.params;
    const { reason = 'Violation of platform policies' } = req.body;

    await db.collection('users').doc(userId).update({
      banned:    true,
      bannedAt:  FieldValue.serverTimestamp(),
      bannedBy:  req.user.uid,
      banReason: reason,
    });

    // Deactivate all their listings
    const listings = await db.collection('listings').where('sellerId','==',userId).get();
    if (!listings.empty) {
      const batch = db.batch();
      listings.docs.forEach(d => batch.update(d.ref, { status: 'suspended' }));
      await batch.commit();
    }

    req.log.info({ adminId: req.user.uid, userId, reason, requestId: req.id }, 'User banned');

    return reply.send({ success: true, message: 'User banned and listings suspended' });
  });

  // ── Get all users (for admin management) ──────────────────────────────────
  fastify.get('/users', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('users')
      .orderBy('createdAt', 'desc').limit(100).get();
    return reply.send({
      success: true,
      count:   snap.docs.length,
      users:   snap.docs.map(d => ({
        id:    d.id,
        name:  d.data().name,
        phone: d.data().phone,
        role:  d.data().role,
        banned: d.data().banned || false,
        gstVerified: d.data().gstVerified || false,
        createdAt: d.data().createdAt,
      })),
    });
  });
};
