'use strict';

const Bull = require('bull');

// ── Parse Upstash Redis URL for Bull (needs TLS) ──────────────────────────────
const parseRedisUrl = (url) => {
  try {
    const parsed = new URL(url);
    return {
      host:     parsed.hostname,
      port:     parseInt(parsed.port) || 6379,
      password: parsed.password || parsed.username,
      tls:      { rejectUnauthorized: false }, // Required for Upstash
    };
  } catch {
    return null;
  }
};

const redisConfig = parseRedisUrl(process.env.UPSTASH_REDIS_URL || '');

// ── Queue Options ──────────────────────────────────────────────────────────────
const queueOptions = redisConfig ? {
  redis: redisConfig,
  defaultJobOptions: {
    attempts:          3,    // Retry 3 times on failure
    backoff: {
      type:  'exponential',
      delay: 2000,           // 2s, 4s, 8s
    },
    removeOnComplete: 100,   // Keep last 100 completed jobs
    removeOnFail:     50,    // Keep last 50 failed jobs
    timeout:          30000, // 30 second timeout per job
  },
} : null;

// ── Queues ─────────────────────────────────────────────────────────────────────
let notificationQueue = null;
let auditQueue        = null;

if (queueOptions) {
  try {
    // Push notification queue
    notificationQueue = new Bull('notifications', queueOptions);

    // Admin audit log queue
    auditQueue = new Bull('audit-logs', queueOptions);

    console.log('✅ Bull queues initialized');
  } catch (err) {
    console.error('❌ Bull queue init failed:', err.message);
  }
} else {
  console.warn('⚠️  Bull queues disabled — no Redis config');
}

// ── Job Types ──────────────────────────────────────────────────────────────────
const JOB = {
  SEND_PUSH:    'send_push',
  SEND_BATCH:   'send_batch_push',
  AUDIT_LOG:    'audit_log',
};

// ── Add push notification job ─────────────────────────────────────────────────
const addPushJob = async (userId, title, body, data = {}) => {
  if (!notificationQueue) {
    // Fallback: fire and forget without queue
    const { notifyUser } = require('./pushNotification');
    const { db } = require('../config/firebase');
    setImmediate(() => notifyUser(db, userId, title, body, data).catch(() => {}));
    return;
  }
  try {
    await notificationQueue.add(JOB.SEND_PUSH, {
      userId, title, body, data,
      addedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to add push job:', err.message);
    // Fallback
    const { notifyUser } = require('./pushNotification');
    const { db } = require('../config/firebase');
    setImmediate(() => notifyUser(db, userId, title, body, data).catch(() => {}));
  }
};

// ── Add audit log job ─────────────────────────────────────────────────────────
const addAuditLog = async (adminId, action, targetId, targetType, details = {}) => {
  if (!auditQueue) {
    // Fallback: write directly
    const { db }         = require('../config/firebase');
    const { FieldValue } = require('firebase-admin/firestore');
    setImmediate(() => {
      db.collection('adminActions').add({
        adminId, action, targetId, targetType, details,
        createdAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
    });
    return;
  }
  try {
    await auditQueue.add(JOB.AUDIT_LOG, {
      adminId, action, targetId, targetType, details,
      addedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to add audit job:', err.message);
  }
};

module.exports = {
  notificationQueue,
  auditQueue,
  addPushJob,
  addAuditLog,
  JOB,
};
