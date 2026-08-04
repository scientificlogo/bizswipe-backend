'use strict';

// ── Reusable schema parts ─────────────────────────────────────────────────────
const pagination = {
  type: 'object',
  properties: {
    limit:  { type: 'string', pattern: '^[0-9]+$' },
    lastId: { type: 'string', maxLength: 100 },
  },
};

// ── GST ───────────────────────────────────────────────────────────────────────
const verifyGST = {
  body: {
    type: 'object',
    required: ['gstin'],
    additionalProperties: false,
    properties: {
      gstin: {
        type:    'string',
        pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[A-Z][0-9A-Z]{1}$',
      },
    },
  },
};

// ── Listings ──────────────────────────────────────────────────────────────────
const createListing = {
  body: {
    type:     'object',
    required: ['businessName', 'industry', 'city', 'askingPrice'],
    additionalProperties: true, // sanitize.js handles stripping
    properties: {
      businessName: { type: 'string', minLength: 2,  maxLength: 200  },
      industry:     { type: 'string', minLength: 2,  maxLength: 100  },
      city:         { type: 'string', minLength: 2,  maxLength: 100  },
      state:        { type: 'string',                maxLength: 100  },
      askingPrice:  { type: 'string', minLength: 1,  maxLength: 50   },
      turnover:     { type: 'string',                maxLength: 50   },
      employees:    { type: 'string',                maxLength: 20   },
      description:  { type: 'string',                maxLength: 2000 },
      profitStatus: { type: 'string', enum: ['Profitable','Break Even','Loss Making','High Growth'] },
      hasDebt:      { type: 'boolean' },
      debtAmount:   { type: 'string',                maxLength: 50   },
    },
  },
};

// ── Messages ──────────────────────────────────────────────────────────────────
const sendMessage = {
  body: {
    type:     'object',
    required: ['matchId', 'text'],
    additionalProperties: false,
    properties: {
      matchId:    { type: 'string', minLength: 1,  maxLength: 100 },
      text:       { type: 'string', minLength: 1,  maxLength: 500 },
      senderName: { type: 'string',                maxLength: 100 },
    },
  },
};

// ── Notifications ─────────────────────────────────────────────────────────────
const savePushToken = {
  body: {
    type:     'object',
    required: ['token'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 10, maxLength: 300 },
    },
  },
};

const sendNotification = {
  body: {
    type:     'object',
    required: ['userId', 'title', 'body'],
    additionalProperties: false,
    properties: {
      userId: { type: 'string', minLength: 1,  maxLength: 128  },
      title:  { type: 'string', minLength: 1,  maxLength: 100  },
      body:   { type: 'string', minLength: 1,  maxLength: 500  },
      data:   { type: 'object', maxProperties: 10 },
    },
  },
};

// ── Admin ─────────────────────────────────────────────────────────────────────
const rejectListing = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: { type: 'string', maxLength: 500 },
    },
  },
};

const banUser = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: { type: 'string', maxLength: 500 },
    },
  },
};

module.exports = {
  pagination,
  verifyGST,
  createListing,
  sendMessage,
  savePushToken,
  sendNotification,
  rejectListing,
  banUser,
};
