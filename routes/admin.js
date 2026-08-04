'use strict';

const { verifyAdmin }  = require('../middleware/auth');
const { db }           = require('../config/firebase');
const { FieldValue }   = require('firebase-admin/firestore');
const { notifyUser }   = require('../utils/pushNotification');
const { addAuditLog, addPushJob } = require('../utils/queue');
const cache            = require('../utils/cache');
const { rejectListing: rejectSchema, banUser: banSchema } = require('../schemas');

module.exports = async (fastify) => {

  // ── Dashboard stats ────────────────────────────────────────────────────────
  fastify.get('/stats', { preHandler: verifyAdmin }, async (req, reply) => {
    const [users, activeListings, pendingListings, matches, reports, violations, adminActions] =
      await Promise.all([
        db.collection('users').count().get(),
        db.collection('listings').where('status','==','active').count().get(),
        db.collection('listings').where('status','==','pending_approval').count().get(),
        db.collection('matches').count().get(),
        db.collection('reports').count().get(),
        db.collection('violations').count().get(),
        db.collection('adminActions').count().get(),
      ]);

    req.log.info({
      event:   'admin_stats_fetched',
      adminId: req.user.uid,
      requestId: req.id,
    }, 'Admin stats fetched');

    return reply.send({
      success: true,
      stats: {
        totalUsers:       users.data().count,
        activeListings:   activeListings.data().count,
        pendingListings:  pendingListings.data().count,
        totalMatches:     matches.data().count,
        totalReports:     reports.data().count,
        totalViolations:  violations.data().count,
        totalAdminActions: adminActions.data().count,
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

    req.log.info({
      event:     'listing_approved',
      adminId:   req.user.uid,
      listingId,
      requestId: req.id,
    }, 'Listing approved');

    // Audit log via queue
    addAuditLog(req.user.uid, 'listing_approved', listingId, 'listing', {
      sellerName: doc.data().sellerName,
      industry:   doc.data().industry,
    });

    // Notify seller via queue
    addPushJob(
      doc.data().sellerId,
      'Listing Approved! 🎉',
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
    const { listingId } = req.params;
    const { reason = 'Does not meet platform guidelines' } = req.body;
    const ref = db.collection('listings').doc(listingId);
    const doc = await ref.get();

    if (!doc.exists) {
      return reply.code(404).send({ success: false, error: 'Listing not found', requestId: req.id });
    }

    await ref.update({
      status:       'rejected',
      rejectedAt:   FieldValue.serverTimestamp(),
      rejectedBy:   req.user.uid,
      rejectReason: reason,
    });

    req.log.info({
      event:     'listing_rejected',
      adminId:   req.user.uid,
      listingId,
      reason,
      requestId: req.id,
    }, 'Listing rejected');

    // Audit log via queue
    addAuditLog(req.user.uid, 'listing_rejected', listingId, 'listing', { reason });

    // Notify seller via queue
    addPushJob(
      doc.data().sellerId,
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

  // ── Admin action history ───────────────────────────────────────────────────
  fastify.get('/actions', { preHandler: verifyAdmin }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const snap  = await db.collection('adminActions')
      .orderBy('createdAt','desc').limit(limit).get();

    return reply.send({
      success: true,
      count:   snap.docs.length,
      actions: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  });

  // ── Ban user ───────────────────────────────────────────────────────────────
  fastify.post('/users/:userId/ban', {
    preHandler: verifyAdmin,
    schema:     banSchema,
  }, async (req, reply) => {
    const { userId } = req.params;
    const { reason = 'Violation of platform policies' } = req.body;

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return reply.code(404).send({ success: false, error: 'User not found', requestId: req.id });
    }

    await db.collection('users').doc(userId).update({
      banned:    true,
      bannedAt:  FieldValue.serverTimestamp(),
      bannedBy:  req.user.uid,
      banReason: reason,
    });

    // verifyToken caches ban status for 5 minutes — drop the key so the ban
    // takes effect on the user's very next request rather than 5 minutes later.
    await cache.del(`banned:${userId}`);

    // Deactivate all their listings
    const listings = await db.collection('listings').where('sellerId','==',userId).get();
    if (!listings.empty) {
      const batch = db.batch();
      listings.docs.forEach(d => batch.update(d.ref, { status: 'suspended' }));
      await batch.commit();
    }

    req.log.info({
      event:     'user_banned',
      adminId:   req.user.uid,
      userId,
      reason,
      requestId: req.id,
    }, 'User banned');

    // Audit log via queue
    addAuditLog(req.user.uid, 'user_banned', userId, 'user', {
      reason,
      userName:  userDoc.data().name,
      userPhone: userDoc.data().phone,
    });

    return reply.send({ success: true, message: 'User banned and listings suspended' });
  });

  // ── Unban user ─────────────────────────────────────────────────────────────
  fastify.post('/users/:userId/unban', {
    preHandler: verifyAdmin,
  }, async (req, reply) => {
    const { userId } = req.params;

    await db.collection('users').doc(userId).update({
      banned:    false,
      unbannedAt: FieldValue.serverTimestamp(),
      unbannedBy: req.user.uid,
    });

    // Without this the user stays locked out for up to 5 more minutes.
    await cache.del(`banned:${userId}`);

    req.log.info({
      event:     'user_unbanned',
      adminId:   req.user.uid,
      userId,
      requestId: req.id,
    }, 'User unbanned');

    addAuditLog(req.user.uid, 'user_unbanned', userId, 'user');

    return reply.send({ success: true, message: 'User unbanned' });
  });

  // ── Get all users ──────────────────────────────────────────────────────────
  fastify.get('/users', { preHandler: verifyAdmin }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const snap  = await db.collection('users')
      .orderBy('createdAt','desc').limit(limit).get();

    return reply.send({
      success: true,
      count:   snap.docs.length,
      users:   snap.docs.map(d => ({
        id:          d.id,
        name:        d.data().name,
        phone:       d.data().phone,
        role:        d.data().role,
        banned:      d.data().banned      || false,
        gstVerified: d.data().gstVerified || false,
        createdAt:   d.data().createdAt,
      })),
    });
  });
};