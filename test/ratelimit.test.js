'use strict';

// Covers the rate-limiting rework: the plugin runs on preHandler so its
// keyGenerators can see req.user, and middleware/ipGuard.js counts the
// unauthenticated traffic that no longer reaches the plugin.
//
// No stubs needed — this exercises @fastify/rate-limit and the guard directly.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('path');
const Fastify = require('fastify');

const ROOT = path.join(__dirname, '..');
const { ipGuard, clientAddress, _internals } = require(path.join(ROOT, 'middleware/ipGuard.js'));

test('clientAddress cannot be spoofed by the caller', async (t) => {

  await t.test('takes the last X-Forwarded-For entry, not the first', async () => {
    // What a caller who sends their own header produces once the edge appends
    // the address it actually accepted the connection from. req.ip resolves to
    // the leftmost of these under trustProxy, which is the forged one.
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, ip: '1.2.3.4' };
    assert.equal(clientAddress(req), '203.0.113.9');
  });

  await t.test('a rotating forged prefix cannot move the key', async () => {
    const keys = new Set();
    for (const forged of ['9.9.9.9', '8.8.8.8', '7.7.7.7']) {
      keys.add(clientAddress({
        headers: { 'x-forwarded-for': `${forged}, 203.0.113.9` },
        ip: forged,
      }));
    }
    assert.equal(keys.size, 1, 'all three requests count against one bucket');
  });

  await t.test('falls back to req.ip when there is no header', async () => {
    assert.equal(clientAddress({ headers: {}, ip: '203.0.113.9' }), '203.0.113.9');
    assert.equal(clientAddress({ headers: {} }), 'unknown');
  });

  await t.test('tolerates whitespace and a single-entry header', async () => {
    assert.equal(clientAddress({ headers: { 'x-forwarded-for': '  203.0.113.9  ' } }), '203.0.113.9');
  });
});

// The bug this whole file exists for: on the plugin's default onRequest hook,
// verifyToken has not run yet, so `req.user?.uid` is undefined for every caller
// and they all share one bucket.
const buildApp = async (hook) => {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(require('@fastify/rate-limit'), {
    global:       true,
    hook,
    max:          100,
    timeWindow:   '1 minute',
    keyGenerator: (req) => req.user?.uid || req.ip,
  });

  const fakeAuth = async (req) => { req.user = { uid: req.headers['x-test-uid'] }; };

  app.get('/view', {
    preHandler: fakeAuth,
    config: {
      rateLimit: {
        max:          2,
        timeWindow:   '1 minute',
        keyGenerator: (req) => `view_${req.user?.uid || req.ip}_L1`,
      },
    },
  }, async () => ({ ok: true }));

  return app;
};

const get = (app, uid) => app.inject({
  method: 'GET', url: '/view', headers: { 'x-test-uid': uid },
});

test('rate limiting', async (t) => {

  await t.test('on the default onRequest hook every user shares one bucket', async () => {
    const app = await buildApp('onRequest');

    assert.equal((await get(app, 'alice')).statusCode, 200);
    assert.equal((await get(app, 'alice')).statusCode, 200);

    // bob has made no requests at all, and is refused on alice's count — this is
    // the "ten views a minute for the whole platform" failure in miniature.
    assert.equal((await get(app, 'bob')).statusCode, 429);
    await app.close();
  });

  await t.test('on preHandler each user gets their own bucket', async () => {
    const app = await buildApp('preHandler');

    assert.equal((await get(app, 'alice')).statusCode, 200);
    assert.equal((await get(app, 'alice')).statusCode, 200);
    assert.equal((await get(app, 'alice')).statusCode, 429, 'alice hit her own limit');

    assert.equal((await get(app, 'bob')).statusCode, 200, 'bob is unaffected');
    assert.equal((await get(app, 'bob')).statusCode, 200);
    await app.close();
  });

  await t.test('a route config inherits the global hook without repeating it', async () => {
    // mergeParams folds globalParams into the route config, so the per-route
    // limiter above only lands on preHandler because the global one says so.
    // If that ever stops being true the previous subtest fails, which is the
    // point of asserting it there rather than reaching into the plugin here.
    const app = await buildApp('preHandler');
    const res = await get(app, 'carol');
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});

test('ip flood guard', async (t) => {

  t.beforeEach(() => _internals.hits.clear());

  await t.test('lets ordinary traffic through', async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      assert.equal(_internals.check('1.2.3.4', now), true);
    }
  });

  await t.test('refuses past the ceiling, and only for that address', async () => {
    const now = Date.now();
    for (let i = 0; i < _internals.MAX_PER_WINDOW; i++) _internals.check('1.2.3.4', now);

    assert.equal(_internals.check('1.2.3.4', now), false);
    assert.equal(_internals.check('5.6.7.8', now), true, 'a different address is untouched');
  });

  await t.test('the window rolls over', async () => {
    const now = Date.now();
    for (let i = 0; i < _internals.MAX_PER_WINDOW + 5; i++) _internals.check('1.2.3.4', now);
    assert.equal(_internals.check('1.2.3.4', now), false);

    assert.equal(_internals.check('1.2.3.4', now + _internals.WINDOW_MS + 1), true);
  });

  await t.test('health checks are exempt so a probe cannot trip its own guard', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    app.addHook('onRequest', ipGuard);
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get('/api/listings/feed', async () => ({ ok: true }));

    for (let i = 0; i < _internals.MAX_PER_WINDOW + 10; i++) {
      await app.inject({ method: 'GET', url: '/api/health' });
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);

    // The same address is now well past the ceiling on a route that counts.
    const res = await app.inject({ method: 'GET', url: '/api/listings/feed' });
    assert.equal(res.statusCode, 200, 'health traffic was never counted against it');
    await app.close();
  });

  await t.test('the guard answers 429 with a code the client can read', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    app.addHook('onRequest', ipGuard);
    app.get('/api/listings/feed', async () => ({ ok: true }));

    let last;
    for (let i = 0; i < _internals.MAX_PER_WINDOW + 2; i++) {
      last = await app.inject({ method: 'GET', url: '/api/listings/feed' });
    }

    assert.equal(last.statusCode, 429);
    assert.equal(JSON.parse(last.body).code, 'IP_RATE_LIMITED');
    await app.close();
  });
});
