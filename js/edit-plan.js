// Module: Plan editor (stage adjustments and start flow).
import { fmtMMSS, parseTimeToSeconds } from './utils.js';
import { startTraining, showScreen } from './session.js';
import { state } from './state.js';

let originalSession = null;
let working = null; // Mutable copy.
let selected = new Set();
const HR_MIN = 0, HR_MAX = 300;

function pct25(n) { return Math.floor(n * 0.25); }

function stageCaps(i) {
  const o = originalSession?.stages?.[i];
  const w = working?.stages?.[i];
  if (!o || !w) return null;
  const timeDelta = pct25(o.durationSec);
  const timeMin = Math.max(0, o.durationSec - timeDelta);
  const timeMax = o.durationSec + timeDelta;
  const lowerDelta = pct25(o.lower);
  const upperDelta = pct25(o.upper);
  const lowerMin = Math.max(HR_MIN, o.lower - lowerDelta);
  const lowerMax = Math.min(HR_MAX, o.lower + lowerDelta);
  const upperMin = Math.max(HR_MIN, o.upper - upperDelta);
  const upperMax = Math.min(HR_MAX, o.upper + upperDelta);
  return { o, w, timeMin, timeMax, lowerMin, lowerMax, upperMin, upperMax };
}

function deepCopySession(session) {
  return {
    id: session.id,
    idx: session.idx,
    date: session.date,
    athlete: session.athlete,
    totalDurationSec: session.totalDurationSec,
    stages: session.stages.map(s => ({ index: s.index, durationSec: s.durationSec, lower: s.lower, upper: s.upper }))
  };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function render() {
  const body = document.getElementById('editPlanBody');
  if (!body || !working) return;
  body.innerHTML = '';
  working.stages.forEach((stg, i) => {
    const tr = document.createElement('tr');
    const isSel = selected.has(i);
    tr.className = isSel ? 'bg-white/5' : '';
    const caps = stageCaps(i);
    const canLowerMinus = caps ? (stg.lower - 5) >= caps.lowerMin : true;
    const canLowerPlus = caps ? (stg.lower + 5) <= caps.lowerMax : true;
    const canUpperMinus = caps ? (stg.upper - 5) >= caps.upperMin : true;
    const canUpperPlus = caps ? (stg.upper + 5) <= caps.upperMax : true;
    tr.innerHTML = `
      <td class="py-1 pr-1 text-center"><input type="checkbox" data-act="selRow" data-i="${i}" ${isSel ? 'checked' : ''} class="accent-emerald-600"></td>
      <td class="py-1 pr-1 text-slate-300 text-center">E${stg.index}</td>
      <td class="py-1 pr-1 text-center"><div class="min-w-[4rem] text-center">${fmtMMSS(stg.durationSec)}</div></td>
      <td class="py-1 pr-1">
        <div class="flex items-center justify-center gap-1">
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-700 disabled:opacity-30" ${canLowerMinus ? '' : 'disabled'} data-act="addLower" data-delta="-5" data-i="${i}">−5</button>
          <input type="number" class="w-14 rounded-lg bg-slate-900/60 border border-white/10 p-1" value="${stg.lower}" data-act="inputLower" data-i="${i}"/>
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-700 disabled:opacity-30" ${canLowerPlus ? '' : 'disabled'} data-act="addLower" data-delta="5" data-i="${i}">+5</button>
        </div>
      </td>
      <td class="py-1 pr-1">
        <div class="flex items-center justify-center gap-1">
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-700 disabled:opacity-30" ${canUpperMinus ? '' : 'disabled'} data-act="addUpper" data-delta="-5" data-i="${i}">−5</button>
          <input type="number" class="w-14 rounded-lg bg-slate-900/60 border border-white/10 p-1" value="${stg.upper}" data-act="inputUpper" data-i="${i}"/>
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-700 disabled:opacity-30" ${canUpperPlus ? '' : 'disabled'} data-act="addUpper" data-delta="5" data-i="${i}">+5</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
  // Header checkbox state.
  const selAll = document.getElementById('editSelAll');
  if (selAll) selAll.checked = (selected.size === (working?.stages?.length || 0) && selected.size > 0);
  updateAdjTimeButtons();
}

function recalcTotal() {
  if (!working) return;
  working.totalDurationSec = working.stages.reduce((a, s) => a + clamp(Math.round(s.durationSec), 0, 86400), 0);
}

function setError(msg) {
  const el = document.getElementById('editPlanError');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else { el.textContent = ''; el.classList.add('hidden'); }
}

function validate() {
  if (!working) return false;
  for (const s of working.stages) {
    if (!(s.durationSec >= 0)) { setError('Duração inválida em um dos estágios.'); return false; }
    if (!(s.upper > s.lower)) { setError('Limites inválidos: superior deve ser maior que inferior.'); return false; }
  }
  setError('');
  return true;
}

function onClick(e) {
  const t = e.target.closest('button');
  if (!working) return;
  // Per-row selection checkbox is an input, not a button
  if (!t) return;
  const act = t.dataset.act;
  const i = Number(t.dataset.i);
  if (act === 'selRow') {
    const idx = Number(t.dataset.i);
    if (t.checked) selected.add(idx); else selected.delete(idx);
    render(); return;
  }
  // Row time controls removed; time adjustments are global via top bar selection.
  if (act === 'addLower') {
    const d = Number(t.dataset.delta) || 0;
    const caps = stageCaps(i);
    const minV = caps ? caps.lowerMin : HR_MIN;
    const maxV = caps ? caps.lowerMax : HR_MAX;
    working.stages[i].lower = clamp(Math.round(working.stages[i].lower + d), minV, maxV);
    render();
  }
  if (act === 'addUpper') {
    const d = Number(t.dataset.delta) || 0;
    const caps = stageCaps(i);
    const minV = caps ? caps.upperMin : HR_MIN;
    const maxV = caps ? caps.upperMax : HR_MAX;
    working.stages[i].upper = clamp(Math.round(working.stages[i].upper + d), minV, maxV);
    render();
  }
  // Per-row reset removed.
  if (act === 'adjTime') {
    const d = Number(t.dataset.delta) || 0;
    if (selected.size === 0) return;
    [...selected].forEach(idx => {
      const caps = stageCaps(idx);
      const minT = caps ? caps.timeMin : 0;
      const maxT = caps ? caps.timeMax : 86400;
      const cur = working.stages[idx].durationSec;
      working.stages[idx].durationSec = clamp(Math.round(cur + d), minT, maxT);
    });
    recalcTotal(); render();
  }
  // Global controls are time-only.
}

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  const i = Number(el.dataset.i);
  const act = el.dataset.act;
  if (!working || Number.isNaN(i)) return;
  const val = Math.round(Number(el.value));
  if (act === 'selRow') {
    if (el.checked) selected.add(i); else selected.delete(i);
    render();
    return;
  }
  if (act === 'inputLower') {
    const caps = stageCaps(i);
    const minV = caps ? caps.lowerMin : HR_MIN;
    const maxV = caps ? caps.lowerMax : HR_MAX;
    working.stages[i].lower = clamp(val, minV, maxV);
  }
  if (act === 'inputUpper') {
    const caps = stageCaps(i);
    const minV = caps ? caps.upperMin : HR_MIN;
    const maxV = caps ? caps.upperMax : HR_MAX;
    working.stages[i].upper = clamp(val, minV, maxV);
  }
  validate();
}

function updateAdjTimeButtons() {
  const btns = Array.from(document.querySelectorAll('button[data-act="adjTime"]'));
  if (!btns.length) return;
  const sel = [...selected];
  for (const b of btns) {
    const d = Number(b.dataset.delta) || 0;
    let can = true;
    if (!sel.length) can = false;
    for (const idx of sel) {
      const caps = stageCaps(idx);
      if (!caps) { can = false; break; }
      const cur = working.stages[idx].durationSec;
      const next = cur + d;
      if (!(next >= caps.timeMin && next <= caps.timeMax)) { can = false; break; }
    }
    b.disabled = !can;
    if (b.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    if (b.disabled) b.title = 'Alguns estágios selecionados atingiram o limite de 25%'; else b.removeAttribute('title');
  }
}

export function loadPlanForEdit(session, origin = null) {
  originalSession = deepCopySession(session);
  working = deepCopySession(session);
  state.editOrigin = origin || state.editOrigin || 'plan';
  selected = new Set();
  document.getElementById('editPlanScreen')?.classList.remove('hidden');
  document.getElementById('planScreen')?.classList.add('hidden');
  render();
}

export function startWithEditedPlan() {
  if (!validate()) return;
  // Ensure indices are sequential.
  working.stages.forEach((s, idx) => { s.index = idx + 1; });
  recalcTotal();
  // Always show Connect next (even if already connected), then proceed via Next.
  const sessionCopy = deepCopySession(working);
  // Propagate stable plan id for done-session linking.
  if (sessionCopy.id && !sessionCopy.planId) sessionCopy.planId = sessionCopy.id;
  if (Number.isFinite(sessionCopy.idx) && !Number.isFinite(sessionCopy.planIdx)) sessionCopy.planIdx = sessionCopy.idx;
  state.pendingIntent = { type: 'startEdited', session: sessionCopy };
  state.startReturnScreen = 'editPlan';
  showScreen('connect');
  try {
    const nextBtn = document.getElementById('goToPlanButton');
    if (nextBtn) nextBtn.disabled = !(state.device && state.device.gatt?.connected);
  } catch { }
}

export function backToPlan() {
  document.getElementById('editPlanScreen')?.classList.add('hidden');
  const origin = state.editOrigin || 'plan';
  if (origin === 'home') {
    document.getElementById('planScreen')?.classList.add('hidden');
    document.getElementById('connectScreen')?.classList.add('hidden');
    document.getElementById('plotScreen')?.classList.add('hidden');
    document.getElementById('completeScreen')?.classList.add('hidden');
    document.getElementById('homeScreen')?.classList.remove('hidden');
  } else {
    document.getElementById('homeScreen')?.classList.add('hidden');
    document.getElementById('planScreen')?.classList.remove('hidden');
  }
}

// Events.
document.addEventListener('click', (e) => {
  if (document.getElementById('editPlanScreen')?.classList.contains('hidden')) return;
  onClick(e);
});
document.addEventListener('input', (e) => {
  if (document.getElementById('editPlanScreen')?.classList.contains('hidden')) return;
  onInput(e);
  updateAdjTimeButtons();
});

// Select-all handler.
document.getElementById('editSelAll')?.addEventListener('change', (e) => {
  if (!working) return;
  if (e.target.checked) selected = new Set(working.stages.map((_, idx) => idx));
  else selected.clear();
  render();
});

document.getElementById('editStartBtn')?.addEventListener('click', startWithEditedPlan);
document.getElementById('editBackBtn')?.addEventListener('click', backToPlan);
