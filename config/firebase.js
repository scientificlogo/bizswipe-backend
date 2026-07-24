const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./serviceAccountKey.json');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  'bizswipe-a5ac1',
  });
}

module.exports = {
  admin,
  db:   admin.firestore(),
  auth: admin.auth(),
};
