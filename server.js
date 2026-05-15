require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const webpush    = require('web-push');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch { console.warn('[puppeteer] 미설치'); }

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SEC) || 86400) * 1000;

// ── 인메모리 캐시 ─────────────────────────────────────────
let _cache = null; // { data: [...], ts: Date.now() }
const _annContentCache = new Map(); // url → { content, ts }
const ANN_CACHE_TTL = 24 * 60 * 60 * 1000;

// ── VAPID (웹 푸시) 설정 ───────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@example.com';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('[VAPID] 웹 푸시 설정 완료');
} else {
  console.warn('[VAPID] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 미설정 — 푸시 비활성');
}

// ── 사용자 알림 데이터 ─────────────────────────────────────
// Render 영구 디스크 사용 시 DATA_DIR=/data 환경변수로 지정
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SUBS_FILE  = path.join(DATA_DIR, 'subscriptions.json');

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { return []; }
}

function saveUsers(users) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) { console.error('[사용자 저장 오류]', e.message); }
}

function loadSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return [];
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch { return []; }
}

function saveSubs(subs) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf8');
  } catch (e) { console.error('[구독 저장 오류]', e.message); }
}

// ── 매칭 로직 (프론트와 동일 기준) ───────────────────────
function matchesUser(ann, conditions) {
  const { interestRegions = [], budgetLimit = 0 } = conditions;
  if (interestRegions.length > 0) {
    const ok = interestRegions.some(r => {
      const [sido, sigungu] = r.split(' ');
      return ann.location.sido === sido &&
             (!sigungu || ann.location.sigungu.includes(sigungu));
    });
    if (!ok) return false;
  }
  if (budgetLimit > 0) {
    const prices = (ann.houseTypes || []).map(h => h.price).filter(p => p > 0);
    if (prices.length > 0 && Math.min(...prices) > budgetLimit) return false;
  }
  return true;
}

// ── 이메일 발송 ────────────────────────────────────────────
function getMailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
}

async function sendNotificationEmail(email, matches) {
  const mailer = getMailer();
  if (!mailer) { console.warn('[메일] GMAIL_USER/GMAIL_PASS 미설정'); return false; }

  const rows = matches.map(ann => {
    const prices = (ann.houseTypes || []).map(h => h.price).filter(p => p > 0);
    const priceStr = prices.length ? `${Math.min(...prices).toLocaleString()}만원~` : '공고 확인';
    return `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${ann.name}</div>
        <div style="color:#64748b;font-size:12px;margin-bottom:2px;">📍 ${ann.location.sido} ${ann.location.sigungu} · ${ann.type}주택</div>
        <div style="color:#64748b;font-size:12px;margin-bottom:8px;">📅 공고일 ${ann.schedule.announcement||'-'} · 접수 ${ann.schedule.special||ann.schedule.general||'-'}</div>
        <div style="color:#10b981;font-weight:700;font-size:13px;margin-bottom:8px;">💰 분양가 ${priceStr}</div>
        ${ann.url ? `<a href="${ann.url}" style="font-size:12px;color:#3b82f6;">공고 상세 보기 →</a>` : ''}
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:'-apple-system',sans-serif;background:#f8fafc;margin:0;padding:20px;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
      <div style="background:#0f172a;padding:24px;text-align:center;">
        <div style="font-size:22px;margin-bottom:4px;">🏠</div>
        <div style="color:#fff;font-weight:700;font-size:18px;">청약도우미 알림</div>
      </div>
      <div style="padding:24px;">
        <p style="color:#334155;font-size:14px;margin-bottom:20px;">등록하신 조건에 맞는 청약 공고가 <strong>${matches.length}건</strong> 있습니다.</p>
        ${rows}
      </div>
      <div style="background:#f8fafc;padding:16px;text-align:center;font-size:11px;color:#94a3b8;">
        청약도우미 · 수신 거부는 앱 설정 → 이메일 알림 → 해지
      </div>
    </div>
  </body></html>`;

  await mailer.sendMail({
    from: `"청약도우미" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `[청약도우미] 조건 맞는 공고 ${matches.length}건 알림`,
    html,
  });
  return true;
}

// ── 웹 푸시 발송 ──────────────────────────────────────────
async function sendPushNotifications(announcements) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const subs = loadSubs();
  if (!subs.length) return;

  const dead = [];
  let updated = false;

  for (const sub of subs) {
    const newMatches = announcements.filter(ann =>
      matchesUser(ann, sub.conditions) && !sub.notifiedIds.includes(ann.id)
    );
    if (!newMatches.length) continue;

    const payload = JSON.stringify({
      title: `청약도우미 — 새 공고 ${newMatches.length}건`,
      body:  newMatches.slice(0, 3).map(a => a.name).join('\n'),
      url:   '/',
    });

    try {
      await webpush.sendNotification(sub.subscription, payload);
      sub.notifiedIds.push(...newMatches.map(a => a.id));
      console.log(`[푸시] 발송 ${newMatches.length}건`);
      updated = true;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.subscription.endpoint);
      console.error('[푸시 오류]', e.statusCode, e.message);
    }
  }

  const finalSubs = dead.length ? subs.filter(s => !dead.includes(s.subscription.endpoint)) : subs;
  if (updated || dead.length) saveSubs(finalSubs);
}

// ── 알림 발송 메인 ─────────────────────────────────────────
async function sendNotifications(announcements) {
  const users = loadUsers();
  if (!users.length) return;

  let updated = false;
  for (const u of users) {
    const newMatches = announcements.filter(ann =>
      matchesUser(ann, u.conditions) && !u.notifiedIds.includes(ann.id)
    );
    if (!newMatches.length) continue;
    try {
      await sendNotificationEmail(u.email, newMatches);
      u.notifiedIds.push(...newMatches.map(a => a.id));
      console.log(`[알림] ${u.email} → ${newMatches.length}건 발송`);
      updated = true;
    } catch (e) {
      console.error(`[알림 오류] ${u.email}:`, e.message);
    }
  }
  if (updated) saveUsers(users);
}

// ── 청약홈 API 기본값 ─────────────────────────────────────
// data.go.kr 서비스: 한국부동산원_청약홈 분양정보 조회 서비스 (15098547)
// Base URL: api.odcloud.kr/api  서비스명: ApplyhomeInfoDetailSvc
const APT_API_BASE = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1';

/* ═══════════════════════════════════════════════
   헬퍼 함수
═══════════════════════════════════════════════ */
// YYYYMMDD → YYYY-MM-DD
function fmtDate(raw) {
  if (!raw || String(raw).length < 8) return raw ? String(raw) : '';
  const s = String(raw);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

// YYYYMM → YYYY-MM
function fmtYM(raw) {
  if (!raw || String(raw).length < 6) return raw ? String(raw) : '';
  const s = String(raw);
  return `${s.slice(0,4)}-${s.slice(4,6)}`;
}

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

function toFloat(v, def = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

// "서울특별시 강동구 천호동..." → sido: "서울", sigungu: "강동구"
const SIDO_MAP = {
  '서울':'서울', '경기':'경기', '인천':'인천', '부산':'부산',
  '대구':'대구', '광주':'광주', '대전':'대전', '울산':'울산',
  '세종':'세종', '강원':'강원', '충북':'충북', '충남':'충남',
  '전북':'전북', '전남':'전남', '경북':'경북', '경남':'경남', '제주':'제주'
};
const FULL_SIDO_MAP = {
  '서울특별시':'서울','경기도':'경기','인천광역시':'인천',
  '부산광역시':'부산','대구광역시':'대구','광주광역시':'광주',
  '대전광역시':'대전','울산광역시':'울산','세종특별자치시':'세종',
  '강원도':'강원','강원특별자치도':'강원','충청북도':'충북',
  '충청남도':'충남','전라북도':'전북','전북특별자치도':'전북',
  '전라남도':'전남','경상북도':'경북','경상남도':'경남','제주특별자치도':'제주'
};
function parseSido(areaCodeNm = '', addr = '') {
  // 1) SUBSCRPT_AREA_CODE_NM 우선 (예: "서울특별시")
  for (const [full, short] of Object.entries(FULL_SIDO_MAP)) {
    if (areaCodeNm.includes(full)) return short;
  }
  // 2) 축약명 직접 매핑
  for (const short of Object.keys(SIDO_MAP)) {
    if (areaCodeNm.startsWith(short)) return short;
  }
  // 3) 주소 첫 토큰에서 추출
  const firstToken = addr.split(/\s+/)[0] || '';
  for (const [full, short] of Object.entries(FULL_SIDO_MAP)) {
    if (firstToken.includes(full) || full.includes(firstToken)) return short;
  }
  return areaCodeNm.slice(0, 2) || '기타';
}

function parseSigungu(addr = '') {
  // "서울특별시 강동구 천호동 123" → "강동구"
  const parts = addr.replace(/\s+/g,' ').trim().split(' ');
  return parts[1] || parts[0] || '';
}

// 주택구분코드 → '민영' / '공공'
// 01: 민영, 02: 조합, 04: 공공분양, 05: 공공임대, 06: 국민임대 등
function parseType(houseSecd = '') {
  return ['04','05','06','07','08'].includes(String(houseSecd).trim()) ? '공공' : '민영';
}

// 규제지역 여부 — API 미제공 필드, 주소 기반 휴리스틱 적용
// 실 운영 시 별도 규제지역 목록 유지 권장
const REGULATED_SIDOS = ['서울'];
const REGULATED_SIGUNGUS = [
  '과천시','성남시분당구','광명시','하남시','수원시','안양시','의왕시',
  '군포시','의정부시','용인시수지구','용인시기흥구'
];
function isRegulated(sido, sigungu) {
  if (REGULATED_SIDOS.includes(sido)) return true;
  if (REGULATED_SIGUNGUS.some(s => sigungu.includes(s.replace(/시|구/g,'')))) return true;
  return false;
}

/* ═══════════════════════════════════════════════
   API 응답 → 앱 데이터 모델 변환
   새 API: ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail
   응답 구조: { data: [...], totalCount, page, perPage }
   날짜 필드가 이미 YYYY-MM-DD 형식
═══════════════════════════════════════════════ */

function transformItem(f) {
  const sido    = parseSido(f.SUBSCRPT_AREA_CODE_NM || '', f.HSSPLY_ADRES || '');
  const sigungu = parseSigungu(f.HSSPLY_ADRES || '');
  const type    = f.HOUSE_DTL_SECD === '03' ? '공공' : '민영';

  const tags = [sido];
  if (type === '공공') tags.push('공공분양');
  if (isRegulated(sido, sigungu)) tags.push('규제지역');
  if (f.BSNS_MBY_NM) {
    if (f.BSNS_MBY_NM.includes('LH') || f.BSNS_MBY_NM.includes('한국토지')) tags.push('LH');
    if (f.BSNS_MBY_NM.includes('SH') || f.BSNS_MBY_NM.includes('서울주택')) tags.push('SH');
  }

  // MVN_PREARNGE_YM: "202908" → "2029-08"
  const moveIn = f.MVN_PREARNGE_YM
    ? `${String(f.MVN_PREARNGE_YM).slice(0,4)}-${String(f.MVN_PREARNGE_YM).slice(4,6)}`
    : '';

  return {
    id:         f.HOUSE_MANAGE_NO || f.PBLANC_NO || String(Date.now() + Math.random()),
    name:       f.HOUSE_NM || '(주택명 미제공)',
    location: {
      sido,
      sigungu,
      address: f.HSSPLY_ADRES || `${sido} ${sigungu}`,
    },
    type,
    totalUnits: toInt(f.TOT_SUPLY_HSHLDCO),
    buildings:  0,
    maxFloor:   0,
    schedule: {
      announcement: f.RCRIT_PBLANC_DE   || '',
      special:      f.SPSPLY_RCEPT_BGNDE || '',
      general:      f.GNRL_RNK1_CRSPAREA_RCPTDE || f.GNRL_RNK1_ETC_AREA_RCPTDE || '',
      winner:       f.PRZWNER_PRESNATN_DE || '',
      contract:     f.CNTRCT_CNCLS_BGNDE || '',
      moveIn,
    },
    restrictions: {
      regulated: isRegulated(sido, sigungu),
      resale:    0,
      reapply:   0,
      residence: 0,
    },
    houseTypes: [],
    eligibility: {
      incomeFirst: type === '공공' ? 130 : 160,
      incomeYouth: type === '공공' ? 100 : 140,
      asset: type === '공공' ? 215500 : 330000,
      ltv:   sido === '서울' && isRegulated(sido, sigungu) ? 0 : 70,
    },
    payment: { down: 10, mid: [], bal: 30 },
    tags,
    url: f.PBLANC_URL || '',
  };
}

/* ═══════════════════════════════════════════════
   주택형별 분양가 조회 (getAPTLttotPblancMdl)
   HOUSE_TY 예: "055.8600A" → 전용 55.86㎡ A형
   LTTOT_TOP_AMOUNT: 분양가 최고금액 (만원)
═══════════════════════════════════════════════ */
function parseHouseTy(raw) {
  const s = String(raw || '');
  const m = s.match(/^0*(\d+\.\d+)([A-Za-z]*)$/);
  if (m) {
    const area = parseFloat(m[1]);
    const letter = m[2].toUpperCase();
    return { area, name: `${Math.floor(area)}${letter}형` };
  }
  return { area: 0, name: s };
}

async function fetchHouseTypes(apiKey) {
  // 5페이지(500건) 병렬 수집 → 최근 공고의 주택형 대부분 커버
  const pages = [1, 2, 3, 4, 5];
  const responses = await Promise.all(
    pages.map(page =>
      axios.get(`${APT_API_BASE}/getAPTLttotPblancMdl`, {
        params: { serviceKey: apiKey, page, perPage: 100 },
        timeout: 15000,
      }).then(r => r.data?.data || []).catch(() => [])
    )
  );

  const map = {};
  for (const f of responses.flat()) {
    const key = f.PBLANC_NO || f.HOUSE_MANAGE_NO;
    if (!key) continue;
    if (!map[key]) map[key] = [];
    const { area, name } = parseHouseTy(f.HOUSE_TY);
    map[key].push({
      t:     name,
      area:  toFloat(f.SUPLY_AR),   // 공급면적(㎡)
      exclArea: area,               // 전용면적(㎡)
      price: toInt(f.LTTOT_TOP_AMOUNT),
      units: toInt(f.SPSPLY_HSHLDCO) + toInt(f.SUPLY_HSHLDCO),
    });
  }
  console.log(`[주택형] ${Object.keys(map).length}개 공고 주택형 수집`);
  return map;
}

/* ═══════════════════════════════════════════════
   청약홈 API 호출
═══════════════════════════════════════════════ */
async function fetchFromAPI(apiKey) {
  // 공고 목록 + 주택형 병렬 수집
  const [responses, houseTypeMap] = await Promise.all([
    Promise.all(
      [1, 2, 3].map(page =>
        axios.get(`${APT_API_BASE}/getAPTLttotPblancDetail`, {
          params: { serviceKey: apiKey, page, perPage: 100 },
          timeout: 15000,
        }).then(r => r.data?.data || []).catch(() => [])
      )
    ),
    fetchHouseTypes(apiKey).catch(() => ({})),
  ]);

  const allItems = responses.flat();
  if (!allItems.length) {
    console.warn('[청약홈 API] 응답 항목 0건.');
    return [];
  }

  // 접수 종료일이 오늘 이후이거나, 모집공고일이 최근 90일 이내인 공고만 유지
  const today = new Date().toISOString().slice(0, 10);
  const past90 = new Date();
  past90.setDate(past90.getDate() - 90);
  const past90Str = past90.toISOString().slice(0, 10);

  const filtered = allItems.filter(f => {
    const endde = f.RCEPT_ENDDE || '';
    const announced = f.RCRIT_PBLANC_DE || '';
    return (endde >= today) || (announced >= past90Str);
  });

  const result = (filtered.length ? filtered : allItems.slice(0, 100))
    .map(f => {
      const item = transformItem(f);
      const key = f.PBLANC_NO || f.HOUSE_MANAGE_NO;
      if (key && houseTypeMap[key]) item.houseTypes = houseTypeMap[key];
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => (b.schedule.announcement || '').localeCompare(a.schedule.announcement || ''));

  const withTypes = result.filter(r => r.houseTypes.length > 0).length;
  console.log(`[API] 전체 ${allItems.length}건 수집 → 필터 후 ${result.length}건 (주택형 연동: ${withTypes}건)`);
  return result;
}

/* ═══════════════════════════════════════════════
   라우트
═══════════════════════════════════════════════ */
// CORS 허용 (브라우저에서 직접 API 호출 시 대비)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/announcements', async (req, res) => {
  // 캐시 유효하면 즉시 반환
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL_MS) {
    return res.json({ ok: true, cached: true, count: _cache.data.length, data: _cache.data });
  }

  const apiKey = process.env.APT_API_KEY;
  if (!isKeySet()) {
    return res.json({
      ok:    false,
      error: 'APT_API_KEY가 .env에 설정되지 않았습니다. data.go.kr에서 키를 발급받아 .env에 입력하세요.',
      data:  [],
    });
  }

  try {
    console.log('[API] 청약홈 API 호출 중...');
    const data = await fetchFromAPI(apiKey);
    _cache = { data, ts: Date.now() };
    console.log(`[API] 완료: ${data.length}건 수집`);
    res.json({ ok: true, cached: false, count: data.length, data });
  } catch (err) {
    const errMsg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    console.error('[API Error]', errMsg);
    res.status(502).json({ ok: false, error: errMsg, data: [] });
  }
});

// ── 푸시 알림 라우트 ──────────────────────────────────────
app.use(express.json());

app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ ok: false, error: 'VAPID 미설정' });
  res.json({ ok: true, key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, conditions } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ ok: false, error: 'subscription 없음' });
  const subs = loadSubs();
  const idx  = subs.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const entry = {
    subscription,
    conditions: {
      interestRegions: conditions?.interestRegions || [],
      budgetLimit:     conditions?.budgetLimit     || 0,
    },
    notifiedIds:  idx >= 0 ? subs[idx].notifiedIds : [],
    registeredAt: new Date().toISOString(),
  };
  if (idx >= 0) subs[idx] = entry; else subs.push(entry);
  saveSubs(subs);
  res.json({ ok: true });
});

app.delete('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  saveSubs(loadSubs().filter(s => s.subscription.endpoint !== endpoint));
  res.json({ ok: true });
});

// ── 이메일 알림 등록 / 해지 / 상태 ──────────────────────────────

app.post('/api/notify/register', (req, res) => {
  const { email, conditions } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: '유효하지 않은 이메일' });
  }
  const users = loadUsers();
  const idx = users.findIndex(u => u.email === email);
  const entry = {
    email,
    conditions: {
      interestRegions: conditions?.interestRegions || [],
      budgetLimit:     conditions?.budgetLimit     || 0,
    },
    notifiedIds:  idx >= 0 ? users[idx].notifiedIds : [],
    registeredAt: new Date().toISOString(),
  };
  if (idx >= 0) users[idx] = entry; else users.push(entry);
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/notify/unregister', (req, res) => {
  const { email } = req.body;
  const users = loadUsers().filter(u => u.email !== email);
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/notify/status', (req, res) => {
  const { email } = req.query;
  const user = loadUsers().find(u => u.email === email);
  res.json({ ok: true, registered: !!user, conditions: user?.conditions || null });
});

// 공고문 내용 스크래핑 (puppeteer)
app.get('/api/announcement-content', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, content: '' });

  const cached = _annContentCache.get(url);
  if (cached && Date.now() - cached.ts < ANN_CACHE_TTL) {
    return res.json({ ok: true, cached: true, content: cached.content });
  }

  if (!puppeteer) {
    return res.json({ ok: false, content: '', error: 'puppeteer 미설치' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--single-process', '--no-zygote',
      ],
    });
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(25000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle0' });

    const content = await page.evaluate(() => {
      const text = document.body.innerText || '';
      // 무주택세대구성원 조항 주변 2500자 추출
      const idx = text.indexOf('무주택세대구성원');
      if (idx !== -1) return text.substring(Math.max(0, idx - 300), idx + 2500);
      // 직계존속 관련 조항 검색
      const idx2 = text.indexOf('직계존속');
      if (idx2 !== -1) return text.substring(Math.max(0, idx2 - 300), idx2 + 2500);
      return text.slice(0, 3000);
    });

    _annContentCache.set(url, { content, ts: Date.now() });
    console.log(`[공고문] 스크래핑 완료: ${url.slice(0, 60)}...`);
    res.json({ ok: true, cached: false, content });
  } catch (err) {
    console.error('[공고문 스크래핑 오류]', err.message);
    res.status(500).json({ ok: false, content: '', error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// 캐시 강제 초기화 엔드포인트 (개발용)
app.delete('/api/cache', (req, res) => {
  _cache = null;
  res.json({ ok: true, message: '캐시 초기화 완료' });
});

// 서버 상태 확인
const isKeySet = () => {
  const k = process.env.APT_API_KEY || '';
  return k && k !== '여기에_발급받은_일반인증키_붙여넣기';
};

app.get('/api/health', (req, res) => {
  res.json({
    ok:       true,
    apiKey:   isKeySet() ? '설정됨' : '미설정 (placeholder)',
    cached:   !!_cache,
    cacheAge: _cache ? Math.round((Date.now() - _cache.ts) / 1000) + 's' : null,
    cacheCount: _cache?.data?.length ?? 0,
  });
});

// 정적 파일 서빙 (public/)
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🏠 청약도우미 서버 시작: http://localhost:${PORT}`);
  console.log(`📡 청약홈 API 키: ${isKeySet() ? '✅ 설정됨' : '❌ 미설정 → .env 파일에 APT_API_KEY 입력 필요'}`);
  console.log(`⏱  캐시 TTL: ${CACHE_TTL_MS / 60000}분\n`);

  // 매일 오전 8시 (KST = UTC+9) → UTC 23시 에 캐시 자동 갱신
  if (isKeySet()) {
    cron.schedule('0 23 * * *', async () => {
      console.log('[스케줄러] 매일 오전 8시 자동 갱신 시작...');
      _cache = null;
      try {
        const data = await fetchFromAPI(process.env.APT_API_KEY);
        _cache = { data, ts: Date.now() };
        console.log(`[스케줄러] 갱신 완료: ${data.length}건`);
        await sendNotifications(data);
        await sendPushNotifications(data);
      } catch (err) {
        console.error('[스케줄러] 갱신 실패:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log('📅 자동 갱신 스케줄: 매일 오전 8시 (KST)\n');
  }
});
