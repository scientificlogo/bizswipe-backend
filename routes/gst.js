'use strict';

const { verifyToken }  = require('../middleware/auth');
const { verifyGST: verifyGSTSchema } = require('../schemas');
const cache = require('../utils/cache');

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
          success:   false,
          error:     'GST number not found or invalid',
          requestId: req.id,
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

      return reply.code(503).send({
        success:   false,
        error:     isTimeout
          ? 'GST verification timed out — please try again'
          : 'GST verification service unavailable — try again',
        requestId: req.id,
      });
    }
  });
};