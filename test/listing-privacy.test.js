'use strict';

// GET /listings/:listingId used to answer with `{ ...data, businessName: undefined }`.
// Blanking the one field looked like it protected the seller, but the spread
// carried sellerName, sellerPhone and sellerId out with it — and the feed hands
// every listing id to every buyer, so the ids needed to walk that endpoint were
// never secret.
//
// firebase-admin, utils/cache and the auth middleware are stubbed; no network.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('path');
const Fastify = require('fastify');

const ROOT = path.join(__dirname, '..');

const stub = (filename, exports) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const LISTING = {
  sellerId:     'seller-1',
  sellerName:   'Ramesh Shah',
  sellerPhone:  '+919876543210',
  businessName: 'Shah Textiles Pvt Ltd',
  description:  'Family run since 1994, ask for Ramesh',
  reason:       'Retiring',
  industry:     'Textile',
  location:     'Surat, Gujarat',
  state:        'Gujarat',
  askingPrice:  '2.5 Cr',
  turnover:     '4 Cr',
  status:       'active',
  views:        12,
  interested:   3,
};

let matchExists = false;

stub(require.resolve(path.join(ROOT, 'config/firebase.js')), {
  db: {
    collection: (name) => ({
      doc: () => ({
        get: async () => (name === 'listings'
          ? { exists: true, id: 'L1', data: () => LISTING }
          : { exists: false, data: () => undefined }),
      }),
      where: function () { return this; },
      limit: function () { return this; },
      get:   async () => ({ empty: !matchExists, docs: [] }),
    }),
  },
});

stub(require.resolve(path.join(ROOT, 'utils/cache.js')), {
  get: async () => null, set: async () => {}, del: async () => {},
  delPattern: async () => {}, setNX: async () => true,
  keys: { listingsFeed: () => 'feed' }, TTL: { LISTINGS_FEED: 1 },
});

let CALLER = 'buyer-1';
stub(require.resolve(path.join(ROOT, 'middleware/auth.js')), {
  verifyToken: async (req) => { req.user = { uid: CALLER }; },
  verifyAdmin: async (req) => { req.user = { uid: CALLER }; },
});

const build = async () => {
  const app = Fastify({ logger: false });
  await app.register(require('@fastify/rate-limit'), { global: true, hook: 'preHandler', max: 1000 });
  await app.register(require(path.join(ROOT, 'routes/listings.js')), { prefix: '/listings' });
  return app;
};

const fetchListing = async (app) => {
  const res = await app.inject({ method: 'GET', url: '/listings/L1' });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body).listing;
};

test('GET /listings/:id does not leak the seller', async (t) => {
  const app = await build();

  await t.test('a stranger gets the card fields and nothing identifying', async () => {
    CALLER = 'buyer-1'; matchExists = false;
    const listing = await fetchListing(app);

    for (const field of ['businessName', 'sellerName', 'sellerPhone', 'sellerId', 'description', 'reason']) {
      assert.equal(listing[field], undefined, `${field} must not reach a stranger`);
    }

    // Still useful — this is the same field set the swipe card renders.
    assert.equal(listing.industry, 'Textile');
    assert.equal(listing.askingPrice, '2.5 Cr');
    assert.equal(listing.state, 'Gujarat');
    assert.equal(listing.id, 'L1');
  });

  await t.test('the phone number is nowhere in the serialised body', async () => {
    CALLER = 'buyer-1'; matchExists = false;
    const res = await app.inject({ method: 'GET', url: '/listings/L1' });

    // Asserting on the raw body too: a nested object or a field added to
    // listings later would slip past a property-by-property check.
    assert.equal(res.body.includes('9876543210'), false);
    assert.equal(res.body.includes('Ramesh'), false);
    assert.equal(res.body.includes('Shah Textiles'), false);
  });

  await t.test('a matched buyer does get the identity', async () => {
    CALLER = 'buyer-1'; matchExists = true;
    const listing = await fetchListing(app);

    assert.equal(listing.businessName, 'Shah Textiles Pvt Ltd');
    assert.equal(listing.sellerPhone, '+919876543210');
    assert.equal(listing.description, 'Family run since 1994, ask for Ramesh');
  });

  await t.test('the owner gets their own listing in full', async () => {
    CALLER = 'seller-1'; matchExists = false;
    const listing = await fetchListing(app);

    assert.equal(listing.businessName, 'Shah Textiles Pvt Ltd');
    assert.equal(listing.sellerName, 'Ramesh Shah');
  });

  await app.close();
});
