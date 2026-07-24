const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');
const { FieldValue }  = require('firebase-admin/firestore');

// ── Admin check middleware ─────────────────────────────────────────────────────
const verifyAdmin = async (req, reply) => {
  await verifyToken(req, reply);
  const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').filter(Boolean);
  if (!ADMIN_UIDS.includes(req.user?.uid)) {
    return reply.code(403).send({ success:false, error:'Admin access required' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (fastify) => {

  // ── GET pending listings ──────────────────────────────────────────────────
  fastify.get('/listings/pending', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('listings')
      .where('status','==','pending_approval')
      .orderBy('createdAt','asc')
      .get();
    return reply.send({
      success: true,
      count: snap.docs.length,
      listings: snap.docs.map(d => ({ id:d.id, ...d.data() })),
    });
  });

  // ── APPROVE listing ───────────────────────────────────────────────────────
  fastify.post('/listings/:listingId/approve', { preHandler: verifyAdmin }, async (req, reply) => {
    const { listingId } = req.params;
    const listingRef = db.collection('listings').doc(listingId);
    const listing = await listingRef.get();
    if (!listing.exists) return reply.code(404).send({ success:false, error:'Listing not found' });

    await listingRef.update({
      status:     'active',
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: req.user.uid,
    });

    // Notify seller
    const sellerDoc = await db.collection('users').doc(listing.data().sellerId).get();
    const pushToken = sellerDoc.data()?.pushToken;
    if (pushToken) {
      await sendExpoPush(
        pushToken,
        'Listing Approved!',
        'Your business listing is now live on BizSwipe.',
        { type:'listing_approved', listingId }
      );
    }

    return reply.send({ success:true, message:'Listing approved and live!' });
  });

  // ── REJECT listing ────────────────────────────────────────────────────────
  fastify.post('/listings/:listingId/reject', { preHandler: verifyAdmin }, async (req, reply) => {
    const { listingId } = req.params;
    const { reason } = req.body;
    const listingRef = db.collection('listings').doc(listingId);
    const listing = await listingRef.get();
    if (!listing.exists) return reply.code(404).send({ success:false, error:'Listing not found' });

    await listingRef.update({
      status:     'rejected',
      rejectedAt: FieldValue.serverTimestamp(),
      rejectedBy: req.user.uid,
      rejectReason: reason || 'Does not meet platform guidelines',
    });

    // Notify seller
    const sellerDoc = await db.collection('users').doc(listing.data().sellerId).get();
    const pushToken = sellerDoc.data()?.pushToken;
    if (pushToken) {
      await sendExpoPush(
        pushToken,
        'Listing Needs Changes',
        reason || 'Your listing needs to be updated before it can go live.',
        { type:'listing_rejected', listingId }
      );
    }

    return reply.send({ success:true, message:'Listing rejected' });
  });

  // ── GET all reports ───────────────────────────────────────────────────────
  fastify.get('/reports', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('reports')
      .orderBy('createdAt','desc').limit(100).get();
    return reply.send({
      success: true,
      count: snap.docs.length,
      reports: snap.docs.map(d => ({ id:d.id, ...d.data() })),
    });
  });

  // ── GET violations (contact info attempts) ────────────────────────────────
  fastify.get('/violations', { preHandler: verifyAdmin }, async (req, reply) => {
    const snap = await db.collection('violations')
      .orderBy('createdAt','desc').limit(100).get();
    return reply.send({
      success: true,
      count: snap.docs.length,
      violations: snap.docs.map(d => ({ id:d.id, ...d.data() })),
    });
  });

  // ── GET dashboard stats ───────────────────────────────────────────────────
  fastify.get('/stats', { preHandler: verifyAdmin }, async (req, reply) => {
    const [users, listings, matches, reports, violations] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('listings').where('status','==','active').count().get(),
      db.collection('matches').count().get(),
      db.collection('reports').count().get(),
      db.collection('violations').count().get(),
    ]);
    return reply.send({
      success: true,
      stats: {
        totalUsers:      users.data().count,
        activeListings:  listings.data().count,
        totalMatches:    matches.data().count,
        totalReports:    reports.data().count,
        totalViolations: violations.data().count,
      },
    });
  });

  // ── BAN user ──────────────────────────────────────────────────────────────
  fastify.post('/users/:userId/ban', { preHandler: verifyAdmin }, async (req, reply) => {
    const { userId } = req.params;
    const { reason } = req.body;
    await db.collection('users').doc(userId).update({
      banned: true,
      bannedAt: FieldValue.serverTimestamp(),
      bannedBy: req.user.uid,
      banReason: reason || 'Violation of platform policies',
    });
    // Deactivate all their listings
    const listings = await db.collection('listings').where('sellerId','==',userId).get();
    const batch = db.batch();
    listings.docs.forEach(d => batch.update(d.ref, { status:'suspended' }));
    await batch.commit();
    return reply.send({ success:true, message:'User banned and listings suspended' });
  });
};

const sendExpoPush = async (token, title, body, data={}) => {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ to:token, sound:'default', title, body, data, priority:'high' }),
    });
  } catch(e) { console.log('Push error:', e.message); }
};
