const { verifyToken }    = require('../middleware/auth');
const { db }             = require('../config/firebase');
const { sanitizeListing } = require('../utils/sanitize');
const { FieldValue }     = require('firebase-admin/firestore');

module.exports = async (fastify) => {

  // Create listing — status: pending_approval (admin review required)
  fastify.post('/create', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const data    = req.body;

    // Validation
    if (!data.businessName?.trim()) return reply.code(400).send({ success:false, error:'Business name required' });
    if (!data.industry?.trim())     return reply.code(400).send({ success:false, error:'Industry required' });
    if (!data.city?.trim())         return reply.code(400).send({ success:false, error:'City required' });
    if (!data.askingPrice?.trim())  return reply.code(400).send({ success:false, error:'Asking price required' });

    // Check if seller already has a listing (any status)
    const existing = await db.collection('listings')
      .where('sellerId','==',uid)
      .where('status','in',['active','pending_approval'])
      .limit(1).get();
    if (!existing.empty) {
      return reply.code(409).send({
        success:   false,
        error:     'Ek active listing already hai',
        listingId: existing.docs[0].id,
        status:    existing.docs[0].data().status,
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
      status:      'pending_approval',  // ← Admin review required
      interested:  0,
      views:       0,
      createdAt:   FieldValue.serverTimestamp(),
      updatedAt:   FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('listings').add(listing);

    // Notify admin (if ADMIN_UIDS set)
    const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').filter(Boolean);
    for (const adminUid of ADMIN_UIDS) {
      const adminDoc = await db.collection('users').doc(adminUid).get();
      const pushToken = adminDoc.data()?.pushToken;
      if (pushToken) {
        await sendExpoPush(
          pushToken,
          'New Listing for Review',
          `${seller.name || 'A seller'} submitted a ${data.industry} business for approval`,
          { type:'new_listing', listingId: docRef.id }
        );
      }
    }

    return reply.send({
      success:   true,
      listingId: docRef.id,
      status:    'pending_approval',
      message:   'Listing submitted for review. Goes live within 24 hours.',
    });
  });

  // Get all active listings (paginated)
  fastify.get('/feed', { preHandler: verifyToken }, async (req, reply) => {
    const { uid }              = req.user;
    const { limit=20, lastId } = req.query;

    const swipedSnap = await db.collection('swipes').where('buyerId','==',uid).get();
    const swipedIds  = swipedSnap.docs.map(d => d.data().listingId);

    let q = db.collection('listings')
      .where('status','==','active')  // Only approved listings
      .orderBy('createdAt','desc')
      .limit(parseInt(limit) + swipedIds.length + 1);

    if (lastId) {
      const lastDoc = await db.collection('listings').doc(lastId).get();
      if (lastDoc.exists) q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    const listings = snap.docs
      .filter(d => !swipedIds.includes(d.id) && d.data().sellerId !== uid)
      .slice(0, parseInt(limit))
      .map(d => ({
        id:          d.id,
        industry:    d.data().industry,
        emoji:       d.data().emoji,
        bannerColor: d.data().bannerColor,
        accentColor: d.data().accentColor,
        location:    d.data().location,
        type:        d.data().type,
        age:         d.data().age,
        employees:   d.data().employees,
        turnover:    d.data().turnover,
        askingPrice: d.data().askingPrice,
        profitStatus:d.data().profitStatus,
        hasDebt:     d.data().hasDebt,
        tags:        d.data().tags,
        interested:  d.data().interested,
        // businessName HIDDEN until match
      }));

    return reply.send({ success:true, listings, hasMore: snap.docs.length > parseInt(limit) });
  });

  // Increment view count
  fastify.post('/:listingId/view', { preHandler: verifyToken }, async (req, reply) => {
    await db.collection('listings').doc(req.params.listingId).update({
      views: FieldValue.increment(1),
    });
    return reply.send({ success:true });
  });

  // Get seller's own listing status
  fastify.get('/my-listing', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const snap = await db.collection('listings').where('sellerId','==',uid).limit(1).get();
    if (snap.empty) return reply.send({ success:true, listing:null });
    const d = snap.docs[0];
    return reply.send({ success:true, listing:{ id:d.id, ...d.data() } });
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
