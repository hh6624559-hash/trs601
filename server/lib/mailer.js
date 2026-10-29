/** Email adapter trung lập: console | memory (test) | webhook (POST JSON tới dịch vụ gửi mail do bạn chọn). */
export function makeMailer(config, log) {
  const sent = [];
  return {
    sent,
    async send({ to, subject, text, kind }) {
      try {
        if (config.emailMode === 'memory') { sent.push({ to, subject, text, kind }); return true; }
        if (config.emailMode === 'webhook') {
          const r = await fetch(config.emailWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: config.emailFrom, to, subject, text, kind }), signal: AbortSignal.timeout(8000) });
          if (!r.ok) throw new Error(`webhook ${r.status}`);
          return true;
        }
        // console: chỉ dùng dev/demo – nội dung (kèm liên kết) in ra log máy chủ
        log.info('email_console', { to, subject, text, kind });
        return true;
      } catch (e) { log.error('email_failed', { kind, error: e.message }); return false; }
    },
  };
}
