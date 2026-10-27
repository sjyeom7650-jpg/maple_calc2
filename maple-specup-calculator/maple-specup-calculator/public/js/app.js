import { evaluate, parseMeso, formatMeso } from './calc.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#search-form'),
  input: $('#nickname'),
  btn: $('#search-btn'),
  status: $('#status'),
  character: $('#character'),
  result: $('#result'),
  body: $('#rank-body'),
  costHead: $('#cost-head'),
  hideInvalid: $('#hide-invalid'),
  hiddenCount: $('#hidden-count'),
};

const state = {
  mode: 'price',          // 'price' (모드 A) | 'expected' (모드 B)
  characterName: '',
  items: [],              // 백엔드에서 받은 장비 목록
  prices: {},             // 모드 A 입력값 { [slot]: rawString }
  rows: new Map(),        // slot → <tr>
  controller: null,       // 진행 중인 검색 취소용
};

/* ---------------- 저장소 (입력한 가격 유지) ---------------- */
const STORAGE_KEY = 'msf-calc:v1';
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSaved(), ...patch })); } catch { /* 무시 */ }
}
function savePrices() {
  const saved = loadSaved();
  const all = saved.prices ?? {};
  all[state.characterName] = state.prices;
  save({ prices: all });
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
    state.items = data.items;
    state.prices = loadSaved().prices?.[state.characterName] ?? {};
    save({ lastName: state.characterName });

    if (!state.items.length) {
      showStatus('error', '착용 중인 장비가 없습니다.');
      return;
    }

    renderCharacter(data.character);
    buildRows();
    update();
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

/** 장비마다 <tr>을 한 번만 만들고, 이후엔 값만 갱신 + 순서만 재배치 (입력 포커스 유지 목적) */
function buildRows() {
  els.body.innerHTML = '';
  state.rows.clear();

  for (const item of state.items) {
    const tr = document.createElement('tr');
    tr.dataset.slot = item.slot;
    tr.innerHTML = `
      <td class="c-rank"><span class="rank-badge">-</span></td>
      <td class="c-item">
        <div class="item-cell">
          <span class="item-icon">${item.icon ? `<img src="${esc(item.icon)}" alt="" loading="lazy" />` : ''}</span>
          <span>
            <div class="item-name">${esc(item.name)}</div>
            <div class="item-slot">${esc(item.slot)}</div>
          </span>
        </div>
      </td>
      <td class="c-lv num">${item.level ? `${item.level}제` : '-'}</td>
      <td class="c-star" data-label="강화"></td>
      <td class="c-gain num"></td>
      <td class="c-cost" data-label="${state.mode === 'price' ? '+1 가격' : '직작 기댓값'}"></td>
      <td class="c-eff" data-label="최종뎀 1%당"></td>`;
    els.body.appendChild(tr);
    state.rows.set(item.slot, tr);
  }
}

function renderCostCell(tr, item, result) {
  const cell = tr.querySelector('.c-cost');
  const wantsInput = state.mode === 'price' && result.step && result.gain;

  if (wantsInput) {
    let input = cell.querySelector('.price-input');
    if (!input) {
      cell.innerHTML = `
        <input class="price-input" type="text" inputmode="text" enterkeyhint="done"
               placeholder="예: 15억"
               aria-label="${esc(item.name)} ${result.step.to}성 가격" />
        <span class="price-hint"></span>`;
      input = cell.querySelector('.price-input');
      input.value = state.prices[item.slot] ?? '';
      input.addEventListener('input', () => {
        state.prices[item.slot] = input.value;
        savePrices();
        update();
      });
    }
    const raw = state.prices[item.slot] ?? '';
    const parsed = parseMeso(raw);
    input.classList.toggle('is-bad', raw.trim() !== '' && parsed === null);
    cell.querySelector('.price-hint').textContent =
      parsed ? `${formatMeso(parsed)} 메소` : raw.trim() ? '숫자 또는 억/만 단위로 입력' : '';
  } else {
    const text = state.mode === 'expected' && result.cost ? `${formatMeso(result.cost)}` : '-';
    cell.innerHTML = `<span class="cost-fixed num">${text}</span>`;
  }
}

function update() {
  const evaluated = state.items.map((item) => {
    const price = state.mode === 'price' ? parseMeso(state.prices[item.slot]) : null;
    return { item, result: evaluate(item, state.mode, price) };
  });

  // 1%당 가격 오름차순 (낮을수록 가성비 좋음). 계산 불가 장비는 뒤로.
  evaluated.sort((a, b) => {
    const av = a.result.perPercent, bv = b.result.perPercent;
    if (av !== null && bv !== null) return av - bv;
    if (av !== null) return -1;
    if (bv !== null) return 1;
    // 둘 다 계산 불가: 강화 가능한 구간(가격만 비어있음)을 먼저
    return (b.result.gain ? 1 : 0) - (a.result.gain ? 1 : 0);
  });

  let rank = 0;
  let hidden = 0;
  for (const { item, result } of evaluated) {
    const tr = state.rows.get(item.slot);
    const valid = result.perPercent !== null;
    // 모드 A에서 가격만 비어있는 장비는 숨기지 않음 (입력칸이 필요하므로)
    const pendingInput = state.mode === 'price' && result.reason === '가격 미입력';
    const hide = els.hideInvalid.checked && !valid && !pendingInput;
    if (hide) hidden++;

    tr.classList.toggle('is-invalid', !valid);
    tr.classList.toggle('is-hidden', hide);
    if (valid) tr.dataset.rank = String(++rank); else delete tr.dataset.rank;

    tr.querySelector('.rank-badge').textContent = valid ? rank : '-';

    tr.querySelector('.c-star').innerHTML = result.step
      ? `<span class="star">★${result.step.from}<span class="arrow">→</span>${result.step.to}</span>`
      : `<span class="star">★${item.starforce}</span>`;

    tr.querySelector('.c-gain').innerHTML = result.gain ? `+${result.gain.toFixed(2)}%` : '-';

    renderCostCell(tr, item, result);

    tr.querySelector('.c-eff').innerHTML = valid
      ? `<span class="eff">${formatMeso(result.perPercent)}<span class="eff-unit">메소 / 1%</span></span>`
      : `<span class="reason">${esc(result.reason)}</span>`;
  }

  reorderRows(evaluated.map((e) => state.rows.get(e.item.slot)));

  els.hiddenCount.textContent = hidden ? `(${hidden}개)` : '';
  const summary = document.getElementById('summary');
  if (summary) {
    const best = evaluated[0]?.result.perPercent != null ? evaluated[0] : null;
    summary.innerHTML = best
      ? `가성비 1위 <b>${esc(best.item.name)}</b> · ${formatMeso(best.result.perPercent)} / 1%`
      : state.mode === 'price' ? '가격을 입력하면 순위가 매겨집니다' : '계산 가능한 장비가 없습니다';
  }
}

/**
 * 정렬 결과대로 DOM 재배치.
 * 행을 옮기면 입력 중이던 input의 포커스가 풀리므로, 포커스·커서 위치를 저장했다가 복원.
 */
function reorderRows(ordered) {
  const current = [...els.body.children];
  if (current.length === ordered.length && current.every((tr, i) => tr === ordered[i])) return;

  const active = document.activeElement;
  const restore = active?.classList?.contains('price-input')
    ? { el: active, start: active.selectionStart, end: active.selectionEnd }
    : null;

  const frag = document.createDocumentFragment();
  ordered.forEach((tr) => frag.appendChild(tr));
  els.body.appendChild(frag);

  if (restore && document.activeElement !== restore.el) {
    restore.el.focus({ preventScroll: true });
    try { restore.el.setSelectionRange(restore.start, restore.end); } catch { /* 무시 */ }
  }
}

/* ---------------- 이벤트 ---------------- */
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = els.input.value.trim();
  if (name) search(name);
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    state.mode = radio.value;
    els.costHead.textContent = state.mode === 'price' ? '+1 가격' : '직작 기댓값';
    document.querySelectorAll('.c-cost[data-label]').forEach((td) => {
      td.dataset.label = state.mode === 'price' ? '+1 가격' : '직작 기댓값';
    });
    save({ mode: state.mode });
    if (state.items.length) update();
  });
});

els.hideInvalid.addEventListener('change', () => {
  save({ hideInvalid: els.hideInvalid.checked });
  if (state.items.length) update();
});

/* ---------------- 초기화 ---------------- */
(function init() {
  const saved = loadSaved();
  if (saved.mode === 'expected') {
    $('#mode-expected').checked = true;
    state.mode = 'expected';
    els.costHead.textContent = '직작 기댓값';
  }
  if (typeof saved.hideInvalid === 'boolean') els.hideInvalid.checked = saved.hideInvalid;
  if (saved.lastName) els.input.value = saved.lastName;
})();
