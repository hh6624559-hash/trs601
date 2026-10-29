// Lõi thuần của Đấu trường (§8.4): không I/O, không đồng hồ → test property được.
import { mulberry32, shuffle } from '../lib/prng.js';
import { normAnswer } from './grading.js';

export const SCORE = { base: 100, speedMax: 50 };
export const GRACE_MS = 300;                 // GIẢ THUYẾT (spec §8.4), đo theo đồng hồ server
export const DISCONNECT_MS = 15000, FORFEIT_MS = 60000, REVEAL_MS = 3000;
export const MODES = {
  duel: { min: 2, max: 2, rounds: 10, limitSec: 15 },
  blitz: { min: 3, max: 30, rounds: 10, limitSec: 12 },   // 10–20 giây trong spec; mặc định 12
  spelling: { min: 2, max: 30, rounds: 8, limitSec: 25 },
};
export const XP_CAP = 30;

/** score(correct, elapsedMs, limitMs): sai = 0; đúng = 100 + thưởng tốc độ ≤ 50 giảm tuyến tính theo thời gian đã dùng. Không điểm âm. */
export function score(correct, elapsedMs, limitMs) {
  if (!correct) return 0;
  const limit = Math.max(1, limitMs);
  const used = Math.min(Math.max(0, elapsedMs), limit);
  return SCORE.base + Math.round(SCORE.speedMax * (1 - used / limit));
}

/** Hạng: điểm giảm dần; hòa → tổng thời gian trả lời ĐÚNG nhỏ hơn thắng; vẫn hòa → chia sẻ hạng (1,1,3…). */
export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || (a.userId < b.userId ? -1 : 1));
  let rank = 0, prev = null;
  return sorted.map((p, i) => {
    if (!prev || prev.score !== p.score || prev.correctMs !== p.correctMs) rank = i + 1;
    prev = p;
    return { ...p, rank };
  });
}

/** Dựng dãy câu từ seed + pool đã sắp theo id (tái tạo được: cùng seed + pool → cùng dãy, DI-013). */
export function buildQuestions({ mode, pool, seed, n }) {
  const rnd = mulberry32(`${seed}:${mode}`);
  const withDef = pool.filter((p) => p.definitionVi);
  const chosen = shuffle(withDef, rnd).slice(0, n);
  return chosen.map((s, idx) => {
    if (mode === 'spelling') {
      return { idx, senseId: s.id, kind: 'spell', prompt: { definitionVi: s.definitionVi, length: s.lemma.length, firstLetter: s.lemma[0] }, key: { accepted: [s.lemma] } };
    }
    const others = shuffle(withDef.filter((x) => x.id !== s.id && x.definitionVi !== s.definitionVi), rnd).slice(0, 3);
    const opts = shuffle([{ text: s.definitionVi, ok: true }, ...others.map((o) => ({ text: o.definitionVi, ok: false }))], rnd);
    return { idx, senseId: s.id, kind: 'mcq', prompt: { lemma: s.lemma, ipa: s.ipa || null, options: opts.map((o) => o.text) }, key: { correctIndex: opts.findIndex((o) => o.ok) } };
  });
}

export function isCorrect(q, answer) {
  if (q.kind === 'mcq') return Number.isInteger(answer.choice) && answer.choice === q.key.correctIndex;
  return typeof answer.text === 'string' && q.key.accepted.some((a) => normAnswer(a) === normAnswer(answer.text));
}

/** Câu gửi xuống client TRƯỚC reveal: không có khóa đáp án. */
export const publicQuestion = (q) => ({ idx: q.idx, kind: q.kind, prompt: q.prompt });
export const revealOf = (q) => (q.kind === 'mcq' ? { correctIndex: q.key.correctIndex } : { answer: q.key.accepted[0] });

export const xpFor = ({ correctCount, rank, players }) => Math.min(XP_CAP, correctCount * 3 + (rank === 1 && players > 1 ? 5 : 0));
