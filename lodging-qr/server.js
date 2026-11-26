// 숙박자 정보 수집 서버 (외부 패키지 없이 Node.js 내장 모듈만 사용)
// 실행: ADMIN_TOKEN=원하는비밀번호 PORT=3000 node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATA_FILE = path.join(__dirname, 'data', 'guests.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN 환경변수를 설정하세요. 예: ADMIN_TOKEN=secret node server.js');
  process.exit(1);
}

const REQUIRED = ['name', 'birth', 'phone', 'address', 'checkIn', 'checkOut', 'headcount', 'consent'];

function validate(body) {
  const errors = [];
  for (const k of REQUIRED) {
    if (body[k] === undefined || body[k] === '' || body[k] === false) errors.push(`${k} 누락`);
  }
  if (body.consent !== true) errors.push('개인정보 수집·이용 동의 필요');
  if (body.checkIn && body.checkOut && body.checkOut < body.checkIn) errors.push('퇴실일이 입실일보다 빠름');
  const hc = Number(body.headcount);
  if (!Number.isInteger(hc) || hc < 1 || hc > 20) errors.push('인원은 1~20명');
  return errors;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 입력 폼
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
  }

  // 제출 처리
  if (req.method === 'POST' && url.pathname === '/api/submit') {
    try {
      const body = JSON.parse(await readBody(req));
      const errors = validate(body);
      if (errors.length) return send(res, 400, 'application/json', JSON.stringify({ ok: false, errors }));
      const record = {
        receivedAt: new Date().toISOString(),
        name: String(body.name).trim().slice(0, 50),
        birth: String(body.birth).slice(0, 10),
        nationality: String(body.nationality || '대한민국').slice(0, 30),
        phone: String(body.phone).slice(0, 20),
        address: String(body.address).trim().slice(0, 200),
        checkIn: String(body.checkIn).slice(0, 10),
        checkOut: String(body.checkOut).slice(0, 10),
        headcount: Number(body.headcount),
        vehicle: String(body.vehicle || '').slice(0, 20),
        passport: String(body.passport || '').slice(0, 20),
      };
      fs.appendFileSync(DATA_FILE, JSON.stringify(record) + '\n');
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    } catch (e) {
      return send(res, 400, 'application/json', JSON.stringify({ ok: false, errors: ['잘못된 요청'] }));
    }
  }

  // 관리자 화면 (토큰 필요)
  if (req.method === 'GET' && url.pathname === '/admin') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 401, 'text/plain; charset=utf-8', '인증 실패');
    const rows = readAll().reverse().map((r) => `<tr>
      <td>${esc(r.receivedAt.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.name)}</td><td>${esc(r.birth)}</td>
      <td>${esc(r.nationality)}</td><td>${esc(r.phone)}</td><td>${esc(r.address)}</td>
      <td>${esc(r.checkIn)} ~ ${esc(r.checkOut)}</td><td>${esc(r.headcount)}</td><td>${esc(r.vehicle)}</td><td>${esc(r.passport)}</td></tr>`).join('');
    const formUrl = `${url.origin}/`;
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>숙박자 명부 관리</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f3f3f3}#qr{margin:8px 0}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#444}}</style></head>
<body><h2>숙박자 명부</h2>
<p>QR 코드를 찍으면 입력 화면으로 이동합니다. 실제 배포 시 주소를 <b>${esc(formUrl)}</b> 로 바꿔 QR을 다시 만드세요.</p>
<div id="qr"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('qr'), {text: ${JSON.stringify(formUrl)}, width: 180, height: 180});</script>
<p>총 ${readAll().length}건 · <a href="/admin/csv?token=${encodeURIComponent(ADMIN_TOKEN)}">CSV 다운로드</a></p>
<div style="overflow-x:auto"><table><thead><tr><th>접수시각</th><th>성명</th><th>생년월일</th><th>국적</th><th>연락처</th><th>주소</th><th>입실~퇴실</th><th>인원</th><th>차량</th><th>여권</th></tr></thead>
<tbody>${rows || '<tr><td colspan="10">아직 접수된 정보가 없습니다.</td></tr>'}</tbody></table></div></body></html>`;
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  // CSV 다운로드 (토큰 필요)
  if (req.method === 'GET' && url.pathname === '/admin/csv') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 401, 'text/plain; charset=utf-8', '인증 실패');
    const keys = ['receivedAt', 'name', 'birth', 'nationality', 'phone', 'address', 'checkIn', 'checkOut', 'headcount', 'vehicle', 'passport'];
    const csv = [keys.join(',')]
      .concat(readAll().map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="guests.csv"' });
    return res.end('﻿' + csv);
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (관리자: /admin?token=***)`));
