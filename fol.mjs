// 팔로워 특별 숫자 알림 — GitHub Actions에서 5분마다 (앱이 꺼져 있어도 동작)
// 팔로워 수만 가볍게 확인. 확인 사이에 숫자를 건너뛰어도(1312→1314) "지나갔다"고 알려줌
import { readFileSync, writeFileSync } from 'node:fs';
const TOKEN = (process.env.IG_TOKEN || '').trim(), TOPIC = (process.env.NTFY_TOPIC || '').trim();
const IGID = (process.env.IG_ID || '17841404405169869').trim();
const FILE = process.argv[2] || 'folstate.json';
const isIG = TOKEN.startsWith('IG');
const url = isIG ? `https://graph.instagram.com/me?fields=followers_count&access_token=${TOKEN}`
  : `https://graph.facebook.com/v23.0/${IGID}?fields=followers_count&access_token=${TOKEN}`;

function isSpecial(n) {
  const s = String(n);
  if (s.length < 3) return false;
  if (/^(\d)\1+$/.test(s)) return true;          // 2222
  if (/^(\d\d)\1$/.test(s)) return true;          // 1313, 1414
  let up = true, down = true;
  for (let i = 1; i < s.length; i++) { if (+s[i] !== +s[i - 1] + 1) up = false; if (+s[i] !== +s[i - 1] - 1) down = false; }
  return up || down;                              // 1234, 4321
}
const fmt = n => n.toLocaleString('ko-KR');

const d = await (await fetch(url)).json();
const n = d.followers_count;
if (n == null) { console.log('팔로워 확인 실패', JSON.stringify(d.error || d)); process.exit(0); }
let st = { last: null, sent: [] };
try { st = JSON.parse(readFileSync(FILE, 'utf8')); } catch (e) {}
const prev = st.last ?? n;

let msg = '', key = null;
// 1) 특별 숫자에 딱 도착했거나 지나감
let crossed = null;
if (n > prev) for (let k = n; k > prev; k--) if (isSpecial(k)) { crossed = k; break; }
if (crossed == null && isSpecial(n)) crossed = n;
if (crossed != null && !st.sent.includes(crossed)) {
  key = crossed;
  msg = crossed === n ? `🎉 팔로워 ${fmt(n)}명 달성!` : `🎉 팔로워 ${fmt(crossed)}명 넘었어! 지금 ${fmt(n)}명`;
} else if (isSpecial(n + 1) && !st.sent.includes(-(n + 1))) {
  // 2) 한 명만 더
  key = -(n + 1);
  msg = `⏰ 팔로워 ${fmt(n)}명! 한 명만 더 오면 ${fmt(n + 1)}명이야`;
}
if (msg && TOPIC) {
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}?${new URLSearchParams({ title: 'Keysbrown 팔로워', tags: 'tada' })}`, { method: 'POST', body: msg });
  console.log(r.ok ? '알림 보냄: ' + msg : '알림 실패 ' + r.status);
  if (r.ok) st.sent.push(key);
}
// 팔로워가 빠져서 특별 숫자 밑으로 내려가면 다시 알릴 수 있게 지움
st.sent = st.sent.filter(k => k > 0 ? n >= k - 1 : n >= -k - 2).slice(-30);
console.log(`팔로워 ${prev} → ${n}`);
st.last = n;
writeFileSync(FILE, JSON.stringify(st));
