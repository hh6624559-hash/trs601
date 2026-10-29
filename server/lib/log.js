/** Log JSON có cấu trúc. KHÔNG log mật khẩu/token/secret/nội dung tin nhắn riêng (B3.2). */
const REDACT = /pass|pin|token|secret|cookie|authorization|body|csrf|totp/i;
export function makeLogger(level = process.env.LOG_LEVEL || 'info', sink = (l) => process.stdout.write(l + '\n')) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const emit = (lvl, msg, f = {}) => {
    if (order[lvl] < order[level]) return;
    const safe = {};
    for (const [k, v] of Object.entries(f)) safe[k] = REDACT.test(k) ? '[redacted]' : v;
    sink(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...safe }));
  };
  return { debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
