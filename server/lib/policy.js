import { MATRIX } from './policy.matrix.js';

export const AGE_ORDER = { u13: 0, '13_17': 1, '18p': 2 };

/**
 * Nhóm tuổi SUY RA từ birth_ym tại thời điểm kiểm (DI-021). Bảo thủ: chỉ coi là «đủ N tuổi»
 * sau khi hết tháng sinh (vì không lưu ngày sinh) → trẻ không bao giờ bị xếp lớn hơn tuổi thật.
 */
export function ageYears(birthYm, now) {
  const [by, bm] = birthYm.split('-').map(Number);
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 - (by * 12 + bm);
  return months <= 0 ? 0 : Math.floor((months - 1) / 12);
}
export function ageBand(birthYm, now) {
  const a = ageYears(birthYm, now);
  return a < 13 ? 'u13' : a < 18 ? '13_17' : '18p';
}

/**
 * can(actor, action, resource, ctx) → { allowed, reason, code } — mặc định TỪ CHỐI.
 * actor:    { id, tenantId, roles:[...], ageBand, mfaPassed, stepUp, teacherApproved }
 * resource: { tenantId?, ownerId?, state?, createdBy? }
 * ctx:      { rel:{ teacherOf, guardianOf, classMember }, consents:Set<string>, othersCanApprove? }
 * Chuỗi kiểm: xác thực → vai trò → tenant → quan hệ → trạng thái → tuổi → consent → step-up/MFA.
 */
export function can(actor, action, resource = {}, ctx = {}) {
  const deny = (reason, code = 'FORBIDDEN') => ({ allowed: false, reason, code });
  const rule = MATRIX[action];
  if (!rule) return deny('unknown_action');
  if (!actor || !actor.id) return deny('unauthenticated', 'UNAUTHENTICATED');
  const roles = actor.roles || [];
  if (!roles.some((r) => rule.roles.includes(r))) return deny('role');
  const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
  const platform = scopes.includes('platform') && roles.includes('platform_admin');
  if (!platform && resource.tenantId && resource.tenantId !== actor.tenantId) return deny('tenant', 'TENANT_MISMATCH');
  const rel = ctx.rel || {};
  const relOk = (sc) => {
    switch (sc) {
      case 'none': return true;
      case 'tenant': return true;
      case 'platform': return roles.includes('platform_admin');
      case 'self': return resource.ownerId === actor.id;
      case 'teacher_of': return !!rel.teacherOf;
      case 'guardian_of': return !!rel.guardianOf;
      case 'class_member': return !!rel.classMember;
      default: return false;
    }
  };
  if (!scopes.some(relOk)) return deny('relation');
  if (rule.states && resource.state !== undefined && !rule.states.includes(resource.state)) return deny('state', 'INVALID_STATE_TRANSITION');
  if (rule.minAge && AGE_ORDER[actor.ageBand] < AGE_ORDER[rule.minAge]) return deny('age', 'AGE_POLICY_DENIED');
  if (rule.consent && actor.ageBand !== '18p') {
    // Người dưới 18: cần consent GRANTED còn hiệu lực cho mục đích; người lớn tự cấp (self_adult) khi đăng ký.
    if (!(ctx.consents instanceof Set) || !ctx.consents.has(rule.consent)) return deny('consent', 'CONSENT_REQUIRED');
  }
  if (rule.teacherApproved && roles.includes('teacher') && !actor.teacherApproved) return deny('teacher_not_approved');
  if (rule.notSelfCreatedWhenOthers && resource.createdBy === actor.id && ctx.requireOtherApprover) return deny('self_approval');
  if (rule.mfa && roles.includes('platform_admin') && !actor.mfaPassed) return deny('mfa', 'MFA_REQUIRED');
  if (rule.stepUp && !actor.stepUp) return deny('step_up', 'STEP_UP_REQUIRED');
  return { allowed: true, reason: 'ok' };
}

/**
 * Chính sách tương tác xã hội theo tuổi (B7.2 / DI-019 / DI-020). Trả { allowed, reason }.
 * a, b: { id, tenantId, ageBand, role:'learner'|'teacher' }; ngữ cảnh: { sharedClass, blocked, guardianMessagingOff }
 */
export function canInteract(a, b, kind, ctx = {}) {
  const no = (reason) => ({ allowed: false, reason });
  if (a.id === b.id) return no('self');
  if (a.tenantId !== b.tenantId) return no('cross_tenant');
  if (ctx.blocked) return no('blocked'); // chặn có hiệu lực HAI CHIỀU
  const aMinor = a.ageBand !== '18p', bMinor = b.ageBand !== '18p';
  if (ctx.guardianMessagingOff && (kind === 'dm' || kind === 'friend')) return no('guardian_toggle');
  if (kind === 'class_channel') {
    if (!ctx.sharedClass) return no('not_in_class');
    return { allowed: true, reason: 'class' };
  }
  // dm / friend: không có giáo viên↔học sinh ngoài kênh lớp; người lớn không liên hệ trực tiếp người dưới 18
  if (a.role === 'teacher' || b.role === 'teacher') { if (aMinor || bMinor) return no('teacher_student_outside_class'); }
  if (aMinor !== bMinor) return no('adult_minor');
  if (a.ageBand === 'u13' || b.ageBand === 'u13') return no('under13_class_only');
  return { allowed: true, reason: 'peer' };
}
