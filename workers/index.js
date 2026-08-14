'use strict';

// ── Bull queue processors ─────────────────────────────────────────────────────
//
// This file used to be a stub that logged "Workers ready" and consumed
// nothing. Every job added by utils/queue.js sat in Redis forever: the
// "It's a Match!" push from POST /api/matches/accept, the approve/reject
// pushes, and the whole admin audit trail. The producers reported success
// because Bull's add() succeeded — the jobs just never ran.
//
// The first attempt at this file 502'd the entire API and had to be reverted.
// It attached each queue's 'error' listener AFTER calling process(), and an
// 'error' event on an EventEmitter with no listener is rethrown — which
// server.js turns into process.exit(1) through its uncaughtException handler.
// One Redis hiccup became a restart loop.
//
// So the rules here are: listeners before processors, every setup step inside
// a try/catch, and nothing that can reject on its own. Workers are a
// background convenience. They must never be able to take the API down with
// them, and if Redis will not have them the rest of the server carries on.

const { notificationQueue, auditQueue, JOB } = require('../utils/queue');
const { db }         = require('../config/firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { notifyUser, sendBatchPush } = require('../utils/pushNotification');

// Expo's guidance is to keep concurrent pushes modest, and Upstash charges by
// command, so there is no reason to reach for a big number here.
const PUSH_CONCURRENCY  = 5;
const AUDIT_CONCURRENCY = 5;

let started = false;

// Last error seen per queue, surfaced on /api/health/deep. Without it there is
// no way to tell a working consumer from one that is quietly failing to reach
// Redis — the symptom of both is "the push never arrived".
const lastError = { notifications: null, 'audit-logs': null };

const attachListeners = (queue, name) => {
  queue.on('error', (err) => {
    lastError[name] = err.message;
    console.error(`${name} queue error:`, err.message);
  });
  queue.on('failed', (job, err) => {
    lastError[name] = err.message;
    console.error(
      `${name} job ${job?.id} (${job?.name}) failed on attempt ${job?.attemptsMade}:`,
      err.message,
    );
  });
};

const startWorkers = () => {
  if (started) return;
  started = true;

  if (!notificationQueue && !auditQueue) {
    // utils/queue.js already logged why, and its fallbacks write directly, so
    // pushes and audit rows still happen — there is simply nothing to consume.
    console.warn('⚠️  Workers not started — Bull queues are disabled');
    return;
  }

  try {
    // ── notifications ───────────────────────────────────────────────────────
    if (notificationQueue) {
      attachListeners(notificationQueue, 'notifications');

      notificationQueue.process(JOB.SEND_PUSH, PUSH_CONCURRENCY, async (job) => {
        const { userId, title, body, data } = job.data;
        if (!userId || !title) throw new Error('send_push job missing userId or title');

        // Returns null when the user has no push token — a completed job, not
        // a failure. Retrying would never produce a token.
        const receiptId = await notifyUser(db, userId, title, body, data || {});
        return { userId, delivered: !!receiptId, receiptId };
      });

      notificationQueue.process(JOB.SEND_BATCH, PUSH_CONCURRENCY, async (job) => {
        const { messages } = job.data;
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new Error('send_batch_push job has no messages');
        }
        const receiptIds = await sendBatchPush(messages);
        return { sent: messages.length, receipts: receiptIds.length };
      });
    }

    // ── audit-logs ──────────────────────────────────────────────────────────
    if (auditQueue) {
      attachListeners(auditQueue, 'audit-logs');

      auditQueue.process(JOB.AUDIT_LOG, AUDIT_CONCURRENCY, async (job) => {
        const { adminId, action, targetId, targetType, details } = job.data;
        if (!adminId || !action) throw new Error('audit_log job missing adminId or action');

        const ref = await db.collection('adminActions').add({
          adminId,
          action,
          targetId:   targetId   || null,
          targetType: targetType || null,
          details:    details    || {},
          createdAt:  FieldValue.serverTimestamp(),
        });
        return { id: ref.id };
      });
    }

    console.log('✅ Workers started — processing notifications and audit-logs');
  } catch (err) {
    // Registering a processor failed. The API is already listening and must
    // keep serving; the queue simply goes unconsumed, which /health/deep will
    // show as a climbing `waiting` count.
    console.error('❌ Worker setup failed — API continues without consumers:', err.message);
    lastError.notifications = lastError.notifications || err.message;
  }
};

const stopWorkers = async () => {
  if (!started) return;
  started = false;

  // close() waits for jobs already in flight to finish before releasing the
  // Redis connection, so a push mid-send is not dropped on deploy.
  const closing = [notificationQueue, auditQueue]
    .filter(Boolean)
    .map(q => q.close().catch(err => console.error('Queue close error:', err.message)));

  await Promise.all(closing);
  console.log('Workers stopped');
};

// Counts straight from Bull, for /api/health/deep. A `waiting` count that only
// ever climbs is the signature of the bug this file exists to fix.
const workerStatus = async () => {
  const status = { running: started };

  for (const [name, queue] of [['notifications', notificationQueue], ['audit-logs', auditQueue]]) {
    if (!queue) { status[name] = { status: 'disabled' }; continue; }
    try {
      const counts = await queue.getJobCounts();
      status[name] = {
        status:    lastError[name] ? 'degraded' : 'ok',
        waiting:   counts.waiting,
        active:    counts.active,
        completed: counts.completed,
        failed:    counts.failed,
        delayed:   counts.delayed,
        lastError: lastError[name] || undefined,
      };
    } catch (err) {
      status[name] = { status: 'error', error: err.message };
    }
  }

  return status;
};

module.exports = { startWorkers, stopWorkers, workerStatus };
