/** Chấm điểm = HÀM THUẦN (snapshot, answers) → result (B6.1). Không I/O; LLM không tham gia chấm chính thức. */
export const GRADER_VERSION = 'grader-1';

// P-05: NFC/NFKC để gõ Telex (tổ hợp) và dựng sẵn so sánh bằng nhau; đ ≠ d (giữ dấu); toLocaleLowerCase('vi').
export const normAnswer = (x) => String(x ?? '').normalize('NFKC').trim().toLocaleLowerCase('vi').replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '');
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * items: [{ type, answerKey, points, optionOrder }]   (optionOrder: thứ tự hiển thị → chỉ số gốc)
 * answers: mảng cùng độ dài (hoặc undefined/null nếu bỏ trống). Trả { score, max, perItem:[{earned,max,correct}] }.
 */
export function gradeAttempt(items, answers) {
  let score = 0, max = 0;
  const perItem = items.map((it, i) => {
    const pts = it.points ?? 1;
    max += pts;
    const a = answers[i];
    let earned = 0;
    if (a !== undefined && a !== null) {
      if (it.type === 'mcq_single') {
        const shown = Number.isInteger(a) ? a : -1;
        const orig = it.optionOrder ? it.optionOrder[shown] : shown;
        if (orig !== undefined && orig === it.answerKey.correctIndex) earned = pts;
      } else if (it.type === 'fill_blank') {
        if (typeof a === 'string' && it.answerKey.accepted.some((x) => normAnswer(x) === normAnswer(a))) earned = pts;
      } else if (it.type === 'matching') {
        const pairs = it.answerKey.pairs; // [[leftIdx, rightIdx(gốc)]]
        if (Array.isArray(a)) {
          let ok = 0;
          for (const [l, rr] of pairs) {
            const shown = a[l];
            const orig = it.optionOrder && Number.isInteger(shown) ? it.optionOrder[shown] : shown;
            if (orig === rr) ok += 1;
          }
          earned = round2((ok / pairs.length) * pts); // điểm từng phần
        }
      }
    }
    score += earned;
    return { earned, max: pts, correct: earned === pts };
  });
  return { score: round2(score), max: round2(max), perItem };
}
