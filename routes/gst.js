'use strict';

const { verifyToken }  = require('../middleware/auth');
const { verifyGST: verifyGSTSchema } = require('../schemas');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;

// Test GST numbers for development
const TEST_GSTIN = {
  '27AABCU9603R1ZP': { businessName:'Demo Company Pvt Ltd',    state:'Maharashtra', status:'Active', isTestMode:true },
  '27AABCS1429B1Z6': { businessName:'Sample LLP Pune',          state:'Maharashtra', status:'Active', isTestMode:true },
  '29AABCU9603R1ZN': { businessName:'Test Bangalore Company',   state:'Karnataka',   status:'Active', isTestMode:true },
};

module.exports = async (fastify) => {

  fastify.post('/gst', {
    preHandler: verifyToken,
    schema:     verifyGSTSchema,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { gstin } = req.body;

    req.log.info({ gstin, userId: req.user.uid, requestId: req.id }, 'GST verify requested');

    // Test mode
    if (TEST_GSTIN[gstin]) {
      return reply.send({ success: true, ...TEST_GSTIN[gstin] });
    }

    // Real API call
    try {
      const response = await fetch(
        `https://gst-verification-api-get-profile-returns-data.p.rapidapi.com/gstin/${gstin}`,
        {
          method:  'GET',
          headers: {
            'X-RapidAPI-Key':  RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST,
          },
        }
      );

      if (!response.ok) {
        req.log.warn({ gstin, status: response.status, requestId: req.id }, 'GST API error');
        return reply.code(422).send({
          success:   false,
          error:     'GST number not found or invalid',
          requestId: req.id,
        });
      }

      const data = await response.json();

      return reply.send({
        success:      true,
        businessName: data.tradeName || data.legalName || 'Business',
        state:        data.stateName || 'India',
        status:       data.status    || 'Active',
        isTestMode:   false,
      });

    } catch (err) {
      req.log.error({ err, gstin, requestId: req.id }, 'GST API call failed');
      return reply.code(503).send({
        success:   false,
        error:     'GST verification service unavailable — try again',
        requestId: req.id,
      });
    }
  });
};
