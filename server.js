'use strict';

const crypto = require('crypto');

// ── 1. ENV VALIDATION FIRST ───────────────────────────────────────────────────
require('./config/env');

// ── 2. Fastify ────────────────────────────────────────────────────────────────
const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    serializers: {
      req(req) {
        return {
          method:    req.method,
          url:       req.url,
          requestId: req.id,
          userId:    req.user?.uid || 'unauthenticated',
        };
      },
    },
  },
  trustProxy: true,
  genReqId:   () => crypto.randomUUID(),
});

// Fix #14 — Request body size limit (10KB max)
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string', bodyLimit: 10 * 1024 },
  (req, body, done) => {
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

// ── 3. Plugins ────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/cors'), {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://bizswipe.app', /^exp:\/\//]
    : true,
  methods:        ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
});

fastify.register(require('@fastify/helmet'), { contentSecurityPolicy: false });

fastify.register(require('@fastify/rate-limit'), {
  global:     true,
  max:        100,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.user?.uid || req.headers['x-forwarded-for'] || req.ip,
  errorResponseBuilder: (req) => ({
    success:    false,
    error:      'Too many requests — please try again in 1 minute',
    requestId:  req.id,
    statusCode: 429,
  }),
});

// ── 4. Request ID in every response ──────────────────────────────────────────
fastify.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-Id', request.id);
});

// ── 5. Global Error Handler ───────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  const { AppError } = require('./utils/errors');

  request.log.error({
    err:       { message: error.message, stack: error.stack, code: error.code },
    requestId: request.id,
    url:       request.url,
    method:    request.method,
    userId:    request.user?.uid,
  }, 'Request error');

  if (error.validation) {
    return reply.code(400).send({
      success:   false,
      error:     'Validation failed',
      details:   error.validation.map(v => `${v.instancePath} ${v.message}`.trim()),
      requestId: request.id,
    });
  }

  if (error instanceof AppError) {
    return reply.code(error.statusCode).send({
      success:   false,
      error:     error.message,
      code:      error.code,
      requestId: request.id,
    });
  }

  reply.code(error.statusCode || 500).send({
    success:   false,
    error:     (error.statusCode && error.statusCode < 500) ? error.message : 'Internal server error',
    requestId: request.id,
  });
});

// ── 6. 404 Handler ────────────────────────────────────────────────────────────
fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    success:   false,
    error:     `Route ${request.method} ${request.url} not found`,
    requestId: request.id,
  });
});

// ── 7. Routes v1 ─────────────────────────────────────────────────────────────
fastify.register(async (app) => {
  app.register(require('./routes/health'),        { prefix: '/health' });
  app.register(require('./routes/gst'),           { prefix: '/verify' });
  app.register(require('./routes/listings'),      { prefix: '/listings' });
  app.register(require('./routes/swipe'),         { prefix: '/swipe' });
  app.register(require('./routes/matches'),       { prefix: '/matches' });
  app.register(require('./routes/notifications'), { prefix: '/notifications' });
  app.register(require('./routes/messages'),      { prefix: '/messages' });
  app.register(require('./routes/admin'),         { prefix: '/admin' });
}, { prefix: '/api/v1' });

// ── 8. Legacy routes /api ─────────────────────────────────────────────────────
fastify.register(require('./routes/health'),        { prefix: '/api' });
fastify.register(require('./routes/gst'),           { prefix: '/api/verify' });
fastify.register(require('./routes/listings'),      { prefix: '/api/listings' });
fastify.register(require('./routes/swipe'),         { prefix: '/api/swipe' });
fastify.register(require('./routes/matches'),       { prefix: '/api/matches' });
fastify.register(require('./routes/notifications'), { prefix: '/api/notifications' });
fastify.register(require('./routes/messages'),      { prefix: '/api/messages' });
fastify.register(require('./routes/admin'),         { prefix: '/api/admin' });

// ── 9. Graceful Shutdown ──────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  fastify.log.info({ signal }, 'Shutdown received');
  try {
    // Stop Bull workers first
    const { stopWorkers } = require('./workers');
    await stopWorkers();
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, 'Shutdown error');
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  fastify.log.error({ err }, 'UNCAUGHT EXCEPTION');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'UNHANDLED REJECTION');
  process.exit(1);
});

// ── 10. Start ─────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({
      port: parseInt(process.env.PORT) || 3000,
      host: '0.0.0.0',
    });

    // Start background workers AFTER server is listening
    const { startWorkers } = require('./workers');
    startWorkers();

    fastify.log.info({
      env:     process.env.NODE_ENV,
      port:    process.env.PORT || 3000,
      version: '2.1.0',
    }, 'BizSwipe Backend started');

  } catch (err) {
    fastify.log.error(err, 'Failed to start');
    process.exit(1);
  }
};

start();
