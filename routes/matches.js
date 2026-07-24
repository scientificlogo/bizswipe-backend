const { verifyToken } = require('../middleware/auth');
const { db }          = require('../config/firebase');
const { FieldValue }  = require('firebase-admin/firestore');

module.exports = async (fastify) => {

  // Accept interest → create match (SERVER SIDE — secure!)
  fastify.post('/accept', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const { interestId } = req.body;

    if (!interestId) return reply.code(400).send({ success:false, error:'interestId required' });

    // Get interest
    const interestDoc = await db.collection('interests').doc(interestId).get();
    if (!interestDoc.exists) return reply.code(404).send({ success:false, error:'Interest not found' });

    const interest = interestDoc.data();

    // Verify seller is the one accepting
    if (interest.sellerId !== uid) {
      return reply.code(403).send({ success:false, error:'Sirf seller accept kar sakta hai' });
    }

    // Already accepted?
    if (interest.status !== 'pending') {
      return reply.send({ success:true, message:'Already processed', status: interest.status });
    }

    // Duplicate match check
    const existingMatch = await db.collection('matches')
      .where('buyerId','==',interest.buyerId)
      .where('sellerId','==',uid)
      .where('listingId','==',interest.listingId)
      .limit(1).get();

    if (!existingMatch.empty) {
      await interestDoc.ref.update({ status:'accepted' });
      return reply.send({ success:true, matchId: existingMatch.docs[0].id, existing:true });
    }

    // Get seller profile
    const sellerDoc = await db.collection('users').doc(uid).get();
    const seller    = sellerDoc.data() || {};

    // Get listing (to reveal business name)
    const listingDoc = await db.collection('listings').doc(interest.listingId).get();
    const listing    = listingDoc.data() || {};

    // Create match
    const matchRef = await db.collection('matches').add({
      buyerId:      interest.buyerId,
      buyerName:    interest.buyerName,
      buyerPhone:   interest.buyerPhone || '',
      sellerId:     uid,
      sellerName:   seller.name  || 'Seller',
      sellerPhone:  seller.phone || '',
      listingId:    interest.listingId,
      listingName:  interest.listingName || '',
      businessName: listing.businessName || '', // Reveal after match
      createdAt:    FieldValue.serverTimestamp(),
    });

    // Update interest status
    await interestDoc.ref.update({ status:'accepted' });

    // System message
    await db.collection('messages').add({
      matchId:   matchRef.id,
      senderId:  'system',
      text:      `🎉 Match ho gaya! ${interest.buyerName} aur ${seller.name || 'Seller'} ab chat kar sakte hain.`,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Push notification to buyer
    const buyerDoc   = await db.collection('users').doc(interest.buyerId).get();
    const buyerToken = buyerDoc.data()?.pushToken;
    if (buyerToken) {
      await sendExpoPush(
        buyerToken,
        '🎉 Match ho gaya!',
        `${seller.name || 'Seller'} ne tumhara interest accept kiya! Ab chat karo.`,
        { screen:'Matches', matchId: matchRef.id }
      );
    }

    return reply.send({ success:true, matchId: matchRef.id });
  });

  // Decline interest
  fastify.post('/decline', { preHandler: verifyToken }, async (req, reply) => {
    const { uid } = req.user;
    const { interestId } = req.body;

    const interestDoc = await db.collection('interests').doc(interestId).get();
    if (!interestDoc.exists) return reply.code(404).send({ success:false, error:'Not found' });
    if (interestDoc.data().sellerId !== uid) return reply.code(403).send({ success:false, error:'Unauthorized' });

    await interestDoc.ref.update({ status:'declined' });
    return reply.send({ success:true });
  });

  // Get matches for user
  fastify.get('/', { preHandler: verifyToken }, async (req, reply) => {
    const { uid }  = req.user;
    const { role } = req.query;

    const field = role === 'seller' ? 'sellerId' : 'buyerId';
    const snap  = await db.collection('matches')
      .where(field,'==',uid)
      .orderBy('createdAt','desc')
      .get();

    return reply.send({
      success: true,
      matches: snap.docs.map(d => ({ id:d.id, ...d.data() })),
    });
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
