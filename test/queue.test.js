'use strict';

// Covers utils/queue.js after the Bull queues were removed. The old version
// enqueued to a queue nothing consumed, so addPushJob resolving successfully
// told you nothing about whether a push had been sent. These tests assert the
// thing that actually matters: the push reaches the push helper, and the audit
// row reaches Firestore.

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

const FIREBASE_PATH  = require.resolve(path.join(ROOT, 'config/firebase.js'));
const PUSH_PATH      = require.resolve(path.join(ROOT, 'utils/pushNotification.js'));
const FIRESTORE_PATH = require.resolve('firebase-admin/firestore');

const stub = (filename, exports) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const added = [];
let addShouldThrow = false;

stub(FIREBASE_PATH, {
  db: {
    collection: (name) => ({
      add: async (doc) => {
        if (addShouldThrow) throw new Error('Firestore unavailable');
        added.push({ collection: name, doc });
        return { id: 'doc-1' };
      },
    }),
  },
});

stub(FIRESTORE_PATH, { FieldValue: { serverTimestamp: () => 'TS' } });

const pushCalls = [];
let pushShouldThrow = false;
stub(PUSH_PATH, {
  notifyUser: async (db, userId, title, body, data) => {
    if (pushShouldThrow) throw new Error('Expo unreachable');
    pushCalls.push({ userId, title, body, data });
    return 'receipt-1';
  },
  sendBatchPush: async () => [],
});

const { addPushJob, addAuditLog } = require(path.join(ROOT, 'utils/queue.js'));

// Both helpers hand the work to setImmediate so the request is not held up.
const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

test('push and audit writes', async (t) => {

  await t.test('a push actually reaches the push helper', async () => {
    pushCalls.length = 0;
    await addPushJob('buyer-1', "It's a Match! 🎉", 'Seller accepted your interest.', {
      type: 'match', matchId: 'm1',
    });
    await settle();

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].userId, 'buyer-1');
    assert.equal(pushCalls[0].title, "It's a Match! 🎉");
    assert.equal(pushCalls[0].data.matchId, 'm1');
  });

  await t.test('the caller is not made to wait on Expo', async () => {
    pushCalls.length = 0;
    await addPushJob('buyer-2', 'Title', 'Body');
    // Resolved already, but the push has not run yet — that is the point.
    assert.equal(pushCalls.length, 0);
    await settle();
    assert.equal(pushCalls.length, 1);
  });

  await t.test('a push with no user id is dropped, not sent', async () => {
    pushCalls.length = 0;
    await addPushJob(null, 'Title', 'Body');
    await addPushJob('someone', null, 'Body');
    await settle();
    assert.equal(pushCalls.length, 0);
  });

  await t.test('a failing push is logged, not thrown at the request handler', async () => {
    pushShouldThrow = true;
    await assert.doesNotReject(() => addPushJob('buyer-3', 'Title', 'Body'));
    await settle();
    pushShouldThrow = false;
  });

  await t.test('an audit row is written to adminActions', async () => {
    added.length = 0;
    await addAuditLog('admin-1', 'listing_approved', 'listing-9', 'listing', { reason: 'ok' });
    await settle();

    assert.equal(added.length, 1);
    assert.equal(added[0].collection, 'adminActions');
    assert.equal(added[0].doc.adminId, 'admin-1');
    assert.equal(added[0].doc.action, 'listing_approved');
    assert.equal(added[0].doc.targetId, 'listing-9');
    assert.equal(added[0].doc.createdAt, 'TS');
  });

  await t.test('an audit row with no action is dropped', async () => {
    added.length = 0;
    await addAuditLog('admin-1', null, 'x', 'listing');
    await settle();
    assert.equal(added.length, 0);
  });

  await t.test('a failing audit write is logged, not thrown', async () => {
    addShouldThrow = true;
    await assert.doesNotReject(() => addAuditLog('admin-1', 'user_banned', 'u1', 'user'));
    await settle();
    addShouldThrow = false;
  });

  await t.test('no Bull queue is exported any more', () => {
    const queue = require(path.join(ROOT, 'utils/queue.js'));
    assert.equal(queue.notificationQueue, null);
    assert.equal(queue.auditQueue, null);
  });
});
