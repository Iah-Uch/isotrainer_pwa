import { fmtMMSS, parseTimeToSeconds } from './utils.js';
import { startTraining } from './session.js';
import { state } from './state.js';

let originalSession = null;
let working = null; // mutable copy
let selected = new Set();

function deepCopySession(session){
  return {
    date: session.date,
    athlete: session.athlete,
    totalDurationSec: session.totalDurationSec,
    stages: session.stages.map(s=>({ index: s.index, durationSec: s.durationSec, lower: s.lower, upper: s.upper }))
  };
}

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

function render(){
  const body = document.getElementById('editPlanBody');
  if (!body || !working) return;
  body.innerHTML = '';
  working.stages.forEach((stg, i)=>{
    const tr = document.createElement('tr');
    const isSel = selected.has(i);
    tr.className = isSel ? 'bg-white/5' : '';
    tr.innerHTML = `
      <td class="py-1 pr-1 text-center"><input type="checkbox" data-act="selRow" data-i="${i}" ${isSel ? 'checked' : ''} class="accent-emerald-600"></td>
      <td class="py-1 pr-1 text-slate-300 text-center">E${stg.index}</td>
      <td class="py-1 pr-1 text-center"><div class="min-w-[4rem] text-center">${fmtMMSS(stg.durationSec)}</div></td>
      <td class="py-1 pr-1">
        <div class="flex items-center justify-center gap-1">
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700" data-act="addLower" data-delta="-5" data-i="${i}">−5</button>
          <input type="number" class="w-14 rounded-lg bg-slate-900/60 border border-white/10 p-1" value="${stg.lower}" data-act="inputLower" data-i="${i}"/>
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700" data-act="addLower" data-delta="5" data-i="${i}">+5</button>
        </div>
      </td>
      <td class="py-1 pr-1">
        <div class="flex items-center justify-center gap-1">
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700" data-act="addUpper" data-delta="-5" data-i="${i}">−5</button>
          <input type="number" class="w-14 rounded-lg bg-slate-900/60 border border-white/10 p-1" value="${stg.upper}" data-act="inputUpper" data-i="${i}"/>
          <button class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700" data-act="addUpper" data-delta="5" data-i="${i}">+5</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
  // header checkbox state
  const selAll = document.getElementById('editSelAll');
  if (selAll) selAll.checked = (selected.size === (working?.stages?.length || 0) && selected.size > 0);
}

function recalcTotal(){
  if (!working) return;
  working.totalDurationSec = working.stages.reduce((a,s)=>a + clamp(Math.round(s.durationSec), 0, 86400), 0);
}

function setError(msg){
  const el = document.getElementById('editPlanError');
  if (!el) return;
  if (msg){ el.textContent = msg; el.classList.remove('hidden'); }
  else { el.textContent = ''; el.classList.add('hidden'); }
}

function validate(){
  if (!working) return false;
  for (const s of working.stages){
    if (!(s.durationSec >= 0)) { setError('Duração inválida em um dos estágios.'); return false; }
    if (!(s.upper > s.lower)) { setError('Limites inválidos: superior deve ser maior que inferior.'); return false; }
  }
  setError('');
  return true;
}

function onClick(e){
  const t = e.target.closest('button');
  if (!working) return;
  // Per-row selection checkbox is an input, not a button
  if (!t) return;
  const act = t.dataset.act;
  const i = Number(t.dataset.i);
  if (act === 'selRow'){
    const idx = Number(t.dataset.i);
    if (t.checked) selected.add(idx); else selected.delete(idx);
    render(); return;
  }
  // Row time controls removed; time adjustments are global via top bar selection
  if (act === 'addLower'){
    const d = Number(t.dataset.delta) || 0;
    working.stages[i].lower = clamp(Math.round(working.stages[i].lower + d), 0, 300);
    render();
  }
  if (act === 'addUpper'){
    const d = Number(t.dataset.delta) || 0;
    working.stages[i].upper = clamp(Math.round(working.stages[i].upper + d), 0, 300);
    render();
  }
  // Per-row reset removed
  if (act === 'adjTime'){
    const d = Number(t.dataset.delta) || 0;
    if (selected.size === 0) return;
    [...selected].forEach(idx => { working.stages[idx].durationSec = clamp(Math.round(working.stages[idx].durationSec + d), 0, 86400); });
    recalcTotal(); render();
  }
  // Global controls are time-only
}

function onInput(e){
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  const i = Number(el.dataset.i);
  const act = el.dataset.act;
  if (!working || Number.isNaN(i)) return;
  const val = Math.round(Number(el.value));
  if (act === 'selRow'){
    if (el.checked) selected.add(i); else selected.delete(i);
    render();
    return;
  }
  if (act === 'inputLower'){ working.stages[i].lower = clamp(val, 0, 300); }
  if (act === 'inputUpper'){ working.stages[i].upper = clamp(val, 0, 300); }
  validate();
}

export function loadPlanForEdit(session){
  originalSession = deepCopySession(session);
  working = deepCopySession(session);
  selected = new Set();
  document.getElementById('editPlanScreen')?.classList.remove('hidden');
  document.getElementById('planScreen')?.classList.add('hidden');
  render();
}

export function startWithEditedPlan(){
  if (!validate()) return;
  // Ensure indices are sequential
  working.stages.forEach((s, idx) => { s.index = idx + 1; });
  recalcTotal();
  startTraining(working);
}

export function backToPlan(){
  document.getElementById('editPlanScreen')?.classList.add('hidden');
  document.getElementById('planScreen')?.classList.remove('hidden');
}

// Events
document.addEventListener('click', (e)=>{
  if (document.getElementById('editPlanScreen')?.classList.contains('hidden')) return;
  onClick(e);
});
document.addEventListener('input', (e)=>{
  if (document.getElementById('editPlanScreen')?.classList.contains('hidden')) return;
  onInput(e);
});

// Select all handler
document.getElementById('editSelAll')?.addEventListener('change', (e)=>{
  if (!working) return;
  if (e.target.checked) selected = new Set(working.stages.map((_, idx)=>idx));
  else selected.clear();
  render();
});

document.getElementById('editStartBtn')?.addEventListener('click', startWithEditedPlan);
document.getElementById('editBackBtn')?.addEventListener('click', backToPlan);
