'use strict';

// ── Push notifications and audit logging ──────────────────────────────────────
//
// This file used to put both on Bull queues. Nothing ever consumed them:
// workers/index.js was a stub that logged "Workers ready" and registered no
// processor, so every job sat in Redis forever while the producer reported
// success. That had not bitten yet only because the app wrote matches itself —
// the moment accepting an interest went through POST /api/matches/accept, its
// "It's a Match!" push would have gone into that queue and stayed there.
//
// Writing the missing processors was tried twice and took the entire API down
// both times with a 502 restart loop. Producing against this Redis is fine —
// `new Bull(...)` and `add()` have run in production for months — but calling
// `process()` on the same connection kills the node process in a way a
// try/catch around the call does not catch. Upstash does not support the
// blocking consumer Bull needs, and the second attempt ruled out the obvious
// unhandled-'error'-event explanation.
//
// So the queue is gone rather than half-working. Both functions do directly
// what their fallback path already did whenever Redis was unconfigured — code
// that has been exercised in every local run since it was written. What is
// given up is Bull's retry with exponential backoff; a push that fails now is
// logged and dropped, which is what the interest and message pushes have
// always done. Delivery beats a retry policy on jobs nobody runs.
//
// If retries are wanted later, the fix is a queue with a consumer that works
// on this Redis, not a consumer bolted back onto this one.

const { db }         = require('../config/firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { notifyUser } = require('./pushNotification');

// Kept so the shape of a job is still named in one place, and so anything
// still importing JOB does not break.
const JOB = {
  SEND_PUSH:  'send_push',
  SEND_BATCH: 'send_batch_push',
  AUDIT_LOG:  'audit_log',
};

// ── Send a push notification ─────────────────────────────────────────────────
// Returns immediately. The caller is a request handler and must not wait on
// Expo — a slow push should never slow down accepting an interest.
const addPushJob = async (userId, title, body, data = {}) => {
  if (!userId || !title) return;
  setImmediate(() => {
    notifyUser(db, userId, title, body, data).catch(err =>
      console.error('Push failed:', userId, err.message));
  });
};

// ── Write an admin audit row ─────────────────────────────────────────────────
const addAuditLog = async (adminId, action, targetId, targetType, details = {}) => {
  if (!adminId || !action) return;
  setImmediate(() => {
    db.collection('adminActions').add({
      adminId,
      action,
      targetId:   targetId   || null,
      targetType: targetType || null,
      details:    details    || {},
      createdAt:  FieldValue.serverTimestamp(),
    }).catch(err => console.error('Audit write failed:', action, err.message));
  });
};

module.exports = {
  // Both were exported when they were Bull instances. Nothing outside this
  // file ever used them, and there are no queues now.
  notificationQueue: null,
  auditQueue:        null,
  addPushJob,
  addAuditLog,
  JOB,
};
