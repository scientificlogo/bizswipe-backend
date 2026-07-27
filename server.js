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
  bodyLimit:  10 * 1024, // Fix #14 — 10KB max
});

// ── 3. Swagger (Fix #10 — API Docs) ──────────────────────────────────────────
fastify.register(require('@fastify/swagger'), {
  openapi: {
    info: {
      title:       'BizSwipe API',
      description: "India's first Tinder-style Business M&A Platform API",
      version:     '2.1.0',
      contact: {
        name: 'BizSwipe Support',
        email: 'support@bizswipe.app',
      },
    },
    servers: [
      { url: 'https://bizswipe-backend-production.up.railway.app', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local Development' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type:         'http',
          scheme:       'bearer',
          bearerFormat: 'JWT',
          description:  'Firebase ID Token — get from Firebase Auth',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Health',        description: 'Server health checks' },
      { name: 'Auth/GST',      description: 'GST verification' },
      { name: 'Listings',      description: 'Business listing management' },
      { name: 'Matches',       description: 'Match and interest management' },
      { name: 'Messages',      description: 'Chat messages' },
      { name: 'Notifications', description: 'Push notifications' },
      { name: 'Admin',         description: 'Admin-only endpoints' },
    ],
  },
});

fastify.register(require('@fastify/swagger-ui'), {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion:           'list',
    deepLinking:            true,
    displayRequestDuration: true,
    filter:                 true,
  },
  staticCSP: true,
});

// ── 4. Plugins ────────────────────────────────────────────────────────────────
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

// ── 5. Request ID in every response ──────────────────────────────────────────
fastify.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-Id', request.id);
});

// ── 6. Global Error Handler ───────────────────────────────────────────────────
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

  if (error.statusCode === 413) {
    return reply.code(413).send({
      success:   false,
      error:     'Request body too large (max 10KB)',
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

// ── 7. 404 Handler ────────────────────────────────────────────────────────────
fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    success:   false,
    error:     `Route ${request.method} ${request.url} not found`,
    requestId: request.id,
  });
});

// ── 8. Routes v1 ─────────────────────────────────────────────────────────────
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

// ── 9. Legacy routes /api ─────────────────────────────────────────────────────
fastify.register(require('./routes/health'),        { prefix: '/api' });
fastify.register(require('./routes/gst'),           { prefix: '/api/verify' });
fastify.register(require('./routes/listings'),      { prefix: '/api/listings' });
fastify.register(require('./routes/swipe'),         { prefix: '/api/swipe' });
fastify.register(require('./routes/matches'),       { prefix: '/api/matches' });
fastify.register(require('./routes/notifications'), { prefix: '/api/notifications' });
fastify.register(require('./routes/messages'),      { prefix: '/api/messages' });
fastify.register(require('./routes/admin'),         { prefix: '/api/admin' });

// ── 10. Graceful Shutdown ─────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  fastify.log.info({ signal }, 'Shutdown received');
  try {
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

// ── 11. Start ─────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({
      port: parseInt(process.env.PORT) || 3000,
      host: '0.0.0.0',
    });

    const { startWorkers } = require('./workers');
    startWorkers();

    fastify.log.info({
      env:     process.env.NODE_ENV,
      port:    process.env.PORT || 3000,
      version: '2.1.0',
      docs:    'https://bizswipe-backend-production.up.railway.app/docs',
    }, 'BizSwipe Backend started');

  } catch (err) {
    fastify.log.error(err, 'Failed to start');
    process.exit(1);
  }
};

start();