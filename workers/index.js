'use strict';

// ── Workers ───────────────────────────────────────────────────────────────────
//
// There are none, deliberately. Pushes and audit rows are written directly by
// utils/queue.js — see the note at the top of that file for why the Bull
// queues were removed rather than given the processors they were missing.
// "Workers ready" used to be printed here by a stub while nothing consumed
// anything, which is precisely the impression worth not giving again.
//
// server.js calls these on start and shutdown, so they stay as no-ops rather
// than being deleted, and this is still the place a real background worker
// would go.

const startWorkers = () => {
  console.log('No background workers — pushes and audit rows are written inline');
};

const stopWorkers = async () => {};

module.exports = { startWorkers, stopWorkers };
