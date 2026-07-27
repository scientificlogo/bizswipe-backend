'use strict';

const { db }    = require('../config/firebase');
const cache     = require('../utils/cache');

module.exports = async (fastify) => {

  // ── Basic health check ────────────────────────────────────────────────────
  fastify.get('/health', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    return reply.send({
      status:    'ok',
      app:       'BizSwipe Backend',
      version:   '2.1.0',
      env:       process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      requestId: req.id,
      uptime:    Math.round(process.uptime()),
    });
  });

  // ── Deep health check ─────────────────────────────────────────────────────
  fastify.get('/health/deep', async (req, reply) => {
    const checks = {};
    let allOk    = true;

    // Firestore
    try {
      const start = Date.now();
      await db.collection('_health').doc('ping').set({ ts: new Date().toISOString() });
      checks.firestore = { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      checks.firestore = { status: 'error', error: err.message };
      allOk = false;
    }

    // Redis
    try {
      const start   = Date.now();
      const isAlive = await cache.ping();
      checks.redis  = isAlive
        ? { status: 'ok', latencyMs: Date.now() - start }
        : { status: 'error', error: 'Ping failed' };
      if (!isAlive) allOk = false;
    } catch (err) {
      checks.redis = { status: 'error', error: err.message };
      // Redis failure is non-critical — don't mark allOk false
    }

    // Memory
    const mem = process.memoryUsage();
    checks.memory = {
      status:      'ok',
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
    };

    // Uptime
    checks.uptime = {
      status:  'ok',
      seconds: Math.round(process.uptime()),
    };

    return reply.code(allOk ? 200 : 503).send({
      status:    allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
      requestId: req.id,
    });
  });
};
