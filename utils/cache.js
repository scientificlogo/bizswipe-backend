'use strict';

const { Redis } = require('@upstash/redis');

// ── Redis Client ──────────────────────────────────────────────────────────────
let redis;
try {
  redis = new Redis({
  url:   process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});
} catch (err) {
  console.error('Redis init failed — caching disabled:', err.message);
}

// ── Cache TTLs (seconds) ──────────────────────────────────────────────────────
const TTL = {
  LISTINGS_FEED: 5  * 60,       // 5 min  — listings change slowly
  USER_PROFILE:  15 * 60,       // 15 min — profile rarely changes
  GST_VERIFY:    24 * 60 * 60,  // 24 hrs — GST data static
  MATCH_LIST:    2  * 60,       // 2 min  — matches update often
  INTERESTS:     1  * 60,       // 1 min  — interests change frequently
};

// ── Cache key generators ──────────────────────────────────────────────────────
const keys = {
  listingsFeed: (uid, limit)  => `feed:${uid}:${limit}`,
  userProfile:  (uid)         => `user:${uid}`,
  gstVerify:    (gstin)       => `gst:${gstin}`,
  matchList:    (uid, role)   => `matches:${uid}:${role}`,
  interests:    (sellerId)    => `interests:${sellerId}`,
};

// ── Get from cache ────────────────────────────────────────────────────────────
const get = async (key) => {
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    return data || null;
  } catch (err) {
    console.error('Cache GET error:', err.message);
    return null; // Fail silently — fallback to Firestore
  }
};

// ── Set in cache ──────────────────────────────────────────────────────────────
const set = async (key, value, ttl = TTL.LISTINGS_FEED) => {
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttl });
  } catch (err) {
    console.error('Cache SET error:', err.message);
    // Never throw — cache failure must not break app
  }
};

// ── Atomic reserve (SET NX EX) ────────────────────────────────────────────────
// Returns true if this caller won the key, false if it already existed.
// Returns null when Redis is unavailable so callers can decide how to degrade.
const setNX = async (key, value, ttl) => {
  if (!redis) return null;
  try {
    const result = await redis.set(key, value, { nx: true, ex: ttl });
    return result === 'OK';
  } catch (err) {
    console.error('Cache SETNX error:', err.message);
    return null; // Unknown — caller decides (idempotency fails open)
  }
};

// ── Delete single key ─────────────────────────────────────────────────────────
const del = async (key) => {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    console.error('Cache DEL error:', err.message);
  }
};

// ── Delete by pattern (invalidate all feed caches) ────────────────────────────
const delPattern = async (pattern) => {
  if (!redis) return;
  try {
    const found = await redis.keys(pattern);
    if (found && found.length > 0) {
      await redis.del(...found);
      console.log(`Cache invalidated: ${found.length} keys matching "${pattern}"`);
    }
  } catch (err) {
    console.error('Cache delPattern error:', err.message);
  }
};

// ── Health check ──────────────────────────────────────────────────────────────
const ping = async () => {
  if (!redis) return false;
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
};

module.exports = { get, set, setNX, del, delPattern, ping, keys, TTL };
