// Keysbrown 서버 리포트 — GitHub Actions에서 실행 (앱이 꺼져 있어도 동작)
//  node report.mjs snap    → 좋아요·팔로워 기록만 (매시간)
//  node report.mjs report  → 기록 + 리포트 만들어서 ntfy로 전송 (매일 11시)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKEN = (process.env.IG_TOKEN || '').trim();
const TOPIC = (process.env.NTFY_TOPIC || '').trim();
const IGID = (process.env.IG_ID || '17841404405169869').trim();
const MODE = process.argv[2] || 'snap';
const SNAP_FILE = process.argv[3] || 'snaps.json';
if (!TOKEN) throw new Error('IG_TOKEN 시크릿이 없어');

const isIG = TOKEN.startsWith('IG');
const BASE = isIG ? 'https://graph.instagram.com' : 'https://graph.facebook.com/v23.0';
const USER = isIG ? 'me' : IGID;

async function api(path, params = {}) {
  const url = path.startsWith('http') ? path : `${BASE}/${path}?${new URLSearchParams({ ...params, access_token: TOKEN })}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`인스타 API 오류: ${data.error?.message || res.status}`);
  return data;
}
async function allPages(first, cap = 2000) {
  let out = [], d = first;
  while (true) {
    out = out.concat(d.data || []);
    if (!d.paging?.next || out.length >= cap) break;
    d = await api(d.paging.next);
  }
  return out;
}

// ---- 한국 시간 도우미 ----
const KST = 9 * 3600e3;
const dayStart = t => Math.floor((t + KST) / 864e5) * 864e5 - KST;
const kst = t => new Date(t + KST); // getUTC* 로 읽기
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const num = n => (n ?? 0).toLocaleString('ko-KR');
const short = (s, n = 40) => { s = (s || '(캡션 없음)').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
function isSpecial(n) {
  const s = String(n);
  if (s.length < 3) return false;
  if (/^(\d)\1+$/.test(s)) return true;
  let up = true, down = true;
  for (let i = 1; i < s.length; i++) { if (+s[i] !== +s[i - 1] + 1) up = false; if (+s[i] !== +s[i - 1] - 1) down = false; }
  return up || down;
}
const nextSpecial = n => { for (let k = n + 1; k < n + 200000; k++) if (isSpecial(k)) return k; return null; };

// ---- 데이터 불러오기 ----
const me = await api(USER, { fields: isIG ? 'id,user_id,username,followers_count' : 'id,username,followers_count' });
const myName = (me.username || '').toLowerCase();
const isMine = u => (u || '').toLowerCase() === myName;
const mediaFields = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
const media = (await allPages(await api(`${USER}/media`, { fields: mediaFields, limit: 50 })))
  .filter(m => m.media_type === 'VIDEO' || m.media_product_type === 'REELS')
  .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

// ---- 기록 (앱과 같은 형식: {t, f, m:{릴스id: 좋아요}}) ----
const now = Date.now();
let snaps = [];
if (existsSync(SNAP_FILE)) { try { snaps = JSON.parse(readFileSync(SNAP_FILE, 'utf8')); } catch (e) { snaps = []; } }
snaps.push({ t: now, f: me.followers_count ?? null, m: Object.fromEntries(media.map(m => [m.id, m.like_count || 0])), src: 'server' });
// 최근 2일은 다 남기고, 그 전은 1시간에 1개, 40일까지
const seenH = new Set();
snaps = snaps.filter(x => now - x.t < 40 * 864e5).reverse()
  .filter(x => { if (now - x.t < 2 * 864e5) return true; const h = Math.floor(x.t / 3600e3); if (seenH.has(h)) return false; seenH.add(h); return true; })
  .reverse();
writeFileSync(SNAP_FILE, JSON.stringify(snaps));
console.log(`기록 저장: 릴스 ${media.length}개, 팔로워 ${me.followers_count}, 기록 ${snaps.length}개`);
if (MODE !== 'report') process.exit(0);

// ---- 댓글 (하루 댓글 수 · 답 안 단 댓글 수) ----
const comments = [];
const todo = media.filter(m => m.comments_count);
await Promise.all(Array.from({ length: 4 }, async () => {
  while (todo.length) {
    const m = todo.shift();
    const first = await api(`${m.id}/comments`, { fields: 'id,text,username,timestamp,replies.limit(50){username}', limit: 50 });
    (await allPages(first)).forEach(c => comments.push({ ...c, mediaId: m.id, replies: c.replies?.data || [] }));
  }
}));

function dayStats(days, ids) {
  ids = new Set(ids);
  return days.map(d0 => {
    const d1 = d0 + 864e5;
    const before = [...snaps].reverse().find(x => x.t < d0);
    const end = [...snaps].reverse().find(x => x.t < d1 && x.t >= d0) || null;
    const first = snaps.find(x => x.t >= d0 && x.t < d1);
    let like = null, fol = null;
    if (end) {
      const base = before || first;
      like = 0;
      for (const id of ids) {
        const m = media.find(x => x.id === id); if (!m) continue;
        const born = new Date(m.timestamp).getTime();
        const a = base.m[id] ?? (born >= (before ? before.t : d0) ? 0 : null);
        const b = end.m[id]; if (a == null || b == null) continue;
        like += Math.max(0, b - a);
      }
      if (end.f != null && base.f != null) fol = end.f - base.f;
      if (!before && base === end) { like = like || null; fol = fol || null; }
    }
    const cmt = comments.filter(c => ids.has(c.mediaId) && !isMine(c.username)).filter(c => { const t = new Date(c.timestamp).getTime(); return t >= d0 && t < d1; }).length;
    return { like, cmt, fol };
  });
}

const today = dayStart(now), yest = today - 864e5;
const [y, t] = dayStats([yest, today], media.map(m => m.id));
const latest = media[0];
const [ly] = latest ? dayStats([yest], [latest.id]) : [{}];
const per = media.map(m => ({ m, r: dayStats([yest], [m.id])[0] })).filter(x => (x.r.like ?? 0) > 0 || x.r.cmt > 0)
  .sort((a, b) => ((b.r.like ?? 0) + b.r.cmt * 5) - ((a.r.like ?? 0) + a.r.cmt * 5)).slice(0, 3);
const isTag = c => { const s = (c.text || '').trim(); return /^@[\w.]+/.test(s) && !s.toLowerCase().startsWith('@' + myName); };
const pendingN = comments.filter(c => !isMine(c.username) && !c.replies.some(r => isMine(r.username)) && !isTag(c)).length;

const f = v => v == null ? '기록 없음' : (v > 0 ? '+' : '') + num(v);
const fol = me.followers_count, nx = fol != null ? nextSpecial(fol) : null;
const d = kst(now);
const lines = [
  `📊 Keysbrown 리포트 ${d.getUTCMonth() + 1}/${d.getUTCDate()} (${DOW[d.getUTCDay()]})`,
  '',
  `👥 팔로워 ${fol != null ? num(fol) : '-'}명 · 어제 ${f(y.fol)}${nx ? ` · ${num(nx)}까지 ${num(nx - fol)}명` : ''}`,
  `📅 어제 하루 (릴스 ${media.length}개)`,
  `   ♥ ${f(y.like)}   💬 ${f(y.cmt)}`,
  `☀️ 오늘 지금까지  ♥ ${f(t.like)}   💬 ${f(t.cmt)}`,
  '',
  latest ? `🆕 최신 영상 · ${short(latest.caption, 22)}` : '',
  latest ? `   어제 ♥ ${f(ly.like)} 💬 ${f(ly.cmt)} · 누적 ♥ ${num(latest.like_count)} 💬 ${num(latest.comments_count)}` : '',
  '',
  per.length ? '🏆 어제 많이 오른 영상' : '',
  ...per.map((x, i) => `${i + 1}. ${short(x.m.caption, 20)} ♥ ${f(x.r.like)} 💬 ${f(x.r.cmt)}`),
  '',
  `📮 답 안 단 댓글 ${num(pendingN)}개`
].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
const text = lines.join('\n').trim();
console.log(text);

if (!TOPIC) throw new Error('NTFY_TOPIC 시크릿이 없어 — 리포트는 만들었는데 폰으로는 못 보냈어');
const r = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}?${new URLSearchParams({ title: 'Keysbrown', tags: 'bar_chart' })}`, { method: 'POST', body: text });
if (!r.ok) throw new Error('ntfy 전송 실패 ' + r.status);
console.log('폰으로 보냄');
