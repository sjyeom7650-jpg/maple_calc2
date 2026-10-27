import { STAR_STEPS, FINAL_DMG_GAIN, LEVEL_TIERS } from './data.js';
import { expectedRange } from './starforce.js';

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

/* ============================================================
 *  예산 최적화
 * ============================================================ */

/* ============================================================
 *  장비별 스펙업 방법(옵션) 만들기
 *   - 직작:        현재 ★c → ★t 직접 강화 (기댓값)
 *   - 구매:        ★L 매물 구매 (현재 장비 대신 착용)
 *   - 구매 + 직작: ★L 매물 구매 후 ★t까지 직접 강화
 * ============================================================ */

/** 렙제 구간별 '★s일 때 누적 최종뎀' (STAR_STEPS 첫 구간 시작=0). 데이터 없는 별은 undefined */
export function dmgLadder(tier) {
  const ladder = { [STAR_STEPS[0].from]: 0 };
  let acc = 0;
  for (const step of STAR_STEPS) {
    const g = FINAL_DMG_GAIN[tier]?.[step.key];
    if (!g || ladder[step.from] === undefined) break;
    acc += g;
    ladder[step.to] = Math.round(acc * 100) / 100;
  }
  return ladder;
}

/** 이 장비가 비교 가능한 목표 스타포스 목록 (현재보다 높은 것) */
export function targetStars(item) {
  const tier = resolveTier(item.level);
  if (tier === null) return [];
  const ladder = dmgLadder(tier);
  return Object.keys(ladder).map(Number).filter((t) => t > item.starforce).sort((a, b) => a - b);
}

/** 옵션을 만들 수 없는 이유 (없으면 null) */
export function unavailableReason(item) {
  if (item.amazing) return '놀장 장비';
  const tier = resolveTier(item.level);
  if (tier === null) return `${item.level || '?'}제 데이터 없음`;
  const ladder = dmgLadder(tier);
  if (ladder[item.starforce] === undefined) {
    return item.starforce < STAR_STEPS[0].from ? `${STAR_STEPS[0].from}성 미만` : '데이터 구간 초과';
  }
  return null;
}

/**
 * @param item  { level, starforce, amazing }
 * @param ctx   { spare, listings: { [star]: price }, settings }
 * @returns [{ kind, from, to, buyStar, buyPrice, enhanceCost, cost, gain, label }]
 */
export function buildItemOptions(item, ctx = {}) {
  if (unavailableReason(item)) return [];
  const tier = resolveTier(item.level);
  const ladder = dmgLadder(tier);
  const c = item.starforce;
  const base = ladder[c];
  const stars = targetStars(item);
  const spare = ctx.spare ?? 0;
  const listings = ctx.listings ?? {};
  const direct = (from, to) => expectedRange(item.level, from, to, spare, ctx.settings).total;
  const options = [];

  for (const t of stars) {
    const gain = Math.round((ladder[t] - base) * 100) / 100;
    // ① 직작
    const e = direct(c, t);
    options.push({ kind: 'enhance', from: c, to: t, buyStar: null, buyPrice: 0, enhanceCost: e, cost: e, gain,
      label: `★${c}→${t}` });

    // ② 구매 / ③ 구매 후 직작
    for (const L of stars) {
      if (L > t) break;
      const price = listings[L];
      if (!(price > 0)) continue;
      const e2 = L === t ? 0 : direct(L, t);
      options.push({
        kind: L === t ? 'buy' : 'buyEnhance', from: c, to: t, buyStar: L, buyPrice: price,
        enhanceCost: e2, cost: price + e2, gain,
        label: L === t ? `${L}성 매물` : `${L}성 매물 → ★${t}`,
      });
    }
  }
  return options;
}

/** 옵션 중 최종뎀 1%당 가격이 가장 싼 것 */
export function bestOption(options) {
  let best = null;
  for (const o of options) if (!best || o.cost / o.gain < best.cost / best.gain) best = o;
  return best;
}

/** 같은 목표 ★에 대해 가장 싼 방법만 남김 (예산 계산용: 한 장비에서 하나만 고르므로 충분) */
export function cheapestPerTarget(options) {
  const byTo = new Map();
  for (const o of options) if (!byTo.has(o.to) || o.cost < byTo.get(o.to).cost) byTo.set(o.to, o);
  return [...byTo.values()].sort((a, b) => a.to - b.to);
}

const UNIT = 100; // 최종뎀 0.01%p 단위로 정수화

/**
 * 장비별로 '아무것도 안 함 / 옵션 1 / 옵션 2 ...' 중 하나씩 고르는 배낭 문제.
 * 최종뎀 합계(정수 단위)별 최소 비용을 DP로 구한 뒤,
 * "더 싸면서 최종뎀이 더 높은 조합"이 없는 효율적 조합(파레토 경계)만 추려 반환.
 *
 * @param groups [{ item, options }]
 * @returns { frontier: [{ gain, cost, picks:[{ item, option }] }], totalCombos }
 */
export function optimize(groups) {
  const active = groups.filter((g) => g.options.length);
  const totalCombos = active.reduce((acc, g) => acc * (g.options.length + 1), 1);
  if (!active.length) return { frontier: [], totalCombos: 1 };

  const maxG = active.reduce((s, g) => s + Math.max(...g.options.map((o) => Math.round(o.gain * UNIT))), 0);
  let dp = new Float64Array(maxG + 1).fill(Infinity);
  dp[0] = 0;
  const choice = []; // choice[i][g] = 선택한 옵션 index + 1 (0 = 강화 안 함)

  for (const group of active) {
    const next = Float64Array.from(dp);
    const pick = new Int8Array(maxG + 1);
    group.options.forEach((opt, k) => {
      const dg = Math.round(opt.gain * UNIT);
      for (let g = maxG; g >= dg; g--) {
        const cand = dp[g - dg] + opt.cost;
        if (cand < next[g]) { next[g] = cand; pick[g] = k + 1; }
      }
    });
    choice.push(pick);
    dp = next;
  }

  // 파레토 경계: 최종뎀이 높은 쪽부터 보며, 그보다 비싼(또는 같은) 조합은 버림
  const points = [];
  let cheapestAbove = Infinity;
  for (let g = maxG; g > 0; g--) {
    if (dp[g] < cheapestAbove) {
      points.push(g);
      cheapestAbove = dp[g];
    }
  }
  points.reverse();

  const frontier = points.map((g) => {
    const picks = [];
    let rem = g;
    for (let i = active.length - 1; i >= 0; i--) {
      const k = choice[i][rem];
      if (k) {
        const option = active[i].options[k - 1];
        picks.push({ item: active[i].item, option });
        rem -= Math.round(option.gain * UNIT);
      }
    }
    picks.sort((a, b) => a.option.cost / a.option.gain - b.option.cost / b.option.gain);
    return { gain: g / UNIT, cost: dp[g], picks };
  });

  return { frontier, totalCombos };
}
