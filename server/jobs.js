import { relay } from './lib/outbox.js';
import { anonymizeUser } from './modules/privacy.js';
import { ageBand } from './lib/policy.js';
import { notify } from './modules/common.js';
import { ledgerPost } from './modules/economy.js';
import { arenaFinishedHandler } from './modules/arena.js';
import { xpFor } from './modules/arena-core.js';

/** Job nền: chạy trong cùng tiến trình (modular monolith, ADR-0001), có thể tách apps/worker khi có số đo. */
export function makeJobs({ db, clock, log, limiter, audit, deps }) {
  const handlers = {
    'arena.finished': arenaFinishedHandler(db, clock, ledgerPost, xpFor),
    // Người kiểm duyệt nhận thông báo in-app khi có báo cáo mới; idempotent theo (reportId, userId)
    'report.created': (p) => {
      const mods = db.all("SELECT DISTINCT m.user_id AS id FROM memberships m WHERE m.tenant_id=? AND m.role IN ('owner','admin') AND m.status='active'", p.tenantId);
      for (const m of mods) {
        if (db.get("SELECT 1 FROM notifications WHERE user_id=? AND kind='report_new' AND params LIKE ?", m.id, `%${p.reportId}%`)) continue;
        db.run('INSERT INTO notifications(id,tenant_id,user_id,kind,params,created_at) VALUES(lower(hex(randomblob(16))),?,?,?,?,?)', p.tenantId, m.id, 'report_new', JSON.stringify({ reportId: p.reportId, severity: p.severity }), clock.iso());
      }
    },
  };

  /** Phát hiện chuyển nhóm tuổi (DI-021): KHÔNG tự mở quyền; hết hạn consent 'social', yêu cầu xác nhận lại + thông báo giám hộ/giáo viên. */
  function detectAgeBandChanges() {
    let changed = 0;
    for (const u of db.all("SELECT id, home_tenant_id, birth_ym, prefs FROM users WHERE status='active'")) {
      const band = ageBand(u.birth_ym, clock.now());
      const prefs = JSON.parse(u.prefs || '{}');
      if (!prefs.lastBand) { db.run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify({ ...prefs, lastBand: band }), u.id); continue; }
      if (prefs.lastBand === band) continue;
      db.tx(() => {
        db.run("UPDATE consents SET state='EXPIRED' WHERE subject_id=? AND purpose='social' AND state='GRANTED'", u.id);
        db.run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify({ ...prefs, lastBand: band }), u.id);
        notify(db, clock, { tenantId: u.home_tenant_id, userId: u.id, kind: 'age_band_changed', params: { from: prefs.lastBand, to: band } });
        for (const g of db.all("SELECT guardian_id FROM guardian_links WHERE learner_id=? AND status='active'", u.id)) notify(db, clock, { tenantId: u.home_tenant_id, userId: g.guardian_id, kind: 'age_band_changed_guardian', params: { learnerId: u.id, to: band } });
        audit.write({ tenantId: u.home_tenant_id, action: 'age_band.changed', targetType: 'user', targetId: u.id, diff: { from: prefs.lastBand, to: band } });
      });
      changed++;
    }
    return changed;
  }

  function executeDueDeletions() {
    let n = 0;
    for (const req of db.all("SELECT * FROM privacy_requests WHERE kind='deletion' AND state='VERIFIED' AND due_at<=?", clock.iso())) {
      try {
        db.tx(() => {
          db.run("UPDATE privacy_requests SET state='IN_PROGRESS' WHERE id=? AND state='VERIFIED'", req.id);
          const sum = anonymizeUser(db, clock, req.subject_id, null);
          db.run("UPDATE privacy_requests SET state='COMPLETED', completed_at=?, note=? WHERE id=?", clock.iso(), JSON.stringify(sum.kept || []), req.id);
          audit.write({ tenantId: req.tenant_id, action: 'privacy.deletion_executed_by_job', targetType: 'user', targetId: req.subject_id });
        });
        n++;
      } catch (e) { log.warn('deletion_job_failed', { requestId: req.id, error: e.message }); }
    }
    return n;
  }

  const tasks = {
    outbox: () => relay(db, clock, handlers),
    expireAttempts: () => deps.expireAttempts?.() ?? 0,
    pruneIdempotency: () => db.run('DELETE FROM idempotency_records WHERE expires_at<?', clock.iso()).changes,
    pruneRate: () => limiter.prune(3600),
    pruneSessions: () => db.run('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR expires_at<?', new Date(clock.ms() - 30 * 86400e3).toISOString(), new Date(clock.ms() - 30 * 86400e3).toISOString()).changes,
    pruneWebhooks: () => db.run('DELETE FROM webhook_inbox WHERE received_at<?', new Date(clock.ms() - 90 * 86400e3).toISOString()).changes,
    pruneMessages: () => db.run('DELETE FROM messages WHERE created_at<?', new Date(clock.ms() - 365 * 86400e3).toISOString()).changes, // 12 tháng (GIẢ THUYẾT, theo chính sách tổ chức)
    auditCheckpoint: () => audit.checkpoint(),
    ageBands: detectAgeBandChanges,
    deletions: executeDueDeletions,
    roomSweep: () => deps.rooms?.sweepAll() ?? 0,
    arenaTick: () => { let n = 0; for (const m of db.all("SELECT id FROM arena_matches WHERE state NOT IN ('FINISHED','ABORTED')")) { deps.arena?.tick(m.id); n++; } return n; },
  };

  let timers = [];
  const run = (name) => { try { return tasks[name](); } catch (e) { log.error('job_failed', { job: name, error: e.message }); } };
  return {
    tasks, run, detectAgeBandChanges, executeDueDeletions,
    runAll: () => Object.fromEntries(Object.keys(tasks).map((k) => [k, run(k)])),
    start() {
      const every = (name, ms) => { const t = setInterval(() => run(name), ms); t.unref(); timers.push(t); };
      every('outbox', 5000); every('arenaTick', 1000); every('roomSweep', 15000); every('expireAttempts', 15000); every('pruneIdempotency', 3600e3); every('pruneRate', 600e3); every('pruneSessions', 6 * 3600e3);
      every('pruneWebhooks', 24 * 3600e3); every('pruneMessages', 24 * 3600e3); every('auditCheckpoint', 3600e3); every('ageBands', 6 * 3600e3); every('deletions', 3600e3);
    },
    stop() { timers.forEach(clearInterval); timers = []; },
  };
}
