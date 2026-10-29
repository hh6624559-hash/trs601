import { uuid } from './dom.js';
export const session = { me: null, csrf: null };
export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.code || 'NETWORK');
    Object.assign(this, { status, code: e.code || 'NETWORK', messageKey: e.messageKey, params: e.params || {}, details: e.details || [], retryable: !!e.retryable, requestId: body?.requestId });
  }
}
let onUnauth = () => {};
export const setUnauthHandler = (f) => { onUnauth = f; };
let stepUpHandler = null;
export const setStepUpHandler = (f) => { stepUpHandler = f; };

export async function api(method, path, body, { headers = {}, key, raw, noRetryStepUp } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (method !== 'GET') { if (session.csrf) h['X-CSRF-Token'] = session.csrf; h['Idempotency-Key'] = key || uuid(); }
  let res;
  try { res = await fetch(`/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: { code: 'NETWORK', retryable: true } }); }
  let json = null; try { json = await res.json(); } catch { /* không phải JSON */ }
  if (res.ok && json?.success) { if (json.data?.session?.csrf) session.csrf = json.data.session.csrf; return raw ? { data: json.data, res } : json.data; }
  const e = new ApiError(res.status, json);
  if (e.code === 'STEP_UP_REQUIRED' && stepUpHandler && !noRetryStepUp) { await stepUpHandler(); return api(method, path, body, { headers, key, raw, noRetryStepUp: true }); }
  if (res.status === 401 && session.me && path !== '/me') { session.me = null; onUnauth(e); }
  throw e;
}
export const get = (p, o) => api('GET', p, undefined, o);
export const post = (p, b = {}, o) => api('POST', p, b, o);
export const put = (p, b = {}, o) => api('PUT', p, b, o);
export const patch = (p, b = {}, o) => api('PATCH', p, b, o);
export const del = (p, b, o) => api('DELETE', p, b, o);

export async function loadMe() {
  try { const d = await get('/me'); session.me = d; return d; } catch (e) { if (e.status === 401) { session.me = null; return null; } throw e; }
}
export function roleOf(me = session.me) {
  if (!me) return null;
  const tn = me.tenants.find((x) => x.id === me.tenant.id);
  const roles = tn?.roles || [];
  if (me.user.platformAdmin) return 'admin';
  if (roles.includes('teacher')) return 'teacher';
  if (roles.includes('guardian')) return 'guardian';
  return 'learner';
}
