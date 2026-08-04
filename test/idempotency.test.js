'use strict';

// Run with: npm test   (uses the built-in node:test runner, no dependencies)
//
// utils/cache is stubbed with an in-memory store so these tests need no Redis.

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const ROOT       = path.join(__dirname, '..');
const CACHE_PATH = require.resolve(path.join(ROOT, 'utils/cache.js'));

const store = new Map();

require.cache[CACHE_PATH] = {
  id:       CACHE_PATH,
  filename: CACHE_PATH,
  loaded:   true,
  exports: {
    setNX: async (k, v) => (store.has(k) ? false : (store.set(k, v), true)),
    get:   async (k) => (store.has(k) ? store.get(k) : null),
    set:   async (k, v) => { store.set(k, v); },
    del:   async (k) => { store.delete(k); },
  },
};

const { idempotency } = require(path.join(ROOT, 'middleware/idempotency.js'));
const Fastify = require('fastify');

let handlerRuns = 0;

const build = () => {
  const app = Fastify({ logger: false });
  const fakeAuth = async (req) => { req.user = { uid: 'u1' }; };

  app.post('/create', { preHandler: [fakeAuth, idempotency] }, async (req, reply) =>
    reply.code(201).send({ success: true, listingId: `L${++handlerRuns}` }));

  app.post('/boom', { preHandler: [fakeAuth, idempotency] }, async (req, reply) => {
    handlerRuns++;
    return reply.code(500).send({ success: false });
  });

  return app;
};

const BODY = { businessName: 'Acme' };

test('idempotency middleware', async (t) => {
  const app = build();

  await t.test('first request runs the handler', async () => {
    const res = await app.inject({ method: 'POST', url: '/create', payload: BODY });
    assert.equal(res.statusCode, 201);
    assert.equal(handlerRuns, 1);
  });

  await t.test('identical replay returns the recorded response without re-running', async () => {
    const first  = await app.inject({ method: 'POST', url: '/create', payload: BODY });
    const replay = await app.inject({ method: 'POST', url: '/create', payload: BODY });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.body, first.body);
    assert.equal(replay.headers['x-idempotent-replay'], 'true');
    assert.equal(handlerRuns, 1, 'handler must not run again');
  });

  await t.test('a different body is a different request', async () => {
    const res = await app.inject({ method: 'POST', url: '/create', payload: { businessName: 'Other' } });
    assert.equal(res.statusCode, 201);
    assert.equal(handlerRuns, 2);
  });

  await t.test('an explicit Idempotency-Key takes precedence over the body fingerprint', async () => {
    const headers = { 'idempotency-key': 'abc-123' };
    const first  = await app.inject({ method: 'POST', url: '/create', payload: { businessName: 'Keyed' }, headers });
    const replay = await app.inject({ method: 'POST', url: '/create', payload: { businessName: 'Different' }, headers });
    assert.equal(replay.body, first.body);
    assert.equal(handlerRuns, 3);
  });

  await t.test('a 5xx releases the key so the client can retry', async () => {
    const before = handlerRuns;
    await app.inject({ method: 'POST', url: '/boom', payload: BODY });
    await app.inject({ method: 'POST', url: '/boom', payload: BODY });
    assert.equal(handlerRuns - before, 2);
  });

  await t.test('an oversized Idempotency-Key is rejected', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/create',
      payload: BODY,
      headers: { 'idempotency-key': 'x'.repeat(201) },
    });
    assert.equal(res.statusCode, 400);
  });
});
