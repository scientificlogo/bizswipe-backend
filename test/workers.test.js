'use strict';

// Covers workers/index.js, which until now was a stub that consumed nothing —
// every job utils/queue.js added sat in Redis forever while the producer
// reported success. Bull, Firebase Admin and the push helper are all stubbed,
// so no Redis and no network is needed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

const QUEUE_PATH     = require.resolve(path.join(ROOT, 'utils/queue.js'));
const FIREBASE_PATH  = require.resolve(path.join(ROOT, 'config/firebase.js'));
const PUSH_PATH      = require.resolve(path.join(ROOT, 'utils/pushNotification.js'));
const FIRESTORE_PATH = require.resolve('firebase-admin/firestore');

const stub = (filename, exports) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// ── Fake Bull queue ──────────────────────────────────────────────────────────
const makeQueue = () => {
  const processors = new Map();
  const handlers   = new Map();
  return {
    processors,
    handlers,
    closed: false,
    process: (name, concurrency, fn) => { processors.set(name, { concurrency, fn }); },
    on:      (event, fn) => { handlers.set(event, fn); },
    close:   async function () { this.closed = true; },
    run:     (name, data) => processors.get(name).fn({ id: 1, name, data }),
  };
};

const notificationQueue = makeQueue();
const auditQueue        = makeQueue();

stub(QUEUE_PATH, {
  notificationQueue,
  auditQueue,
  JOB: { SEND_PUSH: 'send_push', SEND_BATCH: 'send_batch_push', AUDIT_LOG: 'audit_log' },
});

const added = [];
stub(FIREBASE_PATH, {
  db: {
    collection: (name) => ({
      add: async (doc) => { added.push({ collection: name, doc }); return { id: 'doc-1' }; },
    }),
  },
});

stub(FIRESTORE_PATH, { FieldValue: { serverTimestamp: () => 'TS' } });

const pushCalls  = [];
const batchCalls = [];
stub(PUSH_PATH, {
  notifyUser: async (db, userId, title, body, data) => {
    pushCalls.push({ userId, title, body, data });
    // Mirrors the real helper: null when the user has no push token.
    return userId === 'no-token-user' ? null : 'receipt-1';
  },
  sendBatchPush: async (messages) => { batchCalls.push(messages); return messages.map(() => 'r'); },
});

const { startWorkers, stopWorkers } = require(path.join(ROOT, 'workers/index.js'));

test('bull workers', async (t) => {
  startWorkers();

  await t.test('a processor is registered for every job type the app enqueues', () => {
    assert.ok(notificationQueue.processors.has('send_push'));
    assert.ok(notificationQueue.processors.has('send_batch_push'));
    assert.ok(auditQueue.processors.has('audit_log'));
  });

  await t.test('a send_push job reaches the push helper', async () => {
    pushCalls.length = 0;
    const result = await notificationQueue.run('send_push', {
      userId: 'buyer-1',
      title:  "It's a Match! 🎉",
      body:   'Seller accepted your interest.',
      data:   { type: 'match', matchId: 'm1' },
    });

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].userId, 'buyer-1');
    assert.equal(pushCalls[0].data.matchId, 'm1');
    assert.deepEqual(result, { userId: 'buyer-1', delivered: true, receiptId: 'receipt-1' });
  });

  await t.test('a user with no push token completes rather than retrying forever', async () => {
    const result = await notificationQueue.run('send_push', {
      userId: 'no-token-user', title: 'Hi', body: 'there',
    });
    assert.equal(result.delivered, false);
  });

  await t.test('a malformed push job fails loudly instead of silently doing nothing', async () => {
    await assert.rejects(
      () => notificationQueue.run('send_push', { title: 'no user id' }),
      /missing userId/,
    );
  });

  await t.test('a batch push job forwards every message', async () => {
    batchCalls.length = 0;
    const result = await notificationQueue.run('send_batch_push', {
      messages: [{ to: 'a', title: 't', body: 'b' }, { to: 'b', title: 't', body: 'b' }],
    });
    assert.equal(batchCalls[0].length, 2);
    assert.deepEqual(result, { sent: 2, receipts: 2 });
  });

  await t.test('an empty batch is rejected', async () => {
    await assert.rejects(
      () => notificationQueue.run('send_batch_push', { messages: [] }),
      /no messages/,
    );
  });

  await t.test('an audit job writes the adminActions document', async () => {
    added.length = 0;
    const result = await auditQueue.run('audit_log', {
      adminId: 'admin-1', action: 'listing_approved',
      targetId: 'listing-9', targetType: 'listing', details: { reason: 'ok' },
    });

    assert.equal(added.length, 1);
    assert.equal(added[0].collection, 'adminActions');
    assert.equal(added[0].doc.adminId, 'admin-1');
    assert.equal(added[0].doc.action, 'listing_approved');
    assert.equal(added[0].doc.createdAt, 'TS');
    assert.deepEqual(result, { id: 'doc-1' });
  });

  await t.test('an audit job with no action is rejected', async () => {
    await assert.rejects(
      () => auditQueue.run('audit_log', { adminId: 'admin-1' }),
      /missing adminId or action/,
    );
  });

  await t.test('a failed handler is attached so failures are not swallowed', () => {
    assert.equal(typeof notificationQueue.handlers.get('failed'), 'function');
    assert.equal(typeof auditQueue.handlers.get('failed'), 'function');
  });

  await t.test('starting twice does not register a second set of processors', () => {
    const before = notificationQueue.processors.get('send_push');
    startWorkers();
    assert.equal(notificationQueue.processors.get('send_push'), before);
  });

  await t.test('shutdown closes both queues', async () => {
    await stopWorkers();
    assert.equal(notificationQueue.closed, true);
    assert.equal(auditQueue.closed, true);
  });
});
