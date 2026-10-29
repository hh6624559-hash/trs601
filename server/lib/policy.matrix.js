/**
 * policy.matrix.js – MỘT nguồn sự thật cho quyền (NT-15). Test được SINH từ ma trận này;
 * route khai báo action phải có dòng ở đây, thiếu → test CI fail.
 *
 * scope:  self        – chủ sở hữu tài nguyên là chính actor
 *         tenant      – cùng tenant (không cần quan hệ)
 *         teacher_of  – actor là giáo viên (đã duyệt) của lớp/học viên chứa tài nguyên
 *         guardian_of – actor là giám hộ có liên kết active với chủ tài nguyên
 *         class_member– actor là thành viên lớp chứa tài nguyên
 *         platform    – quản trị nền tảng (xuyên tenant, cần MFA)
 *         none        – không gắn tài nguyên (liệt kê của chính mình)
 * roles dùng: learner, teacher, guardian, admin(owner tổ chức), platform_admin
 */
const L = ['learner'], T = ['teacher'], G = ['guardian'], ANY = ['learner', 'teacher', 'guardian', 'admin', 'platform_admin'];
const PA = ['platform_admin'];

export const MATRIX = {
  // --- tài khoản / phiên / riêng tư ---
  'me.read': { roles: ANY, scope: 'none' },
  'me.update': { roles: ANY, scope: 'none' },
  'session.list': { roles: ANY, scope: 'none' },
  'session.revoke': { roles: ANY, scope: 'self' },
  'mfa.manage': { roles: ANY, scope: 'none' },
  'privacy.view': { roles: ANY, scope: 'none' },
  'privacy.export': { roles: ANY, scope: 'self', stepUp: true },
  'privacy.delete': { roles: ANY, scope: 'self', stepUp: true },
  'privacy.delete_child': { roles: G, scope: 'guardian_of', stepUp: true },
  'notification.read': { roles: ANY, scope: 'none' },
  // --- học tập ---
  'vocab.read': { roles: ANY, scope: 'none' },
  'learn.today': { roles: L, scope: 'none', consent: 'account' },
  'learn.review': { roles: L, scope: 'none', consent: 'account' },
  'learn.progress': { roles: L, scope: 'none' },
  'economy.read': { roles: L, scope: 'none' },
  'economy.spend': { roles: L, scope: 'none', consent: 'account' },
  'streak.manage': { roles: L, scope: 'none', consent: 'account' },
  // --- kho cá nhân ---
  'collection.list': { roles: L, scope: 'none' },
  'collection.create': { roles: L, scope: 'none', consent: 'account' },
  'collection.read': { roles: ['learner', 'teacher', 'guardian'], scope: ['self', 'teacher_of'] },
  'collection.write': { roles: L, scope: 'self', states: ['active', 'paused'], consent: 'account' },
  'collection.restore': { roles: L, scope: 'self', states: ['archived'], consent: 'account' },
  'collection.report_hard': { roles: L, scope: 'self' },
  'path.manage': { roles: L, scope: 'self', consent: 'account' },
  // --- lớp, bài giao ---
  'class.create': { roles: T, scope: 'none', teacherApproved: true },
  'class.list': { roles: T, scope: 'none', teacherApproved: true },
  'class.read': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'class.manage_students': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'class.assign': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'assignment.mine': { roles: L, scope: 'none' },
  'student.read_progress': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'classroom.manage': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'classroom.join': { roles: L, scope: 'class_member' },
  // --- đánh giá ---
  'question.manage': { roles: T, scope: 'tenant', teacherApproved: true },
  'question.approve': { roles: T, scope: 'tenant', teacherApproved: true, notSelfCreatedWhenOthers: true },
  'vocab.import': { roles: T, scope: 'tenant', teacherApproved: true },
  'exam.compose': { roles: T, scope: 'tenant', teacherApproved: true },
  'assessment.manage': { roles: T, scope: 'teacher_of', teacherApproved: true },
  'assessment.read': { roles: ['learner', 'teacher'], scope: ['class_member', 'teacher_of'] },
  'practice.compose': { roles: L, scope: 'none', consent: 'account' },
  'attempt.start': { roles: L, scope: ['class_member', 'self'], consent: 'account' },
  'attempt.act': { roles: L, scope: 'self', states: ['IN_PROGRESS', 'EXPIRED'], consent: 'account' },
  'attempt.read': { roles: ['learner', 'teacher'], scope: ['self', 'teacher_of'] },
  // --- giám hộ ---
  'guardian.create_child': { roles: G, scope: 'none' },
  'guardian.list': { roles: G, scope: 'none' },
  'guardian.view_child': { roles: G, scope: 'guardian_of' },
  'guardian.manage_child': { roles: G, scope: 'guardian_of' },
  // --- xã hội (S9) ---
  'social.profile': { roles: L, scope: 'none' },
  'social.friend_request': { roles: L, scope: 'none', consent: 'social', minAge: '13_17' },
  'social.friend_respond': { roles: L, scope: 'none', consent: 'social', minAge: '13_17' },
  'social.message_send': { roles: ['learner', 'teacher'], scope: 'none', consent: 'social' },
  'social.message_read': { roles: ['learner', 'teacher'], scope: 'none' },
  'social.block': { roles: ['learner', 'teacher'], scope: 'none' },
  'social.report': { roles: ['learner', 'teacher', 'guardian'], scope: 'none' },
  // --- đấu trường (§8): quy tắc tuổi/quan hệ chi tiết nằm ở joinCheck(); đây là cổng vai trò + consent ---
  'arena.create': { roles: ['learner', 'teacher'], scope: 'none', consent: 'account' },
  'arena.join': { roles: ['learner', 'teacher'], scope: 'none', consent: 'account' },
  'arena.read': { roles: ['learner', 'teacher'], scope: 'none' },
  'arena.play': { roles: ['learner'], scope: 'none', consent: 'account' },
  'arena.host': { roles: ['learner', 'teacher'], scope: 'none' },
  // --- phòng học (§7): luật tuổi/quan hệ chi tiết ở joinCheck() trong modules/rooms.js ---
  'room.create': { roles: ['learner', 'teacher'], scope: 'none' },
  'room.join': { roles: ['learner', 'teacher'], scope: 'none' },
  'room.read': { roles: ['learner', 'teacher'], scope: 'none' },
  'room.interact': { roles: ['learner', 'teacher'], scope: 'none' },
  'room.manage': { roles: ['learner', 'teacher'], scope: 'none' },
  // --- AI (§9): mặc định TẮT; quản trị theo tổ chức, khoá BYOK cần step-up; người dưới 13 không dùng gia sư ---
  'ai.admin': { roles: ['admin'], scope: 'tenant' },
  'ai.admin_key': { roles: ['admin'], scope: 'tenant', stepUp: true },
  'ai.question_draft': { roles: T, scope: 'tenant', teacherApproved: true },
  'ai.status': { roles: ['learner', 'guardian'], scope: 'none' },
  'ai.practice': { roles: ['learner', 'guardian'], scope: 'none', consent: 'ai_tutor', minAge: '13_17' },
  'ai.tutor': { roles: L, scope: 'none', consent: 'ai_tutor', minAge: '13_17' },
  // --- quản trị ---
  'admin.teacher_review': { roles: PA, scope: 'platform', mfa: true },
  'admin.moderate': { roles: ['platform_admin', 'admin'], scope: ['platform', 'tenant'], mfa: true },
  'admin.audit_read': { roles: PA, scope: 'platform', mfa: true },
  'admin.integrity': { roles: PA, scope: 'platform', mfa: true },
  'admin.stats': { roles: PA, scope: 'platform', mfa: true },
};

export const ALL_ROLES = ANY;
