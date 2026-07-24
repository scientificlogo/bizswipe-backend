const { verifyToken }    = require('../middleware/auth');
const { db }             = require('../config/firebase');
const { sanitizeListing } = require('../utils/sanitize');
const { FieldValue }     = require('firebase-admin/firestore');

module.exports = async (fastify) => {

  // Create listing — server validates + sanitizes
  fastify.post('/create', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const data    = req.body;

    // Validation
    if (!data.businessName?.trim()) return reply.code(400).send({ success:false, error:'Business name required' });
    if (!data.industry?.trim())     return reply.code(400).send({ success:false, error:'Industry required' });
    if (!data.city?.trim())         return reply.code(400).send({ success:false, error:'City required' });
    if (!data.askingPrice?.trim())  return reply.code(400).send({ success:false, error:'Asking price required' });

    // Check if seller already has active listing
    const existing = await db.collection('listings')
      .where('sellerId','==', uid)
      .where('status','==','active')
      .limit(1).get();

    if (!existing.empty) {
      return reply.code(409).send({
        success:   false,
        error:     'Ek active listing already hai',
        listingId: existing.docs[0].id,
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
    return reply.send({ success:true, listingId: docRef.id });
  });

  // Get all active listings (paginated)
  fastify.get('/feed', { preHandler: verifyToken }, async (req, reply) => {
    const { uid }         = req.user;
    const { limit=20, lastId } = req.query;

    // Already swiped IDs fetch karo
    const swipedSnap = await db.collection('swipes')
      .where('buyerId','==',uid).get();
    const swipedIds  = swipedSnap.docs.map(d => d.data().listingId);

    // Listings fetch karo
    let q = db.collection('listings')
      .where('status','==','active')
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
};
