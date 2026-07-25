'use strict';

// ── Base error class ──────────────────────────────────────────────────────────
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Specific error types ──────────────────────────────────────────────────────
class ValidationError extends AppError {
  constructor(message, field) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name  = 'ValidationError';
    this.field = field;
  }
}

class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

class TokenExpiredError extends AppError {
  constructor() {
    super('Token expired — please refresh', 401, 'TOKEN_EXPIRED');
    this.name = 'TokenExpiredError';
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

class BlockedContentError extends AppError {
  constructor(detected) {
    super(`Message blocked: contains ${detected}`, 422, 'BLOCKED_CONTENT');
    this.name     = 'BlockedContentError';
    this.detected = detected;
    this.blocked  = true;
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  TokenExpiredError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BlockedContentError,
};
