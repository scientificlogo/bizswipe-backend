'use strict';

// ── Coarse per-IP flood guard ─────────────────────────────────────────────────
//
// @fastify/rate-limit now runs on `preHandler`, which is the only way its
// keyGenerators can see req.user — they run before verifyToken otherwise and
// every "per user" limit in this codebase was silently a per-IP one. The cost
// of that move is that a request with a bad token is rejected by verifyToken
// before the limiter is reached, so nothing counts unauthenticated traffic any
// more.
//
// This fills that hole and nothing else. It is deliberately blunt:
//   • keyed on the LAST entry of X-Forwarded-For — see clientAddress below for
//     why that is the only part of the header a caller cannot forge.
//   • generous enough that it never fires for a real person. Indian mobile
//     carriers put many subscribers behind one CGNAT address, so a whole office
//     or a chunk of a Jio pool can share this bucket; the per-user limits are
//     where actual policy lives.
//   • in-memory, because there is one server process and a flood guard that has
//     to make a network round trip to Redis on every request is not a guard.
//     It resets on deploy, which is fine for what it protects against.
//
// Health checks are exempt: Railway polls them and a restart loop that trips its
// own guard is not a failure mode worth inventing.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 900;      // 15 req/sec sustained from a single address
const SWEEP_MS = 60 * 1000;
const MAX_TRACKED_IPS = 50000;   // memory backstop against a spoofed-source flood

const hits = new Map();

// ── Which address to count ────────────────────────────────────────────────────
// Not req.ip. The server runs with trustProxy: true, which tells Fastify to
// believe the whole X-Forwarded-For chain, and a caller who sends their own
// header gets it prepended: "1.2.3.4, <their real address>". req.ip then resolves
// to the leftmost entry — the one they made up — so a counter keyed on it resets
// on every request. The original global limiter read the raw header and had
// exactly this hole.
//
// The last entry is the one Railway's edge appended when it accepted the
// connection. A client can add entries in front of it; it cannot remove or
// change that one. This assumes a single proxy hop, which is what a Railway
// service is — if another trusted proxy is ever put in front, this becomes that
// proxy's address and the guard degrades to one shared bucket, which fails
// closed and loudly rather than silently letting a flood through.
const clientAddress = (req) => {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',');
    const last  = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return req.ip || 'unknown';
};

const isExempt = (url) => url.startsWith('/api/health') || url.startsWith('/api/v1/health');

// Fixed window, not sliding: one integer per address instead of an array of
// timestamps, which is what keeps this cheap enough to run on every request.
const check = (ip, now) => {
  const entry = hits.get(ip);

  if (!entry || now - entry.start >= WINDOW_MS) {
    if (!entry && hits.size >= MAX_TRACKED_IPS) hits.clear();
    hits.set(ip, { start: now, count: 1 });
    return true;
  }

  entry.count += 1;
  return entry.count <= MAX_PER_WINDOW;
};

const sweep = () => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.start >= WINDOW_MS) hits.delete(ip);
  }
};

const ipGuard = async (req, reply) => {
  if (isExempt(req.url)) return;

  const address = clientAddress(req);

  if (!check(address, Date.now())) {
    req.log.warn({ ip: address, url: req.url, requestId: req.id }, 'IP flood guard tripped');

    return reply.code(429).send({
      success:    false,
      error:      'Too many requests from this network — please try again in a minute',
      code:       'IP_RATE_LIMITED',
      requestId:  req.id,
      statusCode: 429,
    });
  }
};

// unref so the timer never holds the process open during a graceful shutdown.
const timer = setInterval(sweep, SWEEP_MS);
if (timer.unref) timer.unref();

module.exports = {
  ipGuard,
  clientAddress,
  _internals: { hits, check, sweep, MAX_PER_WINDOW, WINDOW_MS },
};
