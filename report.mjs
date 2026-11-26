// Keysbrown 서버 리포트 — GitHub Actions에서 실행 (앱이 꺼져 있어도 동작)
//  node report.mjs snap    → 좋아요·팔로워 기록만 (매시간)
//  node report.mjs report  → 기록 + 리포트 만들어서 ntfy로 전송 (매일 11시)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKEN = (process.env.IG_TOKEN || '').trim();
const TOPIC = (process.env.NTFY_TOPIC || '').trim();
const IGID = (process.env.IG_ID || '17841404405169869').trim();
let MODE = process.argv[2] || 'snap';
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
  if (/^(\d\d)\1$/.test(s)) return true; // 1313, 1414, 1515 (두 자리 반복)
  let up = true, down = true;
  for (let i = 1; i < s.length; i++) { if (+s[i] !== +s[i - 1] + 1) up = false; if (+s[i] !== +s[i - 1] - 1) down = false; }
  return up || down;
}
const nextSpecial = n => { for (let k = n + 1; k < n + 200000; k++) if (isSpecial(k)) return k; return null; };

// ---- 데이터 불러오기 ----
const me = await api(USER, { fields: isIG ? 'id,user_id,username,followers_count' : 'id,username,followers_count' });
const myName = (me.username || '').toLowerCase();
const isMine = u => (u || '').toLowerCase() === myName;
const mediaFields = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url';
const media = (await allPages(await api(`${USER}/media`, { fields: mediaFields, limit: 50 })))
  .filter(m => m.media_type === 'VIDEO' || m.media_product_type === 'REELS')
  .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

// ---- 표지 제목 자동 인식 (제미나이) ----
const GEMINI = (process.env.GEMINI_API_KEY || '').trim();
const AUTO_FILE = 'autotitles.json';
let MANUAL = {}, AUTO = {};
try { MANUAL = JSON.parse(readFileSync(new URL('./titles.json', import.meta.url), 'utf8')); } catch (e) {}
try { AUTO = JSON.parse(readFileSync(AUTO_FILE, 'utf8')); } catch (e) {}
const PROMPT = '이 이미지는 인스타그램 릴스 표지야. 표지에 가장 크게 쓰인 메인 제목 문구만 표지에 적힌 그대로 적어줘. 줄바꿈은 띄어쓰기로 바꾸고, 작은 부가 글씨·워터마크·가격표·상품명 같은 배경 글씨는 빼. 설명 없이 제목만 답해. 제목 글자가 없으면 없음 이라고만 답해.';
async function readCover(m) {
  const img = await fetch(m.thumbnail_url);
  if (!img.ok) throw new Error('표지 다운로드 실패 ' + img.status);
  const data = Buffer.from(await img.arrayBuffer()).toString('base64');
  let lastErr;
  const models = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
  for (const model of [...models, ...models]) { // 바쁘면 다른 모델로, 한 바퀴 더
    if (lastErr) await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data } }] }], generationConfig: { temperature: 0 } })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').replace(/\s+/g, ' ').trim(); return /^없음\.?$/.test(t) ? '' : t; }
    lastErr = `${model}: ${j.error?.message || r.status}`;
    if ([400, 401, 403].includes(r.status)) break; // 키 문제는 바꿔도 소용없음
  }
  throw new Error(lastErr);
}
async function autoTitles(list) {
  if (!GEMINI) return;
  for (const m of list) {
    if (!m.thumbnail_url) continue;
    try { AUTO[m.id] = await readCover(m); console.log(`표지 제목: ${m.id} → ${AUTO[m.id] || '(제목 없음)'}`); }
    catch (e) { console.log(`표지 인식 실패 ${m.id}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 4500)); // 무료 한도(분당 요청 수) 여유
  }
  writeFileSync(AUTO_FILE, JSON.stringify(AUTO, null, 1));
}
if (MODE === 'debugcmt') {
  const who = (process.env.WHO || '').split(',');
  for (const m of media.slice(0, 8)) {
    const first = await api(`${m.id}/comments`, { fields: 'id,text,username,timestamp,like_count,hidden,replies.limit(50){id,text,username}', limit: 50 });
    for (const c of await allPages(first)) if (who.includes(c.username)) console.log(JSON.stringify({ media: m.id, c }));
  }
  process.exit(0);
}
if (MODE === 'titletest') {
  const sample = media.filter(m => MANUAL[m.id]).slice(0, Number(process.argv[4] || 8));
  for (const m of sample) {
    try { const t = await readCover(m); console.log(`${t === MANUAL[m.id] ? '✅' : '🔸'} 제미나이: ${t}\n   직접 넣은 것: ${MANUAL[m.id]}`); }
    catch (e) { console.log('❌ ' + e.message); }
    await new Promise(r => setTimeout(r, 4500));
  }
  process.exit(0);
}
// 제목 없는 새 릴스만 인식 (한 번 읽으면 저장해두고 다시 안 읽음)
await autoTitles(media.filter(m => !MANUAL[m.id] && !(m.id in AUTO)).slice(0, 5));

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
const SENT_FILE = 'lastreport.txt';
const todayKey = (() => { const d = kst(now); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; })();
const lastSent = existsSync(SENT_FILE) ? readFileSync(SENT_FILE, 'utf8').trim() : '';
if (MODE === 'snap' && kst(now).getUTCHours() >= 9 && lastSent !== todayKey) { MODE = 'report'; console.log('오늘 리포트 아직 안 보냄 → 지금 보냄'); }
if (MODE === 'report' && lastSent === todayKey && process.env.FORCE !== '1') { console.log('오늘 리포트 이미 보냄 → 건너뜀'); MODE = 'snap'; }
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

const titleOf = (m, n = 26) => short(MANUAL[m.id] || AUTO[m.id] || (m.caption || '').split('\n')[0].replace(/#\S+/g, '').trim(), n);
const md = t => { const x = kst(t); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };

const today = dayStart(now), yest = today - 864e5;
const [y] = dayStats([yest], media.map(m => m.id));
// 최신 영상 = 가장 최근에 올린 날의 영상 전부
const lastDay = media.length ? dayStart(new Date(media[0].timestamp).getTime()) : null;
const latest = media.filter(m => dayStart(new Date(m.timestamp).getTime()) === lastDay);
const g = v => v == null ? '-' : (v > 0 ? '+' : '') + num(v);
const yd = kst(yest);
// 제목 줄이기: 앞에서부터 단어 단위로 8글자까지만, 잘리면 ...
const shortT = (s, max = 8) => {
  s = (s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let out = '';
  for (const w of s.split(' ')) { const nx = out ? out + ' ' + w : w; if (nx.length > max) break; out = nx; }
  return (out || s.slice(0, max)) + '...';
};
const lines = [
  `👤 ${g(y.fol)}  🩷 ${g(y.like)}  💬 ${g(y.cmt)}`,
  '',
  ...latest.map(m => { const r = dayStats([yest], [m.id])[0]; return `🆕 ${shortT(titleOf(m, 200))} 🩷${g(r.like)} 💬${g(r.cmt)}`; })
];
const text = lines.join('\n').trim();
console.log(text);

if (!TOPIC) throw new Error('NTFY_TOPIC 시크릿이 없어 — 리포트는 만들었는데 폰으로는 못 보냈어');
const r = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}?${new URLSearchParams({ title: '📊 어제 성과 리포트' })}`, { method: 'POST', body: text });
if (!r.ok) throw new Error('ntfy 전송 실패 ' + r.status);
writeFileSync(SENT_FILE, todayKey); console.log('폰으로 보냄');
