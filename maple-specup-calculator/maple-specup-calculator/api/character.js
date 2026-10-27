// Vercel Serverless Function: GET /api/character?name=캐릭터명
// 1) /maplestory/v1/id                      → ocid
// 2) /maplestory/v1/character/item-equipment → 착용 장비 (date 생략 = 최신 데이터)
//
// API Key는 서버(이 파일)에서만 사용되며 프론트엔드로 전달되지 않습니다.

const API_KEY =
  process.env.NEXON_API_KEY ||
  'test_4e50c03028d6e59cc8234690b5d9cfeb26a6008489d604957dbb93d445407624efe8d04e6d233bd35cf2fabdeb93fb0d';

const NEXON_BASE = 'https://open.api.nexon.com/maplestory/v1';
const TIMEOUT_MS = 8000; // vercel.json maxDuration(10초)보다 짧게

// 허용할 Origin. 환경변수 ALLOWED_ORIGIN 으로 제한 가능 (예: https://my-calc.vercel.app)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

/**
 * 넥슨 오픈 API 에러 코드 → 클라이언트 응답
 * https://openapi.nexon.com/guide/request-api/ 의 에러 코드 표 기준
 */
const NEXON_ERRORS = {
  OPENAPI00001: { status: 502, message: '넥슨 API 서버 내부 오류입니다. 잠시 후 다시 시도해 주세요.' },
  OPENAPI00002: { status: 500, message: '서버의 API Key에 이 API 접근 권한이 없습니다.' },
  OPENAPI00003: { status: 404, message: '캐릭터를 찾을 수 없습니다.' }, // 유효하지 않은 식별자(ocid)
  OPENAPI00004: { status: 404, message: '캐릭터를 찾을 수 없습니다. 닉네임을 확인해 주세요.' }, // 파라미터 오류
  OPENAPI00005: { status: 500, message: '서버의 넥슨 API Key가 유효하지 않습니다.' },
  OPENAPI00006: { status: 500, message: '잘못된 API 경로입니다.' },
  OPENAPI00007: { status: 429, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
  OPENAPI00009: { status: 404, message: '아직 데이터가 준비되지 않았습니다. 최근 생성·접속한 캐릭터는 다음 날 다시 시도해 주세요.' },
  OPENAPI00010: { status: 503, message: '메이플스토리 게임 점검 중입니다.' },
  OPENAPI00011: { status: 503, message: '넥슨 오픈 API 점검 중입니다.' },
};

class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (ALLOWED_ORIGIN !== '*') res.setHeader('Vary', 'Origin');
}

/** 넥슨 API GET 호출. 실패 시 ApiError를 던짐 */
async function nexonGet(url) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-nxopen-api-key': API_KEY,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ApiError(504, '넥슨 API 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    throw new ApiError(502, '넥슨 API 서버에 연결할 수 없습니다.');
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // 점검 페이지 등 JSON이 아닌 응답
  }

  if (!response.ok) {
    const code = body?.error?.name ?? null;
    const known = code && NEXON_ERRORS[code];
    if (known) throw new ApiError(known.status, known.message, code);
    if (response.status === 429) throw new ApiError(429, NEXON_ERRORS.OPENAPI00007.message, code);
    if (response.status >= 500) throw new ApiError(503, '넥슨 API 서버가 응답하지 않습니다. 점검 중일 수 있습니다.', code);
    throw new ApiError(502, body?.error?.message || `넥슨 API 오류 (${response.status})`, code);
  }

  if (!body) throw new ApiError(502, '넥슨 API 응답을 해석할 수 없습니다.');
  return body;
}

/** 프론트(app.js)에서 쓰는 요약 형태 */
function mapItem(it) {
  return {
    id: it.item_equipment_slot,
    slot: it.item_equipment_slot,
    part: it.item_equipment_part,
    name: it.item_name,
    icon: it.item_icon,
    level: Number(it.item_base_option?.base_equipment_level) || 0,
    starforce: Number(it.starforce) || 0,
    amazing: it.starforce_scroll_flag === '사용', // 놀라운 장비 강화 주문서
  };
}

export default async function handler(req, res) {
  setCors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: { message: '허용되지 않은 메서드입니다.' } });
  }

  try {
    const name = String(req.query?.name ?? '').trim();
    if (!name) throw new ApiError(400, '캐릭터 닉네임을 입력해 주세요.');
    if (name.length > 12) throw new ApiError(400, '닉네임은 최대 12자입니다.');

    // ① 닉네임 → ocid
    const idData = await nexonGet(`${NEXON_BASE}/id?character_name=${encodeURIComponent(name)}`);
    const ocid = idData?.ocid;
    if (!ocid) throw new ApiError(404, '캐릭터를 찾을 수 없습니다. 닉네임을 확인해 주세요.');

    // ② ocid → 착용 장비 (date 생략 → 최신)
    const equip = await nexonGet(
      `${NEXON_BASE}/character/item-equipment?ocid=${encodeURIComponent(ocid)}`
    );
    const itemEquipment = Array.isArray(equip.item_equipment) ? equip.item_equipment : [];

    // 같은 캐릭터 연속 검색 시 넥슨 API 호출량 절약 (Vercel CDN 5분 캐시)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

    return res.status(200).json({
      ...equip,                         // 넥슨 원본 응답 (item_equipment 포함) 그대로
      item_equipment: itemEquipment,
      character: {                      // ↓ 프론트 app.js 호환용
        name,
        class: equip.character_class ?? null,
        gender: equip.character_gender ?? null,
        presetNo: equip.preset_no ?? null,
        date: equip.date ?? null,
      },
      items: itemEquipment.map(mapItem),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { message: err.message, code: err.code } });
    }
    console.error('[api/character] unexpected error:', err);
    return res.status(500).json({ error: { message: '알 수 없는 서버 오류가 발생했습니다.' } });
  }
}
