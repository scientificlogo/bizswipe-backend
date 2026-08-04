'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  let serviceAccount;

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const decoded  = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
      if (!serviceAccount.project_id || !serviceAccount.private_key) {
        throw new Error('Firebase credentials missing required fields');
      }
    } else {
      serviceAccount = require('./serviceAccountKey.json');
    }
  } catch (err) {
    console.error('Firebase credentials error:', err.message);
    process.exit(1);
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId:  'bizswipe-a5ac1',
    });
    console.log('Firebase Admin initialized');
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    process.exit(1);
  }
}

const db   = admin.firestore();
const auth = admin.auth();

const checkFirebaseHealth = async () => {
  try {
    const start = Date.now();
    await db.collection('_health').doc('ping').set({ ts: new Date().toISOString() });
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
};

module.exports = { admin, db, auth, checkFirebaseHealth };