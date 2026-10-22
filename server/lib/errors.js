/** Bảng mã lỗi chuẩn (Phụ lục): mã → HTTP + retry. Lỗi miền có kiểu, map ở MỘT nơi. */
export const ERROR_TABLE = {
  VALIDATION_ERROR: [400, false], MALFORMED_REQUEST: [400, false],
  UNAUTHENTICATED: [401, false], SESSION_EXPIRED: [401, false],
  FORBIDDEN: [403, false], TENANT_MISMATCH: [403, false], MFA_REQUIRED: [403, false], STEP_UP_REQUIRED: [403, false],
  GUARDIAN_SCOPE_DENIED: [403, false], AGE_POLICY_DENIED: [403, false], CONSENT_REQUIRED: [403, false],
  NOT_FOUND: [404, false],
  CONFLICT: [409, false], IDEMPOTENCY_KEY_REUSED: [409, false], INVALID_STATE_TRANSITION: [409, false],
  VERSION_MISMATCH: [409, false], REQUEST_IN_PROGRESS: [409, true],
  PRECONDITION_FAILED: [412, false], PRECONDITION_REQUIRED: [428, false],
  PAYLOAD_TOO_LARGE: [413, false], UNSUPPORTED_MEDIA_TYPE: [415, false],
  BUSINESS_RULE_VIOLATION: [422, false], INSUFFICIENT_BALANCE: [422, false], ATTEMPT_LIMIT_REACHED: [422, false],
  RATE_LIMITED: [429, true], AI_BUDGET_EXCEEDED: [429, true],
  INTERNAL_ERROR: [500, true], DEPENDENCY_UNAVAILABLE: [503, true],
};

export class AppError extends Error {
  constructor(code, { messageKey, params = {}, details = [], retryAfter } = {}) {
    super(code);
    if (!ERROR_TABLE[code]) throw new Error(`Unknown error code ${code}`);
    this.code = code;
    this.status = ERROR_TABLE[code][0];
    this.retryable = ERROR_TABLE[code][1];
    this.messageKey = messageKey || `error.${code}`;
    this.params = params;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}
export const err = (code, opts) => new AppError(code, opts);
