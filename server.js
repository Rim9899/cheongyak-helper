require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SEC) || 86400) * 1000;

// ── 인메모리 캐시 ─────────────────────────────────────────
let _cache = null; // { data: [...], ts: Date.now() }

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
   청약홈 API 호출
═══════════════════════════════════════════════ */
async function fetchFromAPI(apiKey) {
  // 3페이지(300건) 병렬 수집 후 서버에서 날짜 필터링
  const pages = [1, 2, 3];
  const responses = await Promise.all(
    pages.map(page =>
      axios.get(`${APT_API_BASE}/getAPTLttotPblancDetail`, {
        params: { serviceKey: apiKey, page, perPage: 100 },
        timeout: 15000,
      }).then(r => r.data?.data || []).catch(() => [])
    )
  );

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
    .map(transformItem)
    .filter(Boolean)
    .sort((a, b) => (b.schedule.announcement || '').localeCompare(a.schedule.announcement || ''));

  console.log(`[API] 전체 ${allItems.length}건 수집 → 필터 후 ${result.length}건`);
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
      } catch (err) {
        console.error('[스케줄러] 갱신 실패:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log('📅 자동 갱신 스케줄: 매일 오전 8시 (KST)\n');
  }
});
