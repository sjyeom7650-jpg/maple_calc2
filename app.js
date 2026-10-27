import {
  parseMeso, formatMeso, optimize, buildItemOptions, bestOption, cheapestPerTarget,
  targetStars, unavailableReason,
} from './calc.js';
import { DEFAULT_SETTINGS } from './starforce.js';
import { initCalculator, renderCalculator, loadItem } from './calc-ui.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#search-form'),
  input: $('#nickname'),
  btn: $('#search-btn'),
  status: $('#status'),
  character: $('#character'),
  result: $('#result'),
  table: $('#rank-table'),
  hideInvalid: $('#hide-invalid'),
  hiddenCount: $('#hidden-count'),
  presetTabs: [...document.querySelectorAll('.preset-tabs button')],
  budget: $('#budget'),
  budgetHint: $('#budget-hint'),
  plan: $('#plan'),
  comboBody: $('#combo-body'),
  comboCaption: $('#combo-caption'),
  comboMore: $('#combo-more'),
};

const state = {
  characterName: '',
  items: [],              // 현재 보고 있는 프리셋의 장비 목록
  presets: {},            // { 1: [...], 2: [...], 3: [...] }
  appliedPreset: null,    // 게임에서 실제 적용 중인 프리셋 번호
  preset: null,           // 화면에서 선택한 프리셋 번호
  spares: {},             // 스페어 가격 { [itemKey]: rawString }
  listings: {},           // 매물 가격 { [itemKey]: { [star]: rawString } }
  expanded: new Set(),    // 가격 입력 영역을 펼친 장비
  settings: { ...DEFAULT_SETTINGS }, // 할인·이벤트
  groups: new Map(),      // itemKey → <tbody>
  results: new Map(),     // itemKey → { options, best, reason }
  budgetRaw: '',
  comboExpanded: false,
  controller: null,       // 진행 중인 검색 취소용
};

/* ---------------- 저장소 (입력한 가격 유지) ---------------- */
const STORAGE_KEY = 'msf-calc:v3';
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSaved(), ...patch })); } catch { /* 무시 */ }
}
function savePrices() {
  const saved = loadSaved();
  const spares = saved.spares ?? {};
  const listings = saved.listings ?? {};
  spares[state.characterName] = state.spares;
  listings[state.characterName] = state.listings;
  save({ spares, listings });
}

/** 같은 슬롯이라도 프리셋마다 다른 장비일 수 있으므로 슬롯+이름+스타포스로 구분 */
function itemKey(item) {
  return `${item.slot}|${item.name}|${item.starforce}`;
}

/** 장비별 계산 입력값 (스페어·매물 가격 + 공통 할인·이벤트) */
function ctxFor(item) {
  const key = itemKey(item);
  const listings = {};
  for (const [star, raw] of Object.entries(state.listings[key] ?? {})) {
    const v = parseMeso(raw);
    if (v > 0) listings[star] = v;
  }
  return { spare: parseMeso(state.spares[key]) ?? 0, listings, settings: state.settings };
}

/* ---------------- 검색 ---------------- */
async function search(name) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  setLoading(true);
  showStatus('loading');
  els.character.hidden = true;
  els.result.hidden = true;

  try {
    const res = await fetch(`/api/character?name=${encodeURIComponent(name)}`, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `요청 실패 (${res.status})`);

    state.characterName = data.character.name;
    const saved = loadSaved();
    state.spares = saved.spares?.[state.characterName] ?? {};
    state.listings = saved.listings?.[state.characterName] ?? {};
    state.expanded.clear();
    save({ lastName: state.characterName });

    // 프리셋 정리: 프리셋 데이터가 없으면 '현재 장비'를 적용 중인 프리셋 자리에 둠
    state.appliedPreset = Number(data.character.presetNo) || 1;
    state.presets = { 1: [], 2: [], 3: [], ...(data.presets ?? {}) };
    if (!state.presets[state.appliedPreset]?.length && data.items?.length) {
      state.presets[state.appliedPreset] = data.items;
    }
    if (![1, 2, 3].some((n) => state.presets[n].length)) {
      showStatus('error', '착용 중인 장비가 없습니다.');
      return;
    }

    renderCharacter(data.character);
    selectPreset(state.presets[state.appliedPreset].length
      ? state.appliedPreset
      : [1, 2, 3].find((n) => state.presets[n].length));
    showStatus(null);
    els.character.hidden = false;
    els.result.hidden = false;
  } catch (err) {
    if (err.name === 'AbortError') return;
    showStatus('error', err.message || '데이터를 불러오지 못했습니다.');
  } finally {
    if (state.controller === controller) setLoading(false);
  }
}

function setLoading(on) {
  els.btn.disabled = on;
  els.btn.classList.toggle('is-loading', on);
  els.btn.setAttribute('aria-busy', String(on));
}

function showStatus(kind, message = '') {
  const s = els.status;
  if (!kind) { s.hidden = true; s.innerHTML = ''; return; }
  s.hidden = false;
  s.classList.toggle('is-error', kind === 'error');
  if (kind === 'loading') {
    s.innerHTML = `<div class="loader" aria-hidden="true">${'<span></span>'.repeat(5)}</div>
                   <span role="status">장비 정보를 불러오는 중…</span>`;
  } else {
    s.textContent = message;
  }
}

/* ---------------- 렌더링 ---------------- */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCharacter(c) {
  const date = c.date ? new Date(c.date).toLocaleDateString('ko-KR') : '';
  els.character.innerHTML = `
    <span class="name">${esc(c.name)}</span>
    <span class="meta">${esc(c.class ?? '')}${c.presetNo ? ` · 프리셋 ${esc(c.presetNo)}` : ''}${date ? ` · ${esc(date)} 기준` : ''}</span>
    <span class="summary" id="summary"></span>`;
}

const KIND_CLASS = { enhance: 'k-enhance', buy: 'k-buy', buyEnhance: 'k-mix' };

function priceField(label, field, value, placeholder) {
  return `
    <label class="pf">
      <span class="pf-label">${label}</span>
      <input class="price-input" type="text" inputmode="text" enterkeyhint="done"
             data-field="${field}" value="${esc(value ?? '')}" placeholder="${placeholder}" autocomplete="off" />
      <span class="price-hint"></span>
    </label>`;
}

/**
 * 장비마다 <tbody>(요약 행 + 펼침 행)를 한 번만 만들고,
 * 이후엔 값만 갱신 + 순서만 재배치 (입력 포커스 유지 목적)
 */
function buildRows() {
  els.table.querySelectorAll('tbody').forEach((tb) => tb.remove());
  state.groups.clear();

  for (const item of state.items) {
    const key = itemKey(item);
    const reason = unavailableReason(item);
    const stars = reason ? [] : targetStars(item);
    const tb = document.createElement('tbody');
    tb.className = 'item-group';
    tb.dataset.key = key;
    tb.innerHTML = `
      <tr class="item-row">
        <td class="c-rank"><span class="rank-badge">-</span></td>
        <td class="c-item">
          <div class="item-cell">
            <span class="item-icon">${item.icon ? `<img src="${esc(item.icon)}" alt="" loading="lazy" />` : ''}</span>
            <span class="item-text">
              <div class="item-name">${esc(item.name)}</div>
              <div class="item-slot">${esc(item.slot)} · <span class="star">★${item.starforce}</span>
                <button type="button" class="to-calc" title="기댓값 계산기로 보기">계산기</button></div>
            </span>
          </div>
        </td>
        <td class="c-lv num">${item.level ? `${item.level}제` : '-'}</td>
        <td class="c-best" data-label="방법"></td>
        <td class="c-gain num"></td>
        <td class="c-cost num" data-label="비용"></td>
        <td class="c-eff" data-label="최종뎀 1%당"></td>
      </tr>
      ${stars.length ? `
      <tr class="detail-row">
        <td colspan="7">
          <div class="detail">
            <div class="detail-inputs">
              ${priceField('스페어(노작) 가격', 'spare', state.spares[key], '0')}
              ${stars.map((t) => priceField(`★${t} 매물 가격`, `L${t}`, state.listings[key]?.[t], '없음')).join('')}
            </div>
            <div class="detail-options"></div>
          </div>
        </td>
      </tr>` : ''}`;

    tb.querySelector('.to-calc').addEventListener('click', () => {
      loadItem(item, state.spares[key]);
      switchTab('calc');
    });

    if (stars.length) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'expand-btn';
      tb.querySelector('.item-text').appendChild(toggle);
      toggle.addEventListener('click', () => {
        if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
        syncExpanded(tb, key);
      });
      tb.querySelectorAll('.price-input').forEach((input) => {
        input.addEventListener('input', () => {
          const f = input.dataset.field;
          if (f === 'spare') state.spares[key] = input.value;
          else (state.listings[key] ??= {})[f.slice(1)] = input.value;
          savePrices();
          update();
        });
      });
      syncExpanded(tb, key);
    }

    els.table.appendChild(tb);
    state.groups.set(key, tb);
  }
}

function syncExpanded(tb, key) {
  const open = state.expanded.has(key);
  tb.classList.toggle('is-open', open);
  const btn = tb.querySelector('.expand-btn');
  if (btn) {
    btn.textContent = open ? '접기 ▴' : '가격 입력 ▾';
    btn.setAttribute('aria-expanded', String(open));
  }
}

function renderDetail(tb, result) {
  // 입력 힌트
  tb.querySelectorAll('.price-input').forEach((input) => {
    const raw = input.value;
    const parsed = parseMeso(raw);
    const bad = raw.trim() !== '' && parsed === null;
    input.classList.toggle('is-bad', bad);
    input.parentElement.querySelector('.price-hint').textContent =
      bad ? '숫자 또는 억/만' : parsed ? `${formatMeso(parsed)}` : '';
  });

  // 이 장비의 모든 경우의 수
  const box = tb.querySelector('.detail-options');
  if (!box) return;
  const sorted = [...result.options].sort((a, b) => a.cost / a.gain - b.cost / b.gain);
  box.innerHTML = `
    <table class="opt-table">
      <thead><tr><th>방법</th><th>최종뎀</th><th>비용</th><th>1%당</th></tr></thead>
      <tbody>
        ${sorted.map((o) => `
          <tr class="${o === result.best ? 'is-best' : ''}">
            <td><span class="kind ${KIND_CLASS[o.kind]}">${o.kind === 'enhance' ? '직작' : o.kind === 'buy' ? '구매' : '구매+직작'}</span>${esc(o.label)}</td>
            <td class="num good">+${o.gain.toFixed(2)}%</td>
            <td class="num">${formatMeso(o.cost)}${o.kind === 'buyEnhance' ? `<small>매물 ${formatMeso(o.buyPrice)} + 직작 ${formatMeso(o.enhanceCost)}</small>` : ''}</td>
            <td class="num strong">${formatMeso(o.cost / o.gain)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function update() {
  const evaluated = state.items.map((item) => {
    const reason = unavailableReason(item);
    const options = reason ? [] : buildItemOptions(item, ctxFor(item));
    const best = bestOption(options);
    const result = { options, best, reason };
    state.results.set(itemKey(item), result);
    return { item, result };
  });

  // 1%당 가격 오름차순 (낮을수록 가성비 좋음). 계산 불가 장비는 뒤로.
  const per = (r) => (r.best ? r.best.cost / r.best.gain : Infinity);
  evaluated.sort((a, b) => per(a.result) - per(b.result));

  let rank = 0;
  let hidden = 0;
  for (const { item, result } of evaluated) {
    const tb = state.groups.get(itemKey(item));
    const row = tb.querySelector('.item-row');
    const valid = !!result.best;
    const hide = els.hideInvalid.checked && !valid;
    if (hide) hidden++;

    tb.classList.toggle('is-invalid', !valid);
    tb.classList.toggle('is-hidden', hide);
    if (valid) tb.dataset.rank = String(++rank); else delete tb.dataset.rank;
    row.querySelector('.rank-badge').textContent = valid ? rank : '-';

    const b = result.best;
    row.querySelector('.c-best').innerHTML = b
      ? `<span class="kind ${KIND_CLASS[b.kind]}">${b.kind === 'enhance' ? '직작' : b.kind === 'buy' ? '구매' : '구매+직작'}</span>${esc(b.label)}`
      : '-';
    row.querySelector('.c-gain').innerHTML = b ? `+${b.gain.toFixed(2)}%` : '-';
    row.querySelector('.c-cost').textContent = b ? formatMeso(b.cost) : '-';
    row.querySelector('.c-eff').innerHTML = b
      ? `<span class="eff">${formatMeso(b.cost / b.gain)}<span class="eff-unit">메소 / 1%</span></span>`
      : `<span class="reason">${esc(result.reason)}</span>`;

    renderDetail(tb, result);
  }

  reorderGroups(evaluated.map((e) => state.groups.get(itemKey(e.item))));

  els.hiddenCount.textContent = hidden ? `(${hidden}개)` : '';
  const summary = document.getElementById('summary');
  if (summary) {
    const top = evaluated[0]?.result.best ? evaluated[0] : null;
    summary.innerHTML = top
      ? `가성비 1위 <b>${esc(top.item.name)}</b> ${esc(top.result.best.label)} · ${formatMeso(top.result.best.cost / top.result.best.gain)} / 1%`
      : '계산 가능한 장비가 없습니다';
  }

  renderBudget();
}

/**
 * 정렬 결과대로 DOM 재배치.
 * 요소를 옮기면 입력 중이던 input의 포커스가 풀리므로, 포커스·커서 위치를 저장했다가 복원.
 */
function reorderGroups(ordered) {
  const current = [...els.table.querySelectorAll('tbody')];
  if (current.length === ordered.length && current.every((tb, i) => tb === ordered[i])) return;

  const active = document.activeElement;
  const restore = active?.classList?.contains('price-input')
    ? { el: active, start: active.selectionStart, end: active.selectionEnd }
    : null;

  const frag = document.createDocumentFragment();
  ordered.forEach((tb) => frag.appendChild(tb));
  els.table.appendChild(frag);

  if (restore && document.activeElement !== restore.el) {
    restore.el.focus({ preventScroll: true });
    try { restore.el.setSelectionRange(restore.start, restore.end); } catch { /* 무시 */ }
  }
}

/* ---------------- 프리셋 ---------------- */
function selectPreset(no) {
  state.preset = no;
  state.items = state.presets[no] ?? [];
  state.comboExpanded = false;
  renderPresetTabs();
  buildRows();
  update();
}

function renderPresetTabs() {
  for (const btn of els.presetTabs) {
    const no = Number(btn.dataset.preset);
    const empty = !state.presets[no]?.length;
    btn.disabled = empty;
    btn.setAttribute('aria-selected', String(no === state.preset));
    btn.innerHTML = `${no}번${no === state.appliedPreset ? '<span class="applied">적용중</span>' : ''}`;
    btn.title = empty ? '비어 있는 프리셋' : '';
  }
}

/* ---------------- 예산 최적화 ---------------- */
const COMBO_PREVIEW = 10;
const COMBO_MAX = 300;

function renderBudget() {
  // 한 장비에서 하나만 고르므로, 같은 목표 ★이면 가장 싼 방법만 후보로 둠
  const groups = state.items.map((item) => ({
    item,
    options: cheapestPerTarget(state.results.get(itemKey(item))?.options ?? []),
  }));
  const { frontier, totalCombos } = optimize(groups);

  const raw = state.budgetRaw.trim();
  const budget = parseMeso(raw);
  els.budget.classList.toggle('is-bad', raw !== '' && budget === null);
  els.budgetHint.textContent = budget ? `${formatMeso(budget)} 메소` : raw ? '숫자 또는 억/만 단위' : '';

  if (!frontier.length) {
    els.plan.innerHTML = `<div class="plan-empty">이 프리셋에는 계산할 수 있는 장비가 없습니다.</div>`;
    els.comboCaption.textContent = '';
    els.comboBody.innerHTML = '';
    els.comboMore.hidden = true;
    return;
  }

  const affordable = budget ? frontier.filter((p) => p.cost <= budget) : frontier;
  const best = budget ? affordable.at(-1) ?? null : null;
  const pool = affordable.length ? affordable : frontier;
  const cheapest = pool.reduce((a, b) => (b.cost / b.gain < a.cost / a.gain ? b : a));

  const kindTag = (o) =>
    `<span class="kind ${KIND_CLASS[o.kind]}">${o.kind === 'enhance' ? '직작' : o.kind === 'buy' ? '구매' : '구매+직작'}</span>`;

  // ① 최적 플랜
  if (!budget) {
    els.plan.innerHTML = `<div class="plan-empty">예산을 입력하면 매물 구매와 직작을 섞어서 최종뎀을 가장 많이 올리는 조합을 골라 드립니다.</div>`;
  } else if (!best) {
    els.plan.innerHTML = `<div class="plan-empty">예산 안에서 가능한 스펙업이 없습니다. 가장 싼 방법은 <b>${formatMeso(frontier[0].cost)}</b> 메소입니다.</div>`;
  } else {
    const buySum = best.picks.reduce((s, p) => s + p.option.buyPrice, 0);
    const enhSum = best.picks.reduce((s, p) => s + p.option.enhanceCost, 0);
    els.plan.innerHTML = `
      <div class="plan-stats">
        <div class="stat"><span class="stat-label">최종뎀 상승</span><span class="stat-value good">+${best.gain.toFixed(2)}%</span></div>
        <div class="stat"><span class="stat-label">총 비용</span><span class="stat-value">${formatMeso(best.cost)}</span></div>
        <div class="stat"><span class="stat-label">남는 예산</span><span class="stat-value">${formatMeso(budget - best.cost)}</span></div>
        <div class="stat"><span class="stat-label">1%당 평균</span><span class="stat-value gold">${formatMeso(best.cost / best.gain)}</span></div>
      </div>
      <p class="plan-split">매물 구매 <b>${formatMeso(buySum)}</b> · 직작 기댓값 <b>${formatMeso(enhSum)}</b></p>
      <ol class="plan-list">
        ${best.picks.map((p, i) => `
          <li>
            <span class="ord">${i + 1}</span>
            <span class="nm">${esc(p.item.name)}<small>${kindTag(p.option)}${esc(p.option.label)}</small></span>
            <span class="g">+${p.option.gain.toFixed(2)}%</span>
            <span class="c">${formatMeso(p.option.cost)}</span>
          </li>`).join('')}
      </ol>`;
  }

  // ② 경우의 수 표 (최종뎀 높은 순)
  const rows = [...pool].reverse();
  const nextOver = budget ? frontier.find((p) => p.cost > budget) : null;
  const limit = state.comboExpanded ? COMBO_MAX : COMBO_PREVIEW;
  const shown = rows.slice(0, limit);

  const rowHtml = (p, over = false) => {
    const tags = [];
    if (p === best) tags.push('<span class="tag best">예산 최적</span>');
    if (p === cheapest) tags.push('<span class="tag cheap">1%당 최저</span>');
    if (over) tags.push(`<span class="tag cheap">+${formatMeso(p.cost - budget)} 더 있으면</span>`);
    return `
      <tr class="${p === best ? 'is-best' : ''}${over ? ' is-over' : ''}">
        <td class="k-gain" data-label="최종뎀 합계">+${p.gain.toFixed(2)}%${tags.join('')}</td>
        <td class="k-cost num" data-label="총 비용">${formatMeso(p.cost)}</td>
        <td class="k-eff num" data-label="1%당">${formatMeso(p.cost / p.gain)}</td>
        <td class="k-picks">${p.picks
          .map((x) => `<span class="pick">${esc(x.item.slot)} ${
            x.option.kind === 'enhance' ? `직작 ★${x.option.from}→${x.option.to}`
            : x.option.kind === 'buy' ? `${x.option.to}성 구매`
            : `${x.option.buyStar}성 구매→${x.option.to}`}</span>`)
          .join('')}</td>
      </tr>`;
  };

  els.comboBody.innerHTML =
    (nextOver ? rowHtml(nextOver, true) : '') + shown.map((p) => rowHtml(p)).join('');

  els.comboCaption.textContent =
    `장비별 방법을 조합한 ${totalCombos.toLocaleString('ko-KR')}가지 중, 같은 돈으로 최종뎀을 더 올릴 수 없는 효율적 조합 ${
      pool.length.toLocaleString('ko-KR')}가지${budget && affordable.length ? ' (예산 이내)' : ''}`;

  const hiddenCount = Math.min(rows.length, COMBO_MAX) - shown.length;
  els.comboMore.hidden = !(hiddenCount > 0 || state.comboExpanded);
  els.comboMore.textContent = state.comboExpanded ? '접기' : `${hiddenCount}개 더 보기`;
}

/* ---------------- 탭 ---------------- */
function switchTab(name) {
  const calc = name === 'calc';
  $('#tab-rank').setAttribute('aria-selected', String(!calc));
  $('#tab-calc').setAttribute('aria-selected', String(calc));
  $('#view-rank').hidden = calc;
  $('#view-calc').hidden = !calc;
  save({ tab: name });
  if (calc) {
    renderCalculator();
    $('#tab-calc').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
$('#tab-rank').addEventListener('click', () => switchTab('rank'));
$('#tab-calc').addEventListener('click', () => switchTab('calc'));

/* ---------------- 할인·이벤트 설정 ---------------- */
const SETTING_NAMES = {
  pcRoom: 'PC방', shining: '샤이닝', discount30: '30%할인', destroyDown: '파괴감소',
  sure51015: '5·10·15', plusOne: '1+1',
};
const MVP_NAMES = { silver: '실버', gold: '골드', diamond: '다이아' };

function syncSettingsUI() {
  const st = state.settings;
  document.querySelectorAll('input[name="mvp"]').forEach((r) => { r.checked = r.value === st.mvp; });
  document.querySelectorAll('input[data-setting]').forEach((c) => {
    c.checked = !!st[c.dataset.setting];
    // 샤이닝 스타포스에는 30% 할인·파괴 감소가 포함되어 있음
    if (c.dataset.setting === 'discount30' || c.dataset.setting === 'destroyDown') {
      c.disabled = st.shining;
      c.closest('label').classList.toggle('is-implied', st.shining);
    }
  });
  const on = Object.keys(SETTING_NAMES).filter((k) => st[k]).map((k) => SETTING_NAMES[k]);
  if (MVP_NAMES[st.mvp]) on.unshift(`MVP ${MVP_NAMES[st.mvp]}`);
  if (!st.starCatch) on.push('스타캐치 끔');
  $('#settings-summary').textContent = on.length ? on.join(' · ') : '할인·이벤트 없음';
}

function onSettingsChanged() {
  save({ settings: state.settings });
  syncSettingsUI();
  if (state.items.length) update();
  renderCalculator();
}

document.querySelectorAll('input[name="mvp"]').forEach((r) =>
  r.addEventListener('change', () => { state.settings.mvp = r.value; onSettingsChanged(); })
);
document.querySelectorAll('input[data-setting]').forEach((c) =>
  c.addEventListener('change', () => { state.settings[c.dataset.setting] = c.checked; onSettingsChanged(); })
);

/* ---------------- 이벤트 ---------------- */
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = els.input.value.trim();
  if (name) search(name);
});

els.presetTabs.forEach((btn) =>
  btn.addEventListener('click', () => {
    const no = Number(btn.dataset.preset);
    if (no !== state.preset && state.presets[no]?.length) selectPreset(no);
  })
);

els.budget.addEventListener('input', () => {
  state.budgetRaw = els.budget.value;
  state.comboExpanded = false;
  save({ budget: state.budgetRaw });
  if (state.items.length) renderBudget();
});

els.comboMore.addEventListener('click', () => {
  state.comboExpanded = !state.comboExpanded;
  renderBudget();
});

els.hideInvalid.addEventListener('change', () => {
  save({ hideInvalid: els.hideInvalid.checked });
  if (state.items.length) update();
});

/* ---------------- 초기화 ---------------- */
(function init() {
  const saved = loadSaved();
  if (typeof saved.hideInvalid === 'boolean') els.hideInvalid.checked = saved.hideInvalid;
  if (saved.lastName) els.input.value = saved.lastName;
  if (saved.budget) { state.budgetRaw = saved.budget; els.budget.value = saved.budget; }
  state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) };
  syncSettingsUI();
  initCalculator({
    getSettings: () => state.settings,
    saved: saved.calc,
    onChange: (calc) => save({ calc }),
  });
  if (saved.tab === 'calc') switchTab('calc');
})();
