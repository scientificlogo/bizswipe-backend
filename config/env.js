'use strict';

// ── Required environment variables ────────────────────────────────────────────
const REQUIRED = [
  'FIREBASE_SERVICE_ACCOUNT_BASE64',
  'RAPIDAPI_KEY',
  'RAPIDAPI_HOST',
];

const missing = REQUIRED.filter(k => !process.env[k]);

if (missing.length > 0) {
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('❌ STARTUP FAILED — Missing env vars:');
  missing.forEach(k => console.error(`   • ${k}`));
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
}

// ── Validate Firebase Base64 is valid JSON ────────────────────────────────────
try {
  const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
  const parsed  = JSON.parse(decoded);
  if (!parsed.project_id || !parsed.private_key) {
    throw new Error('Missing project_id or private_key');
  }
  console.log('✅ Firebase credentials validated');
} catch (err) {
  console.error('❌ STARTUP FAILED — FIREBASE_SERVICE_ACCOUNT_BASE64 is invalid:', err.message);
  process.exit(1);
}

// ── Validate ADMIN_UIDS ───────────────────────────────────────────────────────
if (!process.env.ADMIN_UIDS) {
  console.warn('⚠️  WARNING: ADMIN_UIDS not set — admin routes will be inaccessible');
}

console.log('✅ All environment variables validated');
module.exports = {};
