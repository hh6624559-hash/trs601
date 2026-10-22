import { h, mount } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, session } from '../api.js';
import { action, toast, bar, empty } from '../ui.js';
import { mascot } from '../mascot.js';
import { render } from '../app.js';

export async function home() {
  const [today, prog, quests, cols, assigns] = await Promise.all([get('/learn/today?limit=1'), get('/learn/progress'), get('/me/quests'), get('/me/collections'), get('/me/assignments').catch(() => ({ assignments: [] }))]);
  const me = session.me.user, c = today.counts;
  const due = c.due + Math.min(c.newAvailable, Math.max(0, c.newPerDay - c.newToday));
  const mood = prog.streak.current >= 3 ? 'happy' : due === 0 ? 'sleepy' : 'idle';
  const goalDone = c.reviewsToday;
  const days = prog.last14, maxR = Math.max(5, ...days.map((d) => d.reviews));
  const spark = h('div', { class: 'row', role: 'img', 'aria-label': t('home.last14') }, days.map((d) => { const i = h('i', { title: `${d.day}: ${d.reviews}` }); i.style.display = 'inline-block'; i.style.width = '14px'; i.style.height = `${6 + (d.reviews / maxR) * 44}px`; i.style.background = d.reviews ? 'var(--moss)' : 'var(--line)'; i.style.borderRadius = '4px'; i.style.alignSelf = 'flex-end'; return i; }));
  const out = h('div', {},
    h('div', { class: 'card row' }, mascot(mood, { size: 110 }), h('div', {}, h('h1', {}, t('home.hello', { name: me.displayName })),
      due > 0 ? h('p', {}, t('home.dueCount', { n: due })) : h('p', {}, t('home.allDone')),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/review' }, due > 0 ? t('home.startReview') : t('home.reviewAnyway')), h('a', { class: 'btn ghost', href: '#/practice' }, t('home.practice'))))),
    h('div', { class: 'grid c3' },
      h('div', { class: 'card' }, h('div', { class: 'stat' }, '🔥 ', prog.streak.current), h('div', {}, t('home.streak')), h('div', { class: 'muted small' }, t('home.best', { n: prog.streak.best }), ' · ', t('home.freeze', { n: prog.streak.freezeTokens }))),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, '⭐ ', prog.wallet.balance), h('div', {}, t('home.level', { n: prog.wallet.level })), bar(prog.wallet.lifetimeEarned, prog.wallet.nextLevelAt)),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, goalDone, h('span', { class: 'muted small' }, ' / ', c.dailyGoal)), h('div', {}, t('home.dailyGoal')), bar(goalDone, c.dailyGoal))),
    h('div', { class: 'grid c2' },
      h('section', { class: 'card', 'aria-labelledby': 'q-h' }, h('h2', { id: 'q-h' }, t('home.quests')),
        h('ul', { class: 'stack', style: undefined }, quests.tasks.map((k) => h('li', {}, (k.done ? '✅ ' : '⬜ '), t(`quest.${k.key}`, { n: k.target }), h('span', { class: 'muted small' }, ` ${Math.min(k.progress, k.target)}/${k.target}`)))),
        quests.claimed ? h('p', { class: 'badge' }, t('home.claimed'))
          : h('button', { class: 'btn moss', disabled: !quests.complete, onclick: action(async () => { const r = await post('/me/quests/claim', {}); toast(t('home.claimOk', { n: r.reward ?? quests.reward })); render(); }) }, t('home.claim', { n: quests.reward }))),
      h('section', { class: 'card', 'aria-labelledby': 'p-h' }, h('h2', { id: 'p-h' }, t('home.progress')), spark,
        h('p', { class: 'muted small' }, t('home.totals', { m: prog.totals.mastered, l: prog.totals.learning + prog.totals.review, s: prog.stickers })),
        prog.leeches.length ? h('p', { class: 'badge warn' }, t('home.leeches', { n: prog.leeches.length })) : null)),
    assigns.assignments.length ? h('section', { class: 'card' }, h('h2', {}, t('home.assignments')), h('a', { href: '#/assignments' }, t('home.openAssignments', { n: assigns.assignments.length }))) : null);
  if (!cols.collections.length) {
    const comp = await get('/me/compass');
    mount(out, ...[...out.childNodes], h('section', { class: 'card' }, h('h2', {}, t('home.startTitle')), h('p', {}, t('home.startHint')),
      h('div', { class: 'row' }, comp.suggestions.slice(0, 6).map((s) => h('button', { class: 'btn ghost', onclick: action(async () => { await post('/me/collections', { title: t(`topic.${s.topic}`), fromTopic: s.topic, limit: 20 }); render(); }) }, t(`topic.${s.topic}`), ` (${s.count})`)))));
  }
  return out;
}

export async function shop() {
  const [w, items] = await Promise.all([get('/me/wallet'), get('/shop/items')]);
  return h('div', {}, h('h1', {}, t('shop.title')), h('p', { class: 'badge brand' }, '⭐ ', w.balance),
    h('div', { class: 'grid c3' }, items.items.map((it) => h('div', { class: 'card center' }, h('div', { class: 'sticker' }, it.kind === 'hat' ? '🎩' : '🎁'), h('h3', {}, getLocale() === 'vi' ? it.nameVi : it.nameEn),
      it.owned ? h('span', { class: 'badge' }, t('shop.owned')) : h('button', { class: 'btn', disabled: w.balance < it.price, onclick: action(async () => { await post('/shop/purchases', { itemId: it.id }); toast(t('shop.bought')); render(); }) }, '⭐ ', it.price)))));
}

export async function stickers() {
  const s = await get('/me/stickers');
  return h('div', {}, h('h1', {}, t('stickers.title')), h('p', { class: 'muted' }, t('stickers.hint')),
    s.stickers.length ? h('ul', { class: 'pill-list' }, s.stickers.map((x) => h('li', { class: 'card center' }, h('div', { class: 'sticker' }, '🏅'), h('div', {}, x.lemma || x.senseId)))) : empty(t('stickers.none')));
}
