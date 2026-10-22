import { h, mount, $ } from './dom.js';
import { loadI18n, t, setLocale, getLocale, onLocale, errText } from './i18n.js';
import { loadMe, session, roleOf, post, setUnauthHandler } from './api.js';
import { spinner, toast } from './ui.js';
import { startAutoSync, flush, onQueue, pending, clearAll } from './offline.js';
import { mascot } from './mascot.js';
import { EmptyState } from './components.js';

const root = document.getElementById('app');

// ---------- bảng route: [mẫu, vai trò được phép (null = công khai), module, hàm] ----------
const R = [
  ['/login', null, 'auth', 'login'], ['/register', null, 'auth', 'register'], ['/class-login', null, 'auth', 'classLogin'],
  ['/forgot', null, 'auth', 'forgot'], ['/reset', null, 'auth', 'reset'], ['/verify', null, 'auth', 'verify'],
  ['/', ['learner'], 'learner', 'home'], ['/review', ['learner'], 'review', 'review'],
  ['/collections', ['learner'], 'collections', 'list'], ['/collections/:id', ['learner'], 'collections', 'detail'],
  ['/vocab', ['learner', 'teacher'], 'collections', 'search'], ['/paths', ['learner'], 'collections', 'paths'],
  ['/shop', ['learner'], 'learner', 'shop'], ['/stickers', ['learner'], 'learner', 'stickers'],
  ['/games', ['learner'], 'games', 'games'],
  ['/rooms', ['learner', 'teacher'], 'rooms', 'list'], ['/rooms/:id', ['learner', 'teacher'], 'rooms', 'room'],
  ['/arena', ['learner', 'teacher'], 'arena', 'lobby'], ['/arena/:id', ['learner', 'teacher'], 'arena', 'match'],
  ['/assignments', ['learner'], 'quiz', 'mine'], ['/attempt/:id', ['learner'], 'quiz', 'attempt'], ['/practice', ['learner'], 'quiz', 'practice'], ['/practice/mine', ['learner'], 'practice_make', 'mine'], ['/g/practice/:id', ['guardian'], 'practice_make', 'forChild'], ['/ai-settings', ['learner', 'guardian'], 'teacher_ai', 'aiPage'],
  ['/friends', ['learner'], 'social', 'friends'], ['/chat/:id', ['learner'], 'social', 'chat'],
  ['/profile', ['learner', 'teacher', 'guardian', 'admin'], 'account', 'profile'], ['/privacy', ['learner', 'teacher', 'guardian', 'admin'], 'account', 'privacy'],
  ['/notifications', ['learner', 'teacher', 'guardian'], 'account', 'notifications'],
  ['/t', ['teacher'], 'teacher', 'classes'], ['/t/class/:id', ['teacher'], 'teacher', 'classDetail'], ['/t/questions', ['teacher'], 'teacher', 'questions'], ['/t/vocab', ['teacher'], 'teacher_ai', 'vocabImport'], ['/t/ai', ['teacher'], 'teacher_ai', 'aiPage'],
  ['/t/assessment/:id', ['teacher'], 'teacher', 'assessment'], ['/t/hard', ['teacher'], 'teacher', 'hard'],
  ['/g', ['guardian'], 'guardian', 'children'], ['/g/child/:id', ['guardian'], 'guardian', 'child'],
  ['/a', ['admin'], 'admin', 'stats'], ['/a/teachers', ['admin'], 'admin', 'teachers'], ['/a/moderation', ['admin'], 'admin', 'moderation'], ['/a/audit', ['admin'], 'admin', 'audit'],
].map(([p, roles, mod, fn]) => ({ re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, mod, fn }));

const HOME = { learner: '/', teacher: '/t', guardian: '/g', admin: '/a' };
const NAV = {
  learner: [['/', 'nav.home'], ['/review', 'nav.review'], ['/collections', 'nav.collections'], ['/assignments', 'nav.assignments'], ['/practice/mine', 'nav.makePractice'], ['/games', 'nav.games'], ['/arena', 'nav.arena'], ['/rooms', 'nav.rooms'], ['/vocab', 'nav.vocab'], ['/shop', 'nav.shop'], ['/friends', 'nav.friends'], ['/profile', 'nav.profile']],
  teacher: [['/t', 'nav.classes'], ['/t/questions', 'nav.questions'], ['/t/vocab', 'nav.vocabImport'], ['/t/ai', 'nav.ai'], ['/t/hard', 'nav.hard'], ['/arena', 'nav.arena'], ['/rooms', 'nav.rooms'], ['/vocab', 'nav.vocab'], ['/notifications', 'nav.notifications'], ['/profile', 'nav.profile']],
  guardian: [['/g', 'nav.children'], ['/ai-settings', 'nav.aiSettings'], ['/notifications', 'nav.notifications'], ['/profile', 'nav.profile']],
  admin: [['/a', 'nav.stats'], ['/a/teachers', 'nav.teachers'], ['/a/moderation', 'nav.moderation'], ['/a/audit', 'nav.audit'], ['/profile', 'nav.profile']],
};
const TABS = {
  learner: [['/', 'nav.today', '🏠'], ['/collections', 'nav.shelf', '📚'], ['/arena', 'nav.play', '🎲']],
  teacher: [['/t', 'nav.classes', '🏫'], ['/t/questions', 'nav.questions', '❓'], ['/vocab', 'nav.vocab', '🔎']],
  guardian: [['/g', 'nav.children', '👨‍👧'], ['/notifications', 'nav.notifications', '🔔'], ['/profile', 'nav.profile', '🙂']],
  admin: [['/a', 'nav.stats', '📊'], ['/a/moderation', 'nav.moderation', '🛡️'], ['/a/audit', 'nav.audit', '📜']],
};
const modules = {};
const load = async (m) => (modules[m] ||= await import(`./views/${m}.js`));

export const nav = (path, replace) => { if (replace) location.replace('#' + path); else location.hash = '#' + path; };
const parseHash = () => { const raw = location.hash.slice(1) || '/'; const [path, qs] = raw.split('?'); return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) }; };

let seq = 0, offlineBar, queueCount = 0;
async function render() {
  const my = ++seq;
  const { path, query } = parseHash();
  const route = R.find((r) => r.re.test(path));
  const role = roleOf();
  if (!route) { mount(root, shell(role, h('main', { id: 'main' }, h('h1', {}, '404'), h('a', { class: 'btn', href: '#' + (HOME[role] || '/login') }, t('common.home'))))); return; }
  if (route.roles && !session.me) return nav('/login', true);
  if (route.roles && !route.roles.includes(role)) return nav(HOME[role] || '/login', true);
  if (!route.roles && session.me && path !== '/verify' && path !== '/reset') return nav(HOME[role], true);
  const params = { ...(route.re.exec(path).groups || {}) };
  const content = h('main', { id: 'main', tabindex: '-1' }, spinner());
  mount(root, route.roles ? shell(role, content, path) : content);
  document.body.dataset.density = ({ u13: 'kid', '13_17': 'teen' })[session.me?.user.ageBand] || 'adult';
  try {
    if (route.roles && role === 'teacher' && session.me.user.roles.includes('teacher_pending') && path !== '/profile') {
      mount(content, h('div', { class: 'card stack' }, h('div', { class: 'row' }, mascot('idle', { size: 72 }), h('div', {}, h('h1', {}, t('teacher.pendingTitle')), h('p', {}, t('teacher.pendingBody')))),
        h('p', { class: 'muted small' }, t('teacher.pendingHint')), h('button', { class: 'btn', onclick: async () => { await loadMe(); render(); } }, t('teacher.pendingRecheck'))));
      document.title = `${t('teacher.pendingTitle')} – TRS6`; return;
    }
    const mod = await load(route.mod);
    const node = await mod[route.fn]({ params, query, role });
    if (my !== seq) return;
    mount(content, node);
    document.title = `${content.querySelector('h1')?.textContent || 'TRS6'} – TRS6`;
    content.focus({ preventScroll: true }); window.scrollTo(0, 0);
  } catch (e) {
    if (my !== seq) return;
    if (!(e && e.code)) console.error(e);
    mount(content, h('div', { class: 'card' }, h('div', { class: 'row' }, mascot('sad', { size: 72 }), h('div', {}, h('h1', {}, t('common.error')), h('p', {}, errText(e)), e.requestId && h('p', { class: 'muted small' }, `${t('common.ref')}: ${e.requestId}`))),
      h('button', { class: 'btn', onclick: render }, t('common.retry'))));
  }
}

function shell(role, content, path) {
  const me = session.me;
  const links = (NAV[role] || []).map(([p, k]) => h('a', { href: '#' + p, 'aria-current': (p === '/' ? path === '/' : path?.startsWith(p)) ? 'page' : null }, t(k)));
  const tenants = me.tenants.length > 1 ? h('select', { 'aria-label': t('nav.switchTenant'), onchange: async (ev) => { await post('/auth/switch-tenant', { tenantId: ev.target.value }); await loadMe(); nav(HOME[roleOf()] || '/', true); render(); } }, me.tenants.map((x) => h('option', { value: x.id, selected: x.id === me.tenant.id }, x.name))) : null;
  offlineBar = h('div', { class: ['offline-bar', navigator.onLine && queueCount === 0 && 'hidden'], role: 'status' }, offlineText());
  const tabs = TABS[role] || [];
  const cur = (p) => (p === '/' ? path === '/' : path?.startsWith(p));
  const moreMenu = h('dialog', { class: 'sheet', 'aria-label': t('nav.moreMenu') }, h('div', { class: 'stack' }, links.map((a) => a.cloneNode(true)), h('button', { class: 'btn ghost', onclick: () => moreMenu.close() }, t('common.close'))));
  moreMenu.addEventListener('click', (e) => { if (e.target.tagName === 'A' || e.target === moreMenu) moreMenu.close(); });
  return h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '#' + (HOME[role] || '/') }, mascot('idle', { size: 32 }), 'TRS6'),
      tenants,
      h('button', { class: 'btn ghost small', onclick: () => setLocale(getLocale() === 'vi' ? 'en' : 'vi') }, getLocale() === 'vi' ? 'EN' : 'VI'),
      h('button', { class: 'btn ghost small', 'aria-label': t('nav.theme'), onclick: toggleTheme }, '🌗'),
      h('button', { class: 'btn small', onclick: logout }, t('nav.logout'))),
    h('nav', { class: 'sidenav', 'aria-label': t('nav.main') }, links),
    h('nav', { class: 'tabbar', 'aria-label': t('nav.main') }, tabs.map(([p, k, ic]) => h('a', { href: '#' + p, 'aria-current': cur(p) ? 'page' : null }, h('span', { class: 'ti', 'aria-hidden': 'true' }, ic), t(k))), h('a', { href: '#', role: 'button', onclick: (e) => { e.preventDefault(); moreMenu.showModal(); } }, h('span', { class: 'ti', 'aria-hidden': 'true' }, '⋯'), t('nav.more'))), moreMenu,
    h('div', {}, offlineBar, me.user.emailVerified === false && me.user.email ? h('div', { class: 'banner' }, t('auth.verifyBanner')) : null, content));
}
const offlineText = () => (!navigator.onLine ? t('offline.offline', { n: queueCount }) : queueCount ? t('offline.pending', { n: queueCount }) : '');
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; try { localStorage.setItem('theme', next); } catch { /* bỏ qua */ }
}
async function logout() {
  try { const left = (await pending()).length; if (left) await flush(); await post('/auth/logout', {}); } catch { /* vẫn đăng xuất phía client */ }
  await clearAll(); session.me = null; session.csrf = null; nav('/login', true); render();
}

async function boot() {
  try { const th = localStorage.getItem('theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* bỏ qua */ }
  await loadI18n();
  mount(root, spinner());
  setUnauthHandler(() => { toast(t('error.SESSION_EXPIRED'), 'bad'); nav('/login', true); render(); });
  await loadMe().catch(() => {});
  onLocale(render);
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { queueCount = queueCount; refreshBar(); });
  window.addEventListener('offline', refreshBar);
  onQueue((n) => { queueCount = n; refreshBar(); });
  startAutoSync();
  if (session.me && roleOf() === 'learner') flush();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {}); // P-24
  if ('serviceWorker' in navigator && location.protocol !== 'file:') registerSW();
  await render();
}
function registerSW() {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const offer = (w) => { if (!w || !navigator.serviceWorker.controller || document.getElementById('sw-update')) return;
      document.body.append(h('div', { id: 'sw-update', class: 'toast', role: 'status' }, t('pwa.update'), ' ', h('button', { class: 'btn small', onclick: () => w.postMessage('SKIP_WAITING') }, t('pwa.updateBtn')))); };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); }); });
  }).catch(() => {});
  const had = !!navigator.serviceWorker.controller; let reloaded = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
}
function refreshBar() { if (!offlineBar) return; mount(offlineBar, offlineText()); offlineBar.classList.toggle('hidden', navigator.onLine && queueCount === 0); }
boot();
export { render };
