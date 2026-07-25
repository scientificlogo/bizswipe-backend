'use strict';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE    = 100; // Expo batch limit

// Split array into chunks
const chunk = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

// ── Send to single user ───────────────────────────────────────────────────────
const sendPush = async (token, title, body, data = {}) => {
  if (!token) return;
  return sendBatchPush([{ to: token, title, body, data }]);
};

// ── Batch send (handles 100 per request automatically) ───────────────────────
const sendBatchPush = async (messages) => {
  if (!messages?.length) return;

  const batches = chunk(messages, CHUNK_SIZE);
  const results = [];

  for (const batch of batches) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method:  'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body:    JSON.stringify(batch.map(msg => ({
          to:       msg.to,
          title:    msg.title,
          body:     msg.body,
          data:     msg.data    || {},
          sound:    msg.sound   || 'default',
          priority: msg.priority|| 'high',
          badge:    1,
        }))),
      });
      const result = await res.json();
      results.push(result);
    } catch (err) {
      console.error('Expo push batch error:', err.message);
    }
  }

  return results;
};

// ── Notify specific user (fetches token from Firestore) ───────────────────────
const notifyUser = async (db, userId, title, body, data = {}) => {
  if (!userId) return;
  try {
    const snap  = await db.collection('users').doc(userId).get();
    const token = snap.data()?.pushToken;
    if (token) await sendPush(token, title, body, data);
  } catch (err) {
    console.error('notifyUser error:', err.message);
  }
};

// ── Broadcast to multiple users ───────────────────────────────────────────────
const broadcastToUsers = async (db, userIds, title, body, data = {}) => {
  if (!userIds?.length) return;
  const docs = await Promise.all(userIds.map(uid => db.collection('users').doc(uid).get()));
  const messages = docs
    .map(doc => doc.data()?.pushToken)
    .filter(Boolean)
    .map(to => ({ to, title, body, data }));
  return sendBatchPush(messages);
};

module.exports = { sendPush, sendBatchPush, notifyUser, broadcastToUsers };
