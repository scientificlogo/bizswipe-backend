'use strict';

// ── Bull queue processors ─────────────────────────────────────────────────────
//
// This file used to be a stub that logged "Workers ready" and consumed
// nothing. Every job added by utils/queue.js sat in Redis forever: the
// "It's a Match!" push from POST /api/matches/accept, the approve/reject
// pushes, and the whole admin audit trail. The producers reported success
// because Bull's add() succeeded — the jobs just never ran.
//
// Nothing here can be allowed to throw past the processor: a rejected job is
// retried three times (utils/queue.js sets attempts: 3) and then parked in the
// failed set, which is the right behaviour for a transient Expo or Firestore
// error but must never take the process down.

const { notificationQueue, auditQueue, JOB } = require('../utils/queue');
const { db }         = require('../config/firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { notifyUser, sendBatchPush } = require('../utils/pushNotification');

// One Redis connection per queue, so a slow Expo call cannot starve the other
// queue. Expo's own guidance is to keep concurrent pushes modest.
const PUSH_CONCURRENCY  = 5;
const AUDIT_CONCURRENCY = 5;

let started = false;

const startWorkers = () => {
  if (started) return;
  started = true;

  if (!notificationQueue && !auditQueue) {
    // utils/queue.js already logged why. The fallbacks there write directly,
    // so the app still works — there is simply nothing to consume.
    console.warn('⚠️  Workers not started — Bull queues are disabled');
    return;
  }

  // ── notifications ─────────────────────────────────────────────────────────
  if (notificationQueue) {
    notificationQueue.process(JOB.SEND_PUSH, PUSH_CONCURRENCY, async (job) => {
      const { userId, title, body, data } = job.data;
      if (!userId || !title) throw new Error('send_push job missing userId or title');

      // Returns null when the user has no push token — that is a completed
      // job, not a failure. Retrying would never produce a token.
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

    notificationQueue.on('failed', (job, err) => {
      console.error(
        `Push job ${job?.id} (${job?.name}) failed on attempt ${job?.attemptsMade}:`,
        err.message,
      );
    });

    notificationQueue.on('error', (err) => {
      console.error('Notification queue error:', err.message);
    });
  }

  // ── audit-logs ────────────────────────────────────────────────────────────
  if (auditQueue) {
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

    auditQueue.on('failed', (job, err) => {
      console.error(
        `Audit job ${job?.id} failed on attempt ${job?.attemptsMade}:`,
        err.message,
      );
    });

    auditQueue.on('error', (err) => {
      console.error('Audit queue error:', err.message);
    });
  }

  console.log('✅ Workers started — processing notifications and audit-logs');
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

module.exports = { startWorkers, stopWorkers };
