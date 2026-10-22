/**
 * Lõi lịch ôn FSRS (S2a) – HÀM THUẦN: (state, rating, now) → newState. Không I/O, không Date.now().
 * Cài đặt theo công thức FSRS-4.5 với trọng số mặc định đã công bố.
 * ⚠ TRẠNG THÁI XÁC MINH: chưa đối chiếu với vector tham chiếu của thư viện chính thức (không có mạng để tải).
 *   Test hiện chỉ kiểm tính chất (đơn điệu, biên, xác định, tái dựng). Ghi trong ADR-0005; không tuyên bố tương đương.
 */
export const SCHEDULER_VERSION = 'fsrs-4.5-local-1';
export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5, FACTOR = 19 / 81;
const DAY = 86400000, MIN = 60000;
export const MAX_INTERVAL_DAYS = 365;

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const retrievability = (elapsedDays, stability) => Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
export const nextIntervalDays = (stability, retention = 0.9) => (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
const initStability = (g) => Math.max(0.1, W[g - 1]);
const initDifficulty = (g) => clamp(W[4] - W[5] * (g - 3), 1, 10);
const nextDifficulty = (d, g) => clamp(W[7] * initDifficulty(4) + (1 - W[7]) * (d - W[6] * (g - 3)), 1, 10);
const recallStability = (d, s, r, g) =>
  s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
const forgetStability = (d, s, r) => W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));

/** Hạt giống xác định cho fuzz: hash(user_id, sense_id, reps) → [0,1) – rebuild_state luôn tái tạo đúng. */
export function fuzzUnit(userId, senseId, reps) {
  let h = 2166136261;
  for (const c of `${userId}|${senseId}|${reps}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export const NEW_STATE = () => ({ state: 'new', stability: 0, difficulty: 0, due_at: null, last_review_at: null, reps: 0, lapses: 0, leech: false });

/**
 * @param st   trạng thái hiện tại (NEW_STATE() nếu chưa có)
 * @param rating 1 Again · 2 Hard · 3 Good · 4 Easy
 * @param nowMs thời điểm hiệu lực của lượt ôn (ms)
 * @param opts { userId, senseId, retention, leechLapses }
 */
export function schedule(st, rating, nowMs, opts = {}) {
  const retention = opts.retention ?? 0.9, leechLapses = opts.leechLapses ?? 8;
  const out = { ...st, last_review_at: new Date(nowMs).toISOString(), reps: st.reps + 1 };
  let dueMs;
  if (st.state === 'new') {
    out.stability = initStability(rating);
    out.difficulty = initDifficulty(rating);
    if (rating === 1) { out.state = 'learning'; dueMs = nowMs + 10 * MIN; }
    else { out.state = 'review'; dueMs = nowMs + fuzzDays(out, nowMs, opts, retention, rating === 2 ? 1 : 0) * DAY; }
  } else {
    const lastMs = st.last_review_at ? Date.parse(st.last_review_at) : nowMs;
    const elapsed = Math.max(0, (nowMs - lastMs) / DAY); // ngày; lượt ôn "đến muộn" không cho elapsed âm
    const r = retrievability(elapsed, st.stability);
    if (st.state === 'learning' || st.state === 'relearning') {
      out.difficulty = nextDifficulty(st.difficulty, rating);
      if (rating === 1) { out.stability = Math.max(0.1, Math.min(st.stability, forgetStability(out.difficulty, st.stability, Math.max(r, 0.01)))); out.state = st.state; dueMs = nowMs + 10 * MIN; }
      else { out.stability = Math.max(st.stability, recallStability(out.difficulty, st.stability, Math.max(r, 0.01), rating)); out.state = 'review'; dueMs = nowMs + fuzzDays(out, nowMs, opts, retention, rating === 2 ? 1 : 0) * DAY; }
    } else {
      out.difficulty = nextDifficulty(st.difficulty, rating);
      if (rating === 1) {
        out.lapses = st.lapses + 1;
        out.stability = Math.max(0.1, Math.min(st.stability, forgetStability(st.difficulty, st.stability, r)));
        out.state = 'relearning'; dueMs = nowMs + 10 * MIN;
        if (out.lapses >= leechLapses) out.leech = true; // Leech → F3 Cứu Từ Khó
      } else {
        out.stability = recallStability(st.difficulty, st.stability, r, rating);
        out.state = 'review'; dueMs = nowMs + fuzzDays(out, nowMs, opts, retention, 0) * DAY;
      }
    }
  }
  out.stability = clamp(out.stability, 0.1, 36500);
  out.due_at = new Date(dueMs).toISOString();
  return out;
}

function fuzzDays(next, nowMs, opts, retention, minDays) {
  let days = nextIntervalDays(next.stability, retention);
  days = clamp(Math.round(days), Math.max(1, minDays), MAX_INTERVAL_DAYS);
  if (days > 3 && opts.userId) days = clamp(Math.round(days * (0.95 + 0.1 * fuzzUnit(opts.userId, opts.senseId, next.reps))), 2, MAX_INTERVAL_DAYS);
  return days;
}

/** Xem trước khoảng cách cho 4 nút (B4.4). */
export function preview(st, nowMs, opts) {
  const o = {};
  for (const g of [1, 2, 3, 4]) {
    const n = schedule(st, g, nowMs, opts);
    o[g] = Math.max(0, Date.parse(n.due_at) - nowMs);
  }
  return o;
}

/**
 * Dựng lại trạng thái của MỘT sense từ chuỗi sự kiện đã sắp xếp theo (received_at, seq).
 * events: [{ id, rating, source, reverses_id, effective_ms }]; sự kiện bị hoàn tác và sự kiện 'undo'/'game' bị bỏ qua.
 */
export function rebuild(events, opts) {
  const reversed = new Set(events.filter((e) => e.source === 'undo').map((e) => e.reverses_id));
  let st = NEW_STATE(), introduced = null;
  for (const e of events) {
    if (e.source !== 'review' || reversed.has(e.id)) continue; // game: chỉ là bằng chứng bổ sung, không đổi lịch (ADR-0005)
    if (!introduced) introduced = new Date(e.effective_ms).toISOString();
    st = schedule(st, e.rating, e.effective_ms, opts);
  }
  return { ...st, introduced_at: introduced };
}
