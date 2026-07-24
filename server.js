const fastify = require('fastify')({ 
  logger: true,
  trustProxy: true,
});

// ── Plugins ───────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/cors'), {
  origin:  process.env.NODE_ENV === 'production' 
    ? ['https://bizswipe.app'] 
    : true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
});

fastify.register(require('@fastify/helmet'), {
  contentSecurityPolicy: false,
});

fastify.register(require('@fastify/rate-limit'), {
  global:  true,
  max:     100,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  errorResponseBuilder: () => ({
    success:    false,
    error:      'Too many requests — 1 minute baad try karo',
    statusCode: 429,
  }),
});

// ── Routes ────────────────────────────────────────────────────────────────────
fastify.register(require('./routes/health'),        { prefix: '/api' });
fastify.register(require('./routes/gst'),           { prefix: '/api/verify' });
fastify.register(require('./routes/listings'),      { prefix: '/api/listings' });
fastify.register(require('./routes/swipe'),         { prefix: '/api/swipe' });
fastify.register(require('./routes/matches'),       { prefix: '/api/matches' });
fastify.register(require('./routes/notifications'), { prefix: '/api/notifications' });

// ── Start ─────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({ 
      port: process.env.PORT || 3000, 
      host: '0.0.0.0' 
    });
    console.log('🚀 BizSwipe Backend running!');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
