'use strict';

// Covers the ban enforcement added to middleware/auth.js.
// Firebase Admin and utils/cache are both stubbed, so no network is needed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

const CACHE_PATH    = require.resolve(path.join(ROOT, 'utils/cache.js'));
const FIREBASE_PATH = require.resolve(path.join(ROOT, 'config/firebase.js'));

const store = new Map();
let firestoreReads = 0;
let userDocs = {};
let firestoreShouldThrow = false;

const stub = (filename, exports) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

stub(CACHE_PATH, {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  set: async (k, v) => { store.set(k, v); },
  del: async (k) => { store.delete(k); },
});

stub(FIREBASE_PATH, {
  auth: {
    verifyIdToken: async (token) => ({ uid: token.replace('token-for-', '') }),
  },
  db: {
    collection: () => ({
      doc: (uid) => ({
        get: async () => {
          firestoreReads++;
          if (firestoreShouldThrow) throw new Error('Firestore unavailable');
          const data = userDocs[uid];
          return { exists: Boolean(data), data: () => data };
        },
      }),
    }),
  },
});

const { verifyToken } = require(path.join(ROOT, 'middleware/auth.js'));
const Fastify = require('fastify');

const build = () => {
  const app = Fastify({ logger: false });
  app.get('/protected', { preHandler: verifyToken }, async (req, reply) =>
    reply.send({ success: true, uid: req.user.uid }));
  return app;
};

const call = (app, uid) => app.inject({
  method:  'GET',
  url:     '/protected',
  headers: { authorization: `Bearer token-for-${uid}` },
});

test('ban enforcement in verifyToken', async (t) => {
  t.beforeEach(() => {
    store.clear();
    firestoreReads = 0;
    firestoreShouldThrow = false;
    userDocs = {
      alice: { banned: false },
      mallory: { banned: true },
    };
  });

  await t.test('a normal user is allowed through', async () => {
    const res = await call(build(), 'alice');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().uid, 'alice');
  });

  await t.test('a banned user is blocked with 403 ACCOUNT_BANNED', async () => {
    const res = await call(build(), 'mallory');
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'ACCOUNT_BANNED');
  });

  await t.test('the not-banned result is cached, not re-read every request', async () => {
    const app = build();
    await call(app, 'alice');
    const afterFirst = firestoreReads;
    await call(app, 'alice');
    await call(app, 'alice');
    assert.equal(firestoreReads, afterFirst, 'later requests must be served from cache');
  });

  await t.test('clearing the cache key makes a new ban take effect immediately', async () => {
    const app = build();
    assert.equal((await call(app, 'alice')).statusCode, 200);

    userDocs.alice = { banned: true };
    assert.equal((await call(app, 'alice')).statusCode, 200, 'still cached as allowed');

    store.delete('banned:alice'); // what the ban route now does
    assert.equal((await call(app, 'alice')).statusCode, 403);
  });

  await t.test('a Firestore failure fails open rather than locking everyone out', async () => {
    firestoreShouldThrow = true;
    const res = await call(build(), 'alice');
    assert.equal(res.statusCode, 200);
  });

  await t.test('a missing or malformed token is still rejected with 401', async () => {
    const app = build();
    assert.equal((await app.inject({ method: 'GET', url: '/protected' })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'GET', url: '/protected', headers: { authorization: 'Bearer x' },
    })).statusCode, 401);
  });
});
