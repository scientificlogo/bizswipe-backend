const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');
const { FieldValue }  = require('firebase-admin/firestore');
const cache           = require('../utils/cache');

// Per-user swipe rate limiter (max 50 swipes per minute)
const swipeMap = new Map();
const isRateLimited = (uid) => {
  const now  = Date.now();
  const list = (swipeMap.get(uid) || []).filter(t => now-t < 60000);
  if (list.length >= 50) return true;
  list.push(now);
  swipeMap.set(uid, list);
  return false;
};
setInterval(() => swipeMap.clear(), 5*60*1000);

module.exports = async (fastify) => {
  fastify.post('/', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const { listingId, direction } = req.body;

    if (!listingId || !['left','right'].includes(direction)) {
      return reply.code(400).send({ success:false, error:'listingId and direction (left/right) required' });
    }

    // Rate limit check
    if (isRateLimited(uid)) {
      return reply.code(429).send({ success:false, error:'Bahut fast swipe kar rahe ho — thoda slow karo!' });
    }

    // Duplicate swipe check
    const existing = await db.collection('swipes')
      .where('buyerId','==',uid)
      .where('listingId','==',listingId)
      .limit(1).get();
    
    if (!existing.empty) {
      return reply.send({ success:true, message:'Already swiped', duplicate:true });
    }

    // Get listing
    const listingDoc = await db.collection('listings').doc(listingId).get();
    if (!listingDoc.exists || listingDoc.data().status !== 'active') {
      return reply.code(404).send({ success:false, error:'Listing not found' });
    }
    const listing = listingDoc.data();

    // Get buyer profile
    const buyerDoc = await db.collection('users').doc(uid).get();
    const buyer    = buyerDoc.data() || {};

    // Save swipe
    await db.collection('swipes').add({
      buyerId:   uid,
      buyerName: buyer.name || 'Buyer',
      listingId,
      sellerId:  listing.sellerId,
      direction,
      createdAt: FieldValue.serverTimestamp(),
    });

    let interestId = null;

    // Right swipe — create interest + send notification
    if (direction === 'right') {
      // Duplicate interest check
      const existingInterest = await db.collection('interests')
        .where('buyerId','==',uid)
        .where('listingId','==',listingId)
        .limit(1).get();

      if (existingInterest.empty) {
        const interestRef = await db.collection('interests').add({
          buyerId:     uid,
          buyerName:   buyer.name || 'Buyer',
          buyerPhone:  buyer.phone || '',
          buyerCity:   buyer.city  || '',
          buyerBudget: buyer.buyerPreferences?.budget?.[0] || '',
          listingId,
          listingName: listing.businessName,
          sellerId:    listing.sellerId,
          status:      'pending',
          createdAt:   FieldValue.serverTimestamp(),
        });
        interestId = interestRef.id;

        // Increment interested count
        await db.collection('listings').doc(listingId).update({
          interested: FieldValue.increment(1),
        });

        // Send push notification to seller
        const sellerDoc  = await db.collection('users').doc(listing.sellerId).get();
        const pushToken  = sellerDoc.data()?.pushToken;
        if (pushToken) {
          await sendExpoPush(pushToken, '🔥 Naya Interest!',
            `${buyer.name || 'Ek buyer'} ne tumhari listing like ki!`,
            { screen: 'SellerHome' }
          );
        }
      }
    }

    // The feed's first page is cached per user for five minutes and the swiped
    // listing is filtered out at build time — without this the card the buyer
    // just swiped comes straight back on the next fetch.
    setImmediate(() => cache.delPattern(`feed:${uid}:*`));

    return reply.send({ success:true, direction, interestId });
  });
};

// Expo Push helper
const sendExpoPush = async (token, title, body, data={}) => {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify({ to:token, sound:'default', title, body, data, priority:'high' }),
    });
  } catch(e) { console.log('Push error:', e.message); }
};
