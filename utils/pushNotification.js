'use strict';

const EXPO_PUSH_URL    = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const CHUNK_SIZE       = 100;

const chunk = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

const sendBatchPush = async (messages) => {
  if (!messages?.length) return [];
  const receiptIds = [];
  for (const batch of chunk(messages, CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(msg => ({
          to: msg.to, title: msg.title, body: msg.body,
          data: msg.data || {}, sound: 'default', priority: 'high', badge: 1,
        }))),
      });
      const result = await res.json();
      if (result?.data) result.data.forEach(item => { if (item.id) receiptIds.push(item.id); });
    } catch (err) { console.error('Push error:', err.message); }
  }
  return receiptIds;
};

const sendPush = async (token, title, body, data = {}) => {
  if (!token) return null;
  return sendBatchPush([{ to: token, title, body, data }]);
};

const checkReceipts = async (db, receiptIds) => {
  if (!receiptIds?.length) return;
  const invalidTokens = [];
  for (const batch of chunk(receiptIds, CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_RECEIPT_URL, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      const result = await res.json();
      if (result?.data) {
        Object.entries(result.data).forEach(([id, r]) => {
          if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(r.details?.expoPushToken);
          }
        });
      }
    } catch (err) { console.error('Receipt error:', err.message); }
  }
  if (invalidTokens.length > 0 && db) {
    try {
      const snap = await db.collection('users')
        .where('pushToken', 'in', invalidTokens.slice(0, 10)).get();
      const batch = db.batch();
      snap.docs.forEach(doc => batch.update(doc.ref, { pushToken: null }));
      await batch.commit();
      console.log('Removed', snap.docs.length, 'invalid tokens');
    } catch (err) { console.error('Cleanup error:', err.message); }
  }
  return { checked: receiptIds.length, invalidTokens: invalidTokens.length };
};

const notifyUser = async (db, userId, title, body, data = {}) => {
  if (!userId) return null;
  try {
    const snap  = await db.collection('users').doc(userId).get();
    const token = snap.data()?.pushToken;
    if (!token) return null;
    const ids = await sendBatchPush([{ to: token, title, body, data }]);
    return ids?.[0] || null;
  } catch (err) { console.error('notifyUser error:', err.message); return null; }
};

const broadcastToUsers = async (db, userIds, title, body, data = {}) => {
  if (!userIds?.length) return [];
  const docs = await Promise.all(userIds.map(uid => db.collection('users').doc(uid).get()));
  const msgs = docs.map(d => d.data()?.pushToken).filter(Boolean)
    .map(to => ({ to, title, body, data }));
  return sendBatchPush(msgs);
};

module.exports = { sendPush, sendBatchPush, notifyUser, broadcastToUsers, checkReceipts };