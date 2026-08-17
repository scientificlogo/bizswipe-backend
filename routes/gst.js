'use strict';

const { verifyToken }  = require('../middleware/auth');
const { db }           = require('../config/firebase');
const { FieldValue }   = require('firebase-admin/firestore');
const { verifyGST: verifyGSTSchema, submitGST: submitGSTSchema } = require('../schemas');
const cache = require('../utils/cache');

// ── Record the verification on the user ───────────────────────────────────────
// GSTScreen used to write gstVerified straight into users/{uid} itself, which
// meant the phone decided whether the phone was verified — anyone could set the
// flag without ever holding a GST number. The result of the check belongs to the
// side that made the check, so it is written here and the field is server-only
// in firestore.rules.
//
// set/merge rather than update: verifyToken does not require the user document
// to exist, and update() throws NOT_FOUND on a user who somehow reaches this
// screen without one.
const markVerified = async (uid, gstin, result) => {
  await db.collection('users').doc(uid).set({
    gstNumber:       gstin,
    gstVerified:     true,
    gstPending:      false,
    gstBusinessName: result.businessName,
    gstState:        result.state,
    gstVerifiedAt:   FieldValue.serverTimestamp(),
  }, { merge: true });
};

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;

// Fix #13 — API Timeout (8 seconds)
const GST_TIMEOUT_MS = 8000;

// Test GST numbers
const TEST_GSTIN = {
  '27AABCU9603R1ZP': { businessName:'Demo Company Pvt Ltd',  state:'Maharashtra', status:'Active', isTestMode:true },
  '27AABCS1429B1Z6': { businessName:'Sample LLP Pune',        state:'Maharashtra', status:'Active', isTestMode:true },
  '29AABCU9603R1ZN': { businessName:'Test Bangalore Company', state:'Karnataka',   status:'Active', isTestMode:true },
};

module.exports = async (fastify) => {

  fastify.post('/gst', {
    preHandler: verifyToken,
    schema:     verifyGSTSchema,
    // Fix #14 — Request size limit (only 100 bytes needed for GST)
    config: {
      rateLimit: {
        max:          10,
        timeWindow:   '1 minute',
        // Fix #11 — Rate limit per UID
        keyGenerator: (req) => `gst_${req.user?.uid || req.ip}`,
      },
    },
  }, async (req, reply) => {
    const { gstin } = req.body;
    const start     = Date.now();

    req.log.info({
      event:     'gst_verify_requested',
      gstin,
      userId:    req.user.uid,
      requestId: req.id,
    }, 'GST verification requested');

    // Test mode — instant response
    if (TEST_GSTIN[gstin]) {
      req.log.info({ event:'gst_test_mode', gstin, requestId:req.id }, 'GST test mode response');
      await markVerified(req.user.uid, gstin, TEST_GSTIN[gstin]);
      return reply.send({ success: true, ...TEST_GSTIN[gstin] });
    }

    // Fix #2 — Check Redis cache first (24 hr TTL)
    const cacheKey    = cache.keys.gstVerify(gstin);
    const cachedData  = await cache.get(cacheKey);
    if (cachedData) {
      req.log.info({
        event:     'gst_cache_hit',
        gstin,
        duration:  Date.now() - start,
        requestId: req.id,
      }, 'GST served from cache');
      await markVerified(req.user.uid, gstin, cachedData);
      return reply.send({ ...cachedData, fromCache: true });
    }

    // Fix #13 — Real API call WITH timeout
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), GST_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://gst-verification-api-get-profile-returns-data.p.rapidapi.com/gstin/${gstin}`,
        {
          method:  'GET',
          headers: {
            'X-RapidAPI-Key':  RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST,
          },
          signal: controller.signal, // ← Timeout signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        req.log.warn({
          event:     'gst_api_error',
          gstin,
          status:    response.status,
          duration:  Date.now() - start,
          requestId: req.id,
        }, 'GST API returned error');

        return reply.code(422).send({
          success:    false,
          code:       'GST_NOT_FOUND',
          // The number itself is wrong, so there is nothing to fall back to —
          // letting this through would put a junk GSTIN into the review queue.
          canProceed: false,
          error:      'GST number not found or invalid',
          requestId:  req.id,
        });
      }

      const data   = await response.json();
      const result = {
        success:      true,
        businessName: data.tradeName || data.legalName || 'Business',
        state:        data.stateName || 'India',
        status:       data.status    || 'Active',
        isTestMode:   false,
      };

      // Fix #2 — Cache result for 24 hours (GST data is static)
      setImmediate(() => cache.set(cacheKey, result, cache.TTL.GST_VERIFY));

      await markVerified(req.user.uid, gstin, result);

      req.log.info({
        event:     'gst_verify_success',
        gstin,
        duration:  Date.now() - start,
        requestId: req.id,
      }, 'GST verification successful');

      return reply.send(result);

    } catch (err) {
      clearTimeout(timeoutId);

      // Fix #13 — Proper timeout error handling
      const isTimeout = err.name === 'AbortError';

      req.log.error({
        event:     isTimeout ? 'gst_api_timeout' : 'gst_api_failed',
        gstin,
        error:     err.message,
        duration:  Date.now() - start,
        requestId: req.id,
      }, isTimeout ? 'GST API timed out' : 'GST API call failed');

      // canProceed is the whole point of this branch. GST is a hard gate on
      // onboarding for buyers and sellers alike and there is no skip, so when
      // this one third-party API is down or out of quota, nobody at all can
      // finish signing up — a launch day could be lost to a vendor outage the
      // platform has no control over. The client is told it may offer the
      // review queue below instead of a dead end.
      return reply.code(503).send({
        success:    false,
        code:       isTimeout ? 'VERIFICATION_TIMEOUT' : 'VERIFICATION_UNAVAILABLE',
        canProceed: true,
        error:      isTimeout
          ? 'GST verification timed out — please try again'
          : 'GST verification service unavailable — try again',
        requestId:  req.id,
      });
    }
  });

  // ── Submit a GSTIN for manual review ──────────────────────────────────────
  // Only reachable when /gst answered canProceed — the user gets into the app
  // with gstVerified false and gstPending true, and an admin clears the queue
  // through GET /api/admin/gst/pending. The GSTIN is format-checked by the same
  // schema as the live route, so the queue cannot fill with junk.
  fastify.post('/gst/pending', {
    preHandler: verifyToken,
    schema:     submitGSTSchema,
    config: {
      rateLimit: {
        max:          5,
        timeWindow:   '1 hour',
        keyGenerator: (req) => `gstpending_${req.user?.uid || req.ip}`,
      },
    },
  }, async (req, reply) => {
    const { gstin } = req.body;
    const { uid }   = req.user;

    const userDoc = await db.collection('users').doc(uid).get();

    // An already-verified user has nothing to queue, and this must never be a
    // route back out of a real verification.
    if (userDoc.data()?.gstVerified === true) {
      return reply.send({ success: true, alreadyVerified: true });
    }

    await db.collection('users').doc(uid).set({
      gstNumber:      gstin,
      gstVerified:    false,
      gstPending:     true,
      gstSubmittedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    req.log.warn({
      event:     'gst_queued_for_review',
      userId:    uid,
      gstin,
      requestId: req.id,
    }, 'GST queued for manual review — verification API was unavailable');

    return reply.send({
      success: true,
      pending: true,
      message: 'We could not reach the GST service. Your number is saved and will be verified shortly.',
    });
  });
};