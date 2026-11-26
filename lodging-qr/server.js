// 숙박자 정보 수집 서버 (외부 패키지 없이 Node.js 내장 모듈만 사용)
// 실행: ADMIN_TOKEN=비밀번호 PORT=3000 RETENTION_DAYS=365 node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// 보관 기간(일). 법령 기준은 직접 확인해서 설정하세요. 기본 365일.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 365);
const DATA_FILE = path.join(__dirname, 'data', 'guests.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); // data 폴더가 없으면 생성

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN 환경변수를 설정하세요. 예: ADMIN_TOKEN=secret node server.js');
  process.exit(1);
}

// 필수 항목
const REQUIRED = ['name', 'phone', 'address', 'checkIn', 'checkOut', 'purpose', 'consent', 'signature'];
const PURPOSES = ['관광', '업무', '가족·친지 방문', '기타'];
const PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;
const VEHICLE_RE = /^(\d{2,3}[가-힣]\d{4}|[가-힣]{2}\d{2}[가-힣]\d{4})?$/; // 예: 12가3456, 서울12가3456 (선택 입력)

function validate(body) {
  const errors = [];
  for (const k of REQUIRED) {
    if (body[k] === undefined || body[k] === '' || body[k] === false) errors.push(`${labelOf(k)} 누락`);
  }
  if (body.phone && !PHONE_RE.test(String(body.phone).replace(/\s/g, ''))) errors.push('연락처 형식 확인 (예: 010-1234-5678)');
  if (body.vehicle && !VEHICLE_RE.test(String(body.vehicle).replace(/\s/g, ''))) errors.push('차량번호 형식 확인 (예: 12가3456)');
  if (body.purpose && !PURPOSES.includes(body.purpose)) errors.push('방문목적 값 확인');
  if (body.checkIn && body.checkOut && body.checkOut < body.checkIn) errors.push('퇴실일이 입실일보다 빠름');
  if (body.signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signature)) errors.push('서명 형식 오류');
  if (body.signature && body.signature.length > 300000) errors.push('서명 이미지가 너무 큼');
  if (body.consent !== true) errors.push('개인정보 수집·이용 동의 필요');
  if (Array.isArray(body.companions) && body.companions.length > 19) errors.push('동반인은 최대 19명');
  return errors;
}

function labelOf(k) {
  return ({ name: '성명', phone: '연락처', address: '주소', checkIn: '입실일', checkOut: '퇴실일', purpose: '방문목적', consent: '동의', signature: '서명' })[k] || k;
}

function readBody(req, limit = 512 * 1024) {
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

// 보관기간이 지난 기록 삭제
function purgeExpired() {
  if (!fs.existsSync(DATA_FILE)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const kept = readAll().filter((r) => new Date(r.receivedAt).getTime() >= cutoff);
  fs.writeFileSync(DATA_FILE, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
}

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSV_KEYS = ['receivedAt', 'name', 'phone', 'address', 'vehicle', 'checkIn', 'checkOut', 'purpose', 'gender', 'birth', 'nationality', 'passport', 'companions', 'consentAt'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
  }

  if (req.method === 'POST' && url.pathname === '/api/submit') {
    try {
      const body = JSON.parse(await readBody(req));
      const errors = validate(body);
      if (errors.length) return send(res, 400, 'application/json', JSON.stringify({ ok: false, errors }));
      const now = new Date().toISOString();
      const companions = (Array.isArray(body.companions) ? body.companions : [])
        .map((c) => String(c).trim().slice(0, 50)).filter(Boolean);
      const record = {
        receivedAt: now,
        name: String(body.name).trim().slice(0, 50),
        phone: String(body.phone).replace(/\s/g, '').slice(0, 20),
        address: String(body.address).trim().slice(0, 200),
        vehicle: String(body.vehicle || '').replace(/\s/g, '').slice(0, 20),
        checkIn: String(body.checkIn).slice(0, 10),
        checkOut: String(body.checkOut).slice(0, 10),
        purpose: String(body.purpose),
        gender: ['남', '여'].includes(body.gender) ? body.gender : '',
        birth: String(body.birth || '').slice(0, 10),
        nationality: String(body.nationality || '대한민국').slice(0, 30),
        passport: String(body.passport || '').slice(0, 20),
        companions,
        signature: body.signature,
        consentAt: now,
      };
      purgeExpired();
      fs.appendFileSync(DATA_FILE, JSON.stringify(record) + '\n');
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    } catch (e) {
      return send(res, 400, 'application/json', JSON.stringify({ ok: false, errors: ['잘못된 요청'] }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 401, 'text/plain; charset=utf-8', '인증 실패');
    const all = readAll();
    const rows = all.slice().reverse().map((r) => `<tr>
      <td>${esc(r.receivedAt.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>
      <td>${esc(r.vehicle)}</td><td>${esc(r.address)}</td><td>${esc(r.checkIn)} ~ ${esc(r.checkOut)}</td>
      <td>${esc(r.purpose)}</td><td>${esc(r.companions.length)}명 ${esc(r.companions.join(', '))}</td><td>${r.signature ? `<img src="${r.signature}" alt="서명" style="width:120px;height:auto;background:#fff;border:1px solid #ccc">` : '-'}</td></tr>`).join('');
    const formUrl = `${url.origin}/`;
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>숙박자 명부 관리</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f3f3f3}#qr{margin:8px 0}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#444}}</style></head>
<body><h2>숙박자 명부</h2>
<p>QR을 찍으면 입력 화면으로 이동합니다. 배포 주소가 다르면 서버 주소로 접속해 QR을 다시 만드세요. 보관기간: ${RETENTION_DAYS}일</p>
<div id="qr"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('qr'), {text: ${JSON.stringify(formUrl)}, width: 180, height: 180});</script>
<p>총 ${all.length}건 · <a href="/admin/csv?token=${encodeURIComponent(ADMIN_TOKEN)}">CSV 다운로드</a></p>
<div style="overflow-x:auto"><table><thead><tr><th>접수시각</th><th>성명</th><th>연락처</th><th>차량번호</th><th>주소</th><th>입실~퇴실</th><th>방문목적</th><th>동반인</th><th>서명</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9">아직 접수된 정보가 없습니다.</td></tr>'}</tbody></table></div></body></html>`;
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  if (req.method === 'GET' && url.pathname === '/admin/csv') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 401, 'text/plain; charset=utf-8', '인증 실패');
    const csv = [CSV_KEYS.join(',')]
      .concat(readAll().map((r) => CSV_KEYS.map((k) => {
        const v = Array.isArray(r[k]) ? r[k].join(' / ') : String(r[k] ?? '');
        return `"${v.replace(/"/g, '""')}"`;
      }).join(',')))
      .join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="guests.csv"' });
    return res.end('﻿' + csv);
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (관리자: /admin?token=***, 보관 ${RETENTION_DAYS}일)`));
