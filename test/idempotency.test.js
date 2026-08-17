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

  // Stands in for the rate limiter, which replies through this same patched
  // reply.send once it is reached.
  app.post('/limited', { preHandler: [fakeAuth, idempotency] }, async (req, reply) => {
    handlerRuns++;
    return reply.code(429).send({ success: false, error: 'Too many requests' });
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

  await t.test('a 429 releases the key instead of being replayed for a day', async () => {
    // The old rule recorded anything under 500 for 24 hours. Since the rate
    // limiter answers through this same reply.send, a seller who tripped
    // "5 listings an hour" had that 429 handed back to them for the rest of the
    // day every time they submitted the same form — the limit outlived its own
    // window by 23 hours.
    const before = handlerRuns;

    const first = await app.inject({ method: 'POST', url: '/limited', payload: BODY });
    assert.equal(first.statusCode, 429);

    const retry = await app.inject({ method: 'POST', url: '/limited', payload: BODY });
    assert.equal(retry.statusCode, 429);
    assert.equal(retry.headers['x-idempotent-replay'], undefined, 'not a cached replay');
    assert.equal(handlerRuns - before, 2, 'the route was reached again');
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
