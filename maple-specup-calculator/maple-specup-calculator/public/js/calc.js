import { STAR_STEPS, FINAL_DMG_GAIN, EXPECTED_COST, LEVEL_TIERS } from './data.js';

/**
 * 장비 레벨 → 데이터 테이블의 렙제 구간.
 * 정확히 일치하지 않으면 바로 아래 구간을 씁니다 (예: 155제 → 150제 데이터).
 * 가장 낮은 구간(140제) 미만이면 null.
 */
export function resolveTier(level) {
  let tier = null;
  for (const t of LEVEL_TIERS) if (level >= t) tier = t;
  return tier;
}

/** 현재 스타포스에서 다음 강화 구간 */
export function nextStep(starforce) {
  return STAR_STEPS.find((s) => s.from === starforce) ?? null;
}

/**
 * 장비 1개에 대한 가성비 계산.
 * @param item  { level, starforce, amazing }
 * @param mode  'price' (모드 A) | 'expected' (모드 B)
 * @param inputPrice 모드 A에서 유저가 입력한 메소 (숫자 또는 null)
 * @returns { tier, step, gain, cost, perPercent, reason }
 *          perPercent가 null이면 순위 제외, reason에 사유
 */
export function evaluate(item, mode, inputPrice) {
  const base = { tier: null, step: null, gain: null, cost: null, perPercent: null, reason: null };

  if (item.amazing) return { ...base, reason: '놀장 장비' };

  const tier = resolveTier(item.level);
  if (tier === null) return { ...base, reason: `${item.level || '?'}제 데이터 없음` };

  const step = nextStep(item.starforce);
  if (!step) {
    const reason = item.starforce < STAR_STEPS[0].from
      ? `${STAR_STEPS[0].from}성 미만`
      : '데이터 구간 초과';
    return { ...base, tier, reason };
  }

  const gain = FINAL_DMG_GAIN[tier]?.[step.key] ?? null;
  if (!gain) return { ...base, tier, step, reason: '상승량 데이터 없음' };

  const cost = mode === 'price' ? inputPrice : EXPECTED_COST[tier]?.[step.key] ?? null;
  if (cost === null || cost === undefined || !(cost > 0)) {
    return {
      ...base, tier, step, gain,
      reason: mode === 'price' ? '가격 미입력' : '기댓값 데이터 없음',
    };
  }

  return { tier, step, gain, cost, perPercent: cost / gain, reason: null };
}

/**
 * 메소 입력 파싱: "15억", "1.5억", "3억 5000만", "150,000,000", "2조" 모두 허용.
 * 해석할 수 없으면 null.
 */
export function parseMeso(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[,\s원메소]/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  const units = { 조: 1e12, 억: 1e8, 만: 1e4 };
  const re = /(\d+(?:\.\d+)?)(조|억|만)?/g;
  let total = 0;
  let consumed = '';
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) break;
    total += Number(m[1]) * (m[2] ? units[m[2]] : 1);
    consumed += m[0];
  }
  return consumed === s && total > 0 ? Math.round(total) : null;
}

/** 메소를 "12억 3,400만" 형태로 */
export function formatMeso(n) {
  if (n === null || n === undefined || !isFinite(n)) return '-';
  n = Math.round(n);
  if (n < 1e4) return n.toLocaleString('ko-KR');
  const jo = Math.floor(n / 1e12);
  const eok = Math.floor((n % 1e12) / 1e8);
  const man = Math.floor((n % 1e8) / 1e4);
  const parts = [];
  if (jo) parts.push(`${jo.toLocaleString('ko-KR')}조`);
  if (eok) parts.push(`${eok.toLocaleString('ko-KR')}억`);
  if (man) parts.push(`${man.toLocaleString('ko-KR')}만`);
  return parts.join(' ') || '0';
}
