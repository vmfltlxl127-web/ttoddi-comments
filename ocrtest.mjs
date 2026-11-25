import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const TOKEN = process.env.IG_TOKEN.trim(), IGID = '17841404405169869', BASE = 'https://graph.facebook.com/v23.0';
const api = async (p, q = {}) => (await fetch(`${BASE}/${p}?${new URLSearchParams({ ...q, access_token: TOKEN })}`)).json();
const d = await api(`${IGID}/media`, { fields: 'id,caption,timestamp,thumbnail_url,media_url,media_type', limit: 30 });
execSync('sudo apt-get install -y -qq tesseract-ocr tesseract-ocr-kor >/dev/null 2>&1');
for (const m of d.data) {
  const url = m.thumbnail_url || m.media_url; if (!url) continue;
  writeFileSync('t.jpg', Buffer.from(await (await fetch(url)).arrayBuffer()));
  const size = execSync('identify -format "%wx%h" t.jpg').toString();
  execSync('convert t.jpg -resize 200% -colorspace Gray a.png');
  execSync('convert t.jpg -resize 200% -colorspace Gray -negate a2.png');
  const r = f => { try { return execSync(`tesseract ${f} - -l kor+eng --psm 11 2>/dev/null`).toString().replace(/\s+/g, ' ').trim(); } catch (e) { return 'ERR'; } };
  console.log(`\n### ${m.timestamp.slice(0,10)} ${size} | 캡션: ${(m.caption||'').slice(0,40).replace(/\s+/g,' ')}\n A: ${r('a.png')}\n B: ${r('a2.png')}`);
}
