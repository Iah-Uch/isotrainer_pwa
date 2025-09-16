import { parseTimeToSeconds, fmtMMSS, pad2 } from './utils.js';
import { state } from './state.js';
import { loadPlanForEdit } from './edit-plan.js';
import { showScreen, loadCompletedSessionFromExportCsv } from './session.js';

const STORAGE_KEY = 'cardiomax:plans';
const STORAGE_DONE_KEY = 'cardiomax:doneSessions';

export function loadStoredPlans() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const plans = JSON.parse(raw);
    if (!Array.isArray(plans)) return [];
    // Migration: ensure each session has a stable id
    let mutated = false;
    for (let i = 0; i < plans.length; i++) {
      const s = plans[i];
      if (isValidSession(s) && !s.id) {
        s.id = 'plan_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36) + '_' + i;
        mutated = true;
      }
      // Migration: ensure a stable numeric index (based on current order)
      if (isValidSession(s) && (typeof s.idx !== 'number' || !Number.isFinite(s.idx))) {
        s.idx = i + 1;
        mutated = true;
      }
    }
    if (mutated) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch { }
    }
    return plans.filter(isValidSession);
  } catch { return []; }
}

export function savePlans(plans) {
  try {
    const arr = Array.isArray(plans) ? plans.slice() : [];
    for (let i = 0; i < arr.length; i++) {
      if (isValidSession(arr[i]) && !arr[i].id) {
        arr[i].id = 'plan_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36) + '_' + i;
      }
      if (isValidSession(arr[i]) && (typeof arr[i].idx !== 'number' || !Number.isFinite(arr[i].idx))) {
        arr[i].idx = i + 1;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch { }
}

export function loadDoneSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_DONE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveDoneSessions(arr) {
  try { localStorage.setItem(STORAGE_DONE_KEY, JSON.stringify(arr || [])); } catch { }
}
export function saveCompletedSession(record) {
  const cur = loadDoneSessions();
  // Prepend newest
  try {
    if (!record || typeof record !== 'object') return;
    // De-duplicate by exact CSV content when available
    try {
      if (record.csv) {
        const idx = cur.findIndex(r => r && r.csv && r.csv === record.csv);
        if (idx !== -1) {
          // Already present; do not add duplicate
          return saveDoneSessions(cur);
        }
      }
    } catch { }
    if (!record.id) record.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (!record.title) record.title = `${record.date || 'Sessão'} • ${Number(record.stagesCount || 0)} estágios`;
    cur.unshift(record);
  } catch { cur.unshift(record); }
  saveDoneSessions(cur);
}

function isValidSession(s) {
  return s && typeof s.date === 'string' && typeof s.athlete === 'string' && Array.isArray(s.stages) && s.stages.length > 0;
}

/* ================================
   XOR + HEX DECODING (matches server)
   - First 16 hex chars are the key (8 bytes)
   - Remaining hex is payload
   - Decrypt: data[i] ^ key[i % key.length]
=================================== */

function ensureHex(str, label = 'conteúdo') {
  const s = String(str || '').trim();
  if (!s) throw new Error(`Nenhum ${label} fornecido.`);
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error(`${label} contém caracteres não-hex.`);
  if (s.length % 2 !== 0) throw new Error(`${label} possui comprimento ímpar.`);
  return s;
}

function hexToBytes(hex) {
  const s = ensureHex(hex, 'HEX');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const v = parseInt(s.substr(i, 2), 16);
    if (!Number.isFinite(v)) throw new Error('HEX inválido.');
    out[i / 2] = v;
  }
  return out;
}

function xorDecryptHexBlob(blob) {
  const s = ensureHex(blob, 'Arquivo');
  if (s.length < 18) throw new Error('Conteúdo muito curto para conter chave e dados.');
  const keyHex = s.slice(0, 16);
  const dataHex = s.slice(16);
  ensureHex(keyHex, 'Chave');
  ensureHex(dataHex, 'Payload');

  const key = hexToBytes(keyHex);
  const data = hexToBytes(dataHex);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];

  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(out);
  } catch {
    // Fallback latin-1 style
    let txt = '';
    for (let i = 0; i < out.length; i++) txt += String.fromCharCode(out[i]);
    return txt;
  }
}

/**
 * Decide how to interpret the file:
 * - If it looks like a single long hex blob (even length, hex only), we try XOR decrypt.
 * - Otherwise we treat it as plain semicolon-separated text.
 */
function tryDecodeContent(rawText) {
  if (!rawText) return '';
  const s = String(rawText).trim();
  // Compact: strip whitespace to detect hex-only payloads saved with accidental wraps
  const compact = s.replace(/\s+/g, '');
  const hexish = compact.startsWith('0x') || compact.startsWith('0X') ? compact.slice(2) : compact;
  if (/^[0-9a-fA-F]+$/.test(hexish) && (hexish.length % 2 === 0)) {
    // Try as encrypted blob
    try { return xorDecryptHexBlob(hexish); } catch { /* fall through */ }
  }
  // Fallback to plaintext (semicolon-separated)
  return s;
}

/* ================================
   CSV (semicolon) parsing – mirrors server format
   Lines:
     0: <numSessions>;<initialDate>;<finalDate>;<athleteName>
     1: Training;Date;Stage;Stage Type;Time;MinBPM;MaxBPM
     2+: <sessionNo>;<DD/MM/YYYY>;<stageNo>;<type>;<HH:MM:SS>;<min>;<max>
=================================== */

function normalizeText(text) {
  // Strip BOM, trim ends
  return String(text || '').replace(/^\uFEFF/, '').trim();
}

function parseMetaLine(line) {
  const parts = line.split(';');
  if (parts.length < 4) throw new Error('Linha de metadados inválida (esperado: numSessões;dataInicial;dataFinal;nome).');
  const numSessions = parseInt(parts[0], 10);
  if (!Number.isFinite(numSessions)) throw new Error('Número de sessões inválido na linha de metadados.');
  const athlete = parts.slice(3).join(';').trim();
  if (!athlete) throw new Error('Nome/atleta ausente na linha de metadados.');
  return { numSessions, athlete };
}

function looksLikeHeader(parts) {
  if (parts.length < 7) return false;
  // Accept variations; only sanity-check column intent
  const p0 = (parts[0] || '').toLowerCase();
  const p1 = (parts[1] || '').toLowerCase();
  const p2 = (parts[2] || '').toLowerCase();
  const p3 = (parts[3] || '').toLowerCase();
  const p4 = (parts[4] || '').toLowerCase();
  const p5 = (parts[5] || '').toLowerCase();
  const p6 = (parts[6] || '').toLowerCase();
  return (
    /train/.test(p0) && /date|data/.test(p1) &&
    /stage|etapa|fase/.test(p2) && /type|tipo/.test(p3) &&
    /time|tempo/.test(p4) && /min/.test(p5) && /max/.test(p6)
  );
}

function parseRow(parts, lineNo) {
  if (parts.length < 7) throw new Error(`Linha ${lineNo}: colunas insuficientes (mínimo 7).`);
  const sessionNum = parseInt(parts[0], 10);
  if (!Number.isFinite(sessionNum)) throw new Error(`Linha ${lineNo}: número da sessão inválido.`);
  const dateStr = String(parts[1] || '').trim();
  // Expect DD/MM/YYYY per backend
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    throw new Error(`Linha ${lineNo}: data inválida (esperado DD/MM/AAAA).`);
  }
  const type = String(parts[3] || '').trim(); // kept for parity with backend (not used in UI)
  const timeStr = String(parts[4] || '').trim();
  const min = Number(parts[5]);
  const max = Number(parts[6]);
  if (!timeStr || !/^\d{1,2}:\d{2}:\d{2}$/.test(timeStr)) {
    throw new Error(`Linha ${lineNo}: duração inválida (esperado HH:MM:SS).`);
  }
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
    throw new Error(`Linha ${lineNo}: limites de BPM inválidos (max deve ser > min).`);
  }
  return { sessionNum, dateStr, type, timeStr, min, max };
}

export function parsePeriodizationCsv(text) {
  const src = normalizeText(text);
  if (!src) throw new Error('O arquivo está vazio.');

  const rawLines = src.split(/\r?\n/).map(l => l.trim());
  const lines = rawLines.filter(l => l.length > 0);
  if (lines.length < 3) throw new Error('Conteúdo insuficiente (metadados, cabeçalho e linhas de treino são esperados).');

  // Meta line
  const meta = parseMetaLine(lines[0]);

  // Header handling: accept a header row; if the second line is not a header, assume data begins there.
  let idx = 1;
  const p1 = lines[idx]?.split(';') ?? [];
  if (looksLikeHeader(p1)) idx += 1;

  const sessions = [];
  let current = null;
  let currentSessionNum = null;
  let stageCounter = 0;

  for (let i = idx; i < lines.length; i++) {
    const parts = lines[i].split(';').map(s => s.trim());
    const row = parseRow(parts, i + 1);

    // New session boundary?
    if (currentSessionNum !== row.sessionNum) {
      // push previous session if present
      if (current && current.stages.length) {
        current.totalDurationSec = current.stages.reduce((a, s) => a + s.durationSec, 0);
        sessions.push(current);
      }
      currentSessionNum = row.sessionNum;
      stageCounter = 0;
      current = {
        date: row.dateStr,       // string in DD/MM/YYYY for your UI matching
        athlete: meta.athlete,   // from meta line
        type: row.type || null,  // optional
        stages: [],
        totalDurationSec: 0
      };
    }

    stageCounter += 1;
    const durationSec = parseTimeToSeconds(row.timeStr);
    current.stages.push({
      index: stageCounter,
      durationSec,
      lower: row.min,
      upper: row.max
    });
  }

  // Push last session (important)
  if (current && current.stages.length) {
    current.totalDurationSec = current.stages.reduce((a, s) => a + s.durationSec, 0);
    sessions.push(current);
  }

  if (!sessions.length) throw new Error('Nenhuma sessão de treino encontrada.');

  // Optional: check declared vs parsed; not fatal, but could be useful
  if (Number.isFinite(meta.numSessions) && meta.numSessions !== sessions.length) {
    // We won’t throw; just keep parsed result. Uncomment if you want to enforce:
    // throw new Error(`Contagem de sessões divergente: declarado ${meta.numSessions}, encontrado ${sessions.length}.`);
    // no-op
  }

  return sessions;
}

/* ================================
   Utility: today's plan selection
=================================== */

export function getTodayPlan(plans) {
  if (!plans || !plans.length) return null;
  const today = new Date();
  const yyyy = String(today.getFullYear());
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const candidates = plans.filter(p => dateMatches(p.date, yyyy, mm, dd));
  return candidates[0] || null;
}

function dateMatches(dateStr, yyyy, mm, dd) {
  if (!dateStr) return false;
  const s = String(dateStr).trim();
  let m = s.match(/^(\d{1,2})[\/](\d{1,2})[\/]([\d]{2,4})$/);
  if (m) {
    const DD = m[1].padStart(2, '0');
    const MM = m[2].padStart(2, '0');
    const YYYY = m[3].length === 2 ? ('20' + m[3]) : m[3];
    return YYYY === yyyy && MM === mm && DD === dd;
  }
  m = s.match(/^([\d]{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const YYYY = m[1];
    const MM = m[2].padStart(2, '0');
    const DD = m[3].padStart(2, '0');
    return YYYY === yyyy && MM === mm && DD === dd;
  }
  return false;
}

/* ================================
   Rendering & interactions
=================================== */

const PAGE_SIZE = 5;
let todoPage = 1; // A fazer
let todoTotalPages = 1;
let overduePage = 1; // Pendente
let overdueTotalPages = 1;
let donePage = 1; // Concluído
let doneTotalPages = 1;

export function renderHome(plans) {
  const root = document.getElementById('homeScreen');
  if (!root) return;
  const todoListEl = document.getElementById('todoList');
  const overdueListEl = document.getElementById('overdueList');
  const todayEl = document.getElementById('todayPlan');
  const empty = document.getElementById('plansEmpty');
  const emptyState = document.getElementById('homeEmptyState');
  const contentWrap = document.getElementById('homeContentWrap');
  const doneList = document.getElementById('plansDoneList');
  const tabTodoBtn = document.getElementById('tabTodo');
  const tabOverdueBtn = document.getElementById('tabOverdue');
  const tabDoneBtn = document.getElementById('tabDone');
  const panelTodo = document.getElementById('panelTodo');
  const panelOverdue = document.getElementById('panelOverdue');
  const panelDone = document.getElementById('panelDone');
  const todoPager = document.getElementById('todoPager');
  const todoPagerPrev = document.getElementById('todoPagerPrev');
  const todoPagerNext = document.getElementById('todoPagerNext');
  const todoPagerInfo = document.getElementById('todoPagerInfo');
  const overduePager = document.getElementById('overduePager');
  const overduePagerPrev = document.getElementById('overduePagerPrev');
  const overduePagerNext = document.getElementById('overduePagerNext');
  const overduePagerInfo = document.getElementById('overduePagerInfo');
  const src = Array.isArray(plans) ? plans.slice() : [];
  const dones = loadDoneSessions();
  const hasPlans = src.length > 0;

  // Empty state rules:
  // - Show the beautiful import dropzone whenever there are no plans (even if there are done sessions)
  // - Show the main content (tabs/lists) only if there are plans or done sessions
  const homeActions = document.getElementById('homeActions');
  const homeMenuWrap = document.getElementById('homeMenuWrap');
  if (!hasPlans) {
    if (emptyState) emptyState.classList.remove('hidden');
    // Show quick actions (manual/import) when there are no plans yet
    if (homeActions) homeActions.classList.remove('hidden');
  } else {
    if (emptyState) emptyState.classList.add('hidden');
    // Hide quick actions when plans exist (users can use the FAB menu)
    if (homeActions) homeActions.classList.add('hidden');
  }
  // Do not force Home FAB visibility here; showScreen controls visibility per screen.
  const hasAnyForContent = hasPlans || (dones.length > 0);
  if (contentWrap) contentWrap.classList.toggle('hidden', !hasAnyForContent);
  if (!hasAnyForContent) {
    if (empty) empty.classList.add('hidden');
    return;
  }
  // Remove done sessions from pending preferring stable plan id; fall back to
  // index match only when id linkage is unavailable (older records).
  function isDone(s) {
    if (!s) return false;
    const sid = s.id;
    const sidx = Number(s.idx);
    return dones.some(r => {
      if (!r) return false;
      // Prefer exact id match when available on both sides
      if (sid && r.planId && r.planId === sid) return true;
      // Fallback: allow index match only if either side lacks a stable id
      if ((!sid || !r.planId) && Number.isFinite(sidx) && Number(r.planIdx) === sidx) return true;
      return false;
    });
  }
  const pendingAll = src.filter(s => !isDone(s));
  // Never show the small warning box here; it's for first-import guidance only
  if (empty) empty.classList.add('hidden');

  // Date helpers
  function parseDateKey(dstr) {
    const s = String(dstr || '').trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const DD = m[1].padStart(2, '0');
      const MM = m[2].padStart(2, '0');
      const YYYY = m[3].length === 2 ? ('20' + m[3]) : m[3];
      return Number(`${YYYY}${MM}${DD}`);
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const YYYY = m[1];
      const MM = m[2].padStart(2, '0');
      const DD = m[3].padStart(2, '0');
      return Number(`${YYYY}${MM}${DD}`);
    }
    return NaN;
  }
  const now = new Date();
  const todayKey = Number(
    String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
  );
  const isToday = (s) => parseDateKey(s?.date) === todayKey;
  const isFutureOrToday = (s) => {
    const k = parseDateKey(s?.date);
    return Number.isFinite(k) && k >= todayKey;
  };
  const isPast = (s) => {
    const k = parseDateKey(s?.date);
    return Number.isFinite(k) && k < todayKey;
  };

  const todoItems = pendingAll.filter(isFutureOrToday);
  const overdueItems = pendingAll.filter(isPast);

  if (todayEl) {
    todayEl.innerHTML = '';
    const today = getTodayPlan(todoItems);
    if (today) {
      // Resolve original index so clicking the Today card opens the correct session
      const todayIdx = src.findIndex(s => (s?.id && today?.id) ? (s.id === today.id) : (s === today));
      todayEl.appendChild(makePlanCard(today, true, todayIdx >= 0 ? todayIdx : 0));
    } else {
      const div = document.createElement('div');
      div.className = 'text-slate-400 text-sm';
      div.textContent = 'Nenhum plano para hoje.';
      todayEl.appendChild(div);
    }
  }

  // A fazer list (today and forward)
  if (todoListEl) {
    todoListEl.innerHTML = '';
    todoTotalPages = Math.max(1, Math.ceil(todoItems.length / PAGE_SIZE));
    todoPage = Math.min(Math.max(1, todoPage), todoTotalPages);
    const start = (todoPage - 1) * PAGE_SIZE;
    const pageItems = todoItems.slice(start, start + PAGE_SIZE);
    pageItems.forEach((p) => {
      const origIdx = src.findIndex(s => (s?.id && p?.id) ? (s.id === p.id) : (s === p));
      todoListEl.appendChild(makePlanCard(p, false, origIdx >= 0 ? origIdx : 0));
    });
  }

  // Pendente list (past, not completed)
  if (overdueListEl) {
    overdueListEl.innerHTML = '';
    overdueTotalPages = Math.max(1, Math.ceil(overdueItems.length / PAGE_SIZE));
    overduePage = Math.min(Math.max(1, overduePage), overdueTotalPages);
    const startO = (overduePage - 1) * PAGE_SIZE;
    const pageOverdue = overdueItems.slice(startO, startO + PAGE_SIZE);
    pageOverdue.forEach((p) => {
      const origIdx = src.findIndex(s => (s?.id && p?.id) ? (s.id === p.id) : (s === p));
      overdueListEl.appendChild(makePlanCard(p, false, origIdx >= 0 ? origIdx : 0));
    });
  }

  // Done list
  if (doneList) {
    doneList.innerHTML = '';
    if (!dones.length) {
      const d = document.createElement('div'); d.className = 'text-sm text-slate-400'; d.textContent = 'Nenhuma sessão concluída ainda.'; doneList.appendChild(d);
    } else {
      doneTotalPages = Math.max(1, Math.ceil(dones.length / PAGE_SIZE));
      donePage = Math.min(Math.max(1, donePage), doneTotalPages);
      const startD = (donePage - 1) * PAGE_SIZE;
      const pageDones = dones.slice(startD, startD + PAGE_SIZE);
      pageDones.forEach((rec, i) => doneList.appendChild(makeDoneCard(rec, startD + i)));
    }
  }

  // Todo pager controls
  if (todoPager && todoPagerPrev && todoPagerNext && todoPagerInfo) {
    todoPager.classList.toggle('hidden', todoItems.length <= PAGE_SIZE);
    todoPagerPrev.disabled = (todoPage <= 1);
    todoPagerNext.disabled = (todoPage >= todoTotalPages);
    todoPagerInfo.textContent = `Página ${todoPage} de ${todoTotalPages}`;
    todoPagerPrev.onclick = () => { if (todoPage > 1) { todoPage -= 1; renderHome(loadStoredPlans()); } };
    todoPagerNext.onclick = () => { if (todoPage < todoTotalPages) { todoPage += 1; renderHome(loadStoredPlans()); } };
  }

  // Overdue pager controls
  if (overduePager && overduePagerPrev && overduePagerNext && overduePagerInfo) {
    overduePager.classList.toggle('hidden', overdueItems.length <= PAGE_SIZE);
    overduePagerPrev.disabled = (overduePage <= 1);
    overduePagerNext.disabled = (overduePage >= overdueTotalPages);
    overduePagerInfo.textContent = `Página ${overduePage} de ${overdueTotalPages}`;
    overduePagerPrev.onclick = () => { if (overduePage > 1) { overduePage -= 1; renderHome(loadStoredPlans()); } };
    overduePagerNext.onclick = () => { if (overduePage < overdueTotalPages) { overduePage += 1; renderHome(loadStoredPlans()); } };
  }

  // Done pager
  const dp = document.getElementById('donePager');
  const dPrev = document.getElementById('donePagerPrev');
  const dNext = document.getElementById('donePagerNext');
  const dInfo = document.getElementById('donePagerInfo');
  if (dp && dPrev && dNext && dInfo) {
    dp.classList.toggle('hidden', dones.length <= PAGE_SIZE);
    dPrev.disabled = (donePage <= 1);
    dNext.disabled = (donePage >= doneTotalPages);
    dInfo.textContent = `Página ${donePage} de ${doneTotalPages}`;
    dPrev.onclick = () => { if (donePage > 1) { donePage -= 1; renderHome(loadStoredPlans()); } };
    dNext.onclick = () => { if (donePage < doneTotalPages) { donePage += 1; renderHome(loadStoredPlans()); } };
  }

  // Tabs
  function activate(tab) {
    if (!tabTodoBtn || !tabOverdueBtn || !tabDoneBtn || !panelTodo || !panelOverdue || !panelDone) return;
    if (!hasPlans && (tab === 'todo' || tab === 'overdue')) tab = 'done';
    const isTodo = tab === 'todo';
    const isOverdue = tab === 'overdue';
    const isDone = tab === 'done';
    tabTodoBtn.classList.toggle('bg-slate-700', isTodo);
    tabTodoBtn.classList.toggle('bg-slate-800', !isTodo);
    tabOverdueBtn.classList.toggle('bg-slate-700', isOverdue);
    tabOverdueBtn.classList.toggle('bg-slate-800', !isOverdue);
    tabDoneBtn.classList.toggle('bg-slate-700', isDone);
    tabDoneBtn.classList.toggle('bg-slate-800', !isDone);
    panelTodo.classList.toggle('hidden', !isTodo);
    panelOverdue.classList.toggle('hidden', !isOverdue);
    panelDone.classList.toggle('hidden', !isDone);
  }
  if (tabTodoBtn) {
    tabTodoBtn.disabled = !hasPlans;
    tabTodoBtn.classList.toggle('opacity-50', !hasPlans);
    tabTodoBtn.classList.toggle('cursor-not-allowed', !hasPlans);
    tabTodoBtn.title = hasPlans ? '' : 'Importe uma periodização para ver A fazer';
    tabTodoBtn.onclick = () => { if (hasPlans) activate('todo'); };
  }
  if (tabOverdueBtn) {
    tabOverdueBtn.disabled = !hasPlans;
    tabOverdueBtn.classList.toggle('opacity-50', !hasPlans);
    tabOverdueBtn.classList.toggle('cursor-not-allowed', !hasPlans);
    tabOverdueBtn.title = hasPlans ? '' : 'Importe uma periodização para ver Pendente';
    tabOverdueBtn.onclick = () => { if (hasPlans) activate('overdue'); };
  }
  if (tabDoneBtn) { tabDoneBtn.onclick = () => activate('done'); }
  // default tab
  activate(hasPlans ? 'todo' : 'done');
}

let previewIndex = null;

function makePlanCard(session, isToday = false, index = 0) {
  const card = document.createElement('div');
  card.className = 'rounded-xl border border-white/10 bg-gradient-to-br from-white/5 to-white/10 p-4 flex items-center justify-between gap-3 hover:from-white/10 hover:to-white/20 transition cursor-pointer';
  const info = document.createElement('div');
  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-center gap-2';
  const title = document.createElement('div');
  title.className = 'font-semibold';
  title.textContent = `${session.date || '—'}`;
  titleRow.appendChild(title);
  if (isToday) {
    const badge = document.createElement('span');
    badge.className = 'px-2 py-0.5 text-xs rounded-full bg-emerald-600/20 text-emerald-300 border border-emerald-600/30';
    badge.textContent = 'Hoje';
    titleRow.appendChild(badge);
  }
  const sub = document.createElement('div');
  sub.className = 'text-slate-400 text-sm';
  sub.textContent = `${session.athlete || '—'} • ${session.stages.length} estágios • ${fmtMMSS(session.totalDurationSec)}`;
  info.appendChild(titleRow); info.appendChild(sub);
  card.appendChild(info);
  card.addEventListener('click', () => openPreview(index));
  return card;
}

function makeDoneCard(rec, index = 0) {
  const card = document.createElement('div');
  card.className = 'rounded-xl border border-white/10 bg-gradient-to-br from-white/5 to-white/10 p-4 flex items-center justify-between gap-3 hover:from-white/10 hover:to-white/20 transition cursor-pointer';
  const info = document.createElement('div');
  const title = document.createElement('div'); title.className = 'font-semibold'; title.textContent = rec.title || rec.date || '—';
  const sub = document.createElement('div');
  sub.className = 'text-slate-400 text-sm';
  const parts = [];
  parts.push(`${rec.stagesCount} estágios`);
  parts.push(`${fmtMMSS(rec.totalDurationSec)}`);
  if (rec?.stats?.avg != null) parts.push(`Média ${rec.stats.avg} bpm`);
  // Append completion time if available
  try {
    if (rec?.completedAt) {
      const d = new Date(rec.completedAt);
      if (!isNaN(d.getTime())) {
        const hh = pad2(d.getHours());
        const mm = pad2(d.getMinutes());
        parts.push(`Finalizada ${hh}:${mm}`);
      }
    }
  } catch {}
  sub.textContent = parts.join(' • ');
  info.appendChild(title); info.appendChild(sub);
  card.appendChild(info);
  // Open modal with actions when clicking the card
  card.addEventListener('click', () => openDonePreview(index));
  return card;
}

function openPreview(index) {
  previewIndex = index;
  const plans = loadStoredPlans();
  const s = plans[index];
  const modal = document.getElementById('sessionPreviewModal');
  const body = document.getElementById('sessionPreviewBody');
  const startBtn = document.getElementById('sessionPreviewStart');
  const editBtn = document.getElementById('sessionPreviewEdit');
  // Top bar controls
  const viewBtnTop = document.getElementById('sessionPreviewView');
  const dlBtnTop = document.getElementById('sessionPreviewDownload');
  const renBtnTop = document.getElementById('sessionPreviewRename');
  const delBtnTop = document.getElementById('sessionPreviewDelete');
  // Bottom bar controls
  const viewBtnBottom = document.getElementById('sessionPreviewViewBottom');
  const dlBtnBottom = document.getElementById('sessionPreviewDownloadBottom');
  const renBtnBottom = document.getElementById('sessionPreviewRenameBottom');
  const delBtnBottom = document.getElementById('sessionPreviewDeleteBottom');
  if (!modal || !body || !s) return;
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'space-y-2 text-left';
  const h = document.createElement('div'); h.className = 'text-lg font-semibold'; h.textContent = s.date || '—';
  const meta = document.createElement('div'); meta.className = 'text-slate-400 text-sm'; meta.textContent = `${s.stages.length} estágios • ${fmtMMSS(s.totalDurationSec)}`;
  const list = document.createElement('div'); list.className = 'max-h-48 overflow-auto rounded-md border border-white/10 bg-white/5 p-2 text-sm';
  const ul = document.createElement('ul'); ul.className = 'space-y-1';
  s.stages.slice(0, 10).forEach(st => { const li = document.createElement('li'); li.textContent = `E${st.index}: ${fmtMMSS(st.durationSec)} • ${st.lower}/${st.upper}`; ul.appendChild(li); });
  if (s.stages.length > 10) { const li = document.createElement('li'); li.className = 'text-slate-500'; li.textContent = `+${s.stages.length - 10} estágios`; ul.appendChild(li); }
  list.appendChild(ul);
  wrap.appendChild(h); wrap.appendChild(meta); wrap.appendChild(list);
  body.appendChild(wrap);
  // Show Start and optional Edit; hide all other controls
  startBtn?.classList.remove('hidden');
  if (editBtn) {
    editBtn.classList.remove('hidden');
    editBtn.onclick = () => { try { closePreview(); loadPlanForEdit(s, 'home'); showScreen('editPlan'); } catch { } };
  }
  viewBtnTop?.classList.add('hidden');
  dlBtnTop?.classList.add('hidden');
  renBtnTop?.classList.add('hidden');
  delBtnTop?.classList.add('hidden');
  // Hide footer secondary controls
  viewBtnBottom?.classList.add('hidden');
  dlBtnBottom?.classList.add('hidden');
  renBtnBottom?.classList.add('hidden');
  delBtnBottom?.classList.add('hidden');
  modal.classList.remove('hidden');
}

function closePreview() {
  const modal = document.getElementById('sessionPreviewModal');
  if (modal) modal.classList.add('hidden');
  previewIndex = null;
}

function confirmPreview() {
  const idx = previewIndex;
  closePreview();
  if (typeof idx !== 'number') return;
  const plans = loadStoredPlans();
  const s = plans[idx];
  if (!s) return;
  // Direct start flow: editing is optional via the Edit button
  try {
    const sessionCopy = JSON.parse(JSON.stringify(s));
    if (sessionCopy.id && !sessionCopy.planId) sessionCopy.planId = sessionCopy.id;
    if (Number.isFinite(Number(sessionCopy.idx)) && !Number.isFinite(Number(sessionCopy.planIdx))) sessionCopy.planIdx = Number(sessionCopy.idx);
    state.editOrigin = 'home';
    state.pendingIntent = { type: 'startEdited', session: sessionCopy };
    state.startReturnScreen = 'home';
    showScreen('connect');
    try {
      const nextBtn = document.getElementById('goToPlanButton');
      if (nextBtn) nextBtn.disabled = !(state.device && state.device.gatt?.connected);
    } catch { }
  } catch {
    // Fallback: open editor
    loadPlanForEdit(s, 'home');
    showScreen('editPlan');
  }
}

function openDonePreview(index) {
  const plans = loadDoneSessions();
  const rec = plans[index];
  const modal = document.getElementById('sessionPreviewModal');
  const body = document.getElementById('sessionPreviewBody');
  const startBtn = document.getElementById('sessionPreviewStart');
  const editBtn = document.getElementById('sessionPreviewEdit');
  const dlBtnTop = document.getElementById('sessionPreviewDownload');
  const viewBtnTop = document.getElementById('sessionPreviewView');
  const renBtnTop = document.getElementById('sessionPreviewRename');
  const delBtnTop = document.getElementById('sessionPreviewDelete');
  const viewBtnBottom = document.getElementById('sessionPreviewViewBottom');
  const dlBtnBottom = document.getElementById('sessionPreviewDownloadBottom');
  const renBtnBottom = document.getElementById('sessionPreviewRenameBottom');
  const delBtnBottom = document.getElementById('sessionPreviewDeleteBottom');
  if (!modal || !body || !rec) return;
  body.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'space-y-2 text-left';
  // Title (will be swapped with an input when renaming)
  const titleText = document.createElement('span'); titleText.id = 'sessionPreviewTitleText'; titleText.className = 'text-lg font-semibold'; titleText.textContent = rec.title || rec.date || '—';
  const meta = document.createElement('div'); meta.className = 'text-slate-400 text-sm'; meta.textContent = `${rec.stagesCount} estágios • ${fmtMMSS(rec.totalDurationSec)}`;
  const stats = document.createElement('div'); stats.className = 'grid grid-cols-2 gap-2 text-sm';
  const mk = (label, val) => { const d = document.createElement('div'); d.className = 'rounded bg-white/5 p-2'; d.innerHTML = `<div class="text-slate-400 text-xs">${label}</div><div class="font-semibold">${val}</div>`; return d; };
  stats.appendChild(mk('FC média', `${rec?.stats?.avg ?? 0} bpm`));
  stats.appendChild(mk('FC máx', `${rec?.stats?.max ?? 0} bpm`));
  stats.appendChild(mk('FC mín', `${rec?.stats?.min ?? 0} bpm`));
  stats.appendChild(mk('No alvo', `${rec?.stats?.inTargetPct ?? 0}%`));
  wrap.appendChild(titleText); wrap.appendChild(meta); wrap.appendChild(stats);
  body.appendChild(wrap);
  // Buttons
  const footer = document.getElementById('sessionPreviewFooter');
  const leftCtrls = document.getElementById('sessionPreviewFooterLeft');
  const rightCtrls = document.getElementById('sessionPreviewFooterRight');
  if (startBtn) startBtn.classList.add('hidden');
  if (editBtn) editBtn.classList.add('hidden');
  const canView = !!rec.csv;
  const wireView = (btn) => { if (!btn) return; btn.classList.toggle('hidden', !canView); btn.onclick = () => { try { if (rec.csv) { closePreview(); loadCompletedSessionFromExportCsv(rec.csv); } } catch { } }; };
  wireView(viewBtnTop); wireView(viewBtnBottom);
  const wireDownload = (btn) => { if (!btn) return; btn.classList.toggle('hidden', !rec.csv || rec.isImported); btn.onclick = () => { try { const blob = new Blob([rec.csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); const dateSlug = String(rec.date || '').replace(/\s+/g, '_'); a.href = url; a.download = `cardiomax_${dateSlug || 'session'}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); } catch { } }; };
  wireDownload(dlBtnTop); wireDownload(dlBtnBottom);
  const startRename = () => {
    const form = document.createElement('form');
    form.className = 'flex items-center gap-2';
    form.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); saveRename(); });
    const input = document.createElement('input');
    input.type = 'text'; input.value = rec.title || rec.date || '';
    input.className = 'flex-1 rounded-lg bg-slate-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600';
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); } });
    const okBtn = document.createElement('button');
    okBtn.type = 'submit'; okBtn.title = 'Salvar'; okBtn.setAttribute('aria-label', 'Salvar');
    okBtn.className = 'h-9 w-9 grid place-items-center rounded-full bg-emerald-600 hover:bg-emerald-500';
    okBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 12l2 2 4-4 1.5 1.5L11 17 7.5 13.5 9 12z"/></svg>';
    form.appendChild(input);
    form.appendChild(okBtn);
    titleText.replaceWith(form);
    setTimeout(() => { try { input.focus(); input.select(); } catch { } }, 0);
    function saveRename() {
      const arr = loadDoneSessions();
      const rec2 = arr[index];
      if (!rec2) return;
      const val = String(input.value || '').trim();
      if (!val) { cancelRename(); return; }
      rec2.title = val; saveDoneSessions(arr);
      titleText.textContent = val;
      try { renderHome(loadStoredPlans()); } catch { }
      form.replaceWith(titleText);
      try { closePreview(); } catch { }
      // Return to Done tab after renaming
      setTimeout(() => { try { document.getElementById('tabDone')?.click(); } catch { } }, 0);
    }
    function cancelRename() { form.replaceWith(titleText); }
  };
  if (renBtnTop) { renBtnTop.classList.remove('hidden'); renBtnTop.onclick = startRename; }
  if (renBtnBottom) { renBtnBottom.classList.remove('hidden'); renBtnBottom.onclick = startRename; }
  const wireDelete = (btn) => { if (!btn) return; btn.classList.remove('hidden'); btn.onclick = () => deleteDone(index); };
  wireDelete(delBtnTop); wireDelete(delBtnBottom);
  // Center footer primary action (View) in done mode
  if (footer && leftCtrls && rightCtrls) {
    // Hide left block to avoid imbalance and center the right block
    leftCtrls.classList.add('hidden');
    footer.classList.remove('justify-between');
    footer.classList.add('justify-center');
  }
  modal.classList.remove('hidden');
}

// Rename a completed session record
function renameDone(index) { /* replaced by inline rename */ }

// Delete a completed session record
function deleteDone(index) {
  const arr = loadDoneSessions();
  const rec = arr[index];
  if (!rec) return;
  const ok = confirm('Tem certeza que deseja excluir esta sessão?');
  if (!ok) return;
  arr.splice(index, 1);
  saveDoneSessions(arr);
  try { renderHome(loadStoredPlans()); } catch { }
  try { closePreview(); } catch { }
  // Ensure Done tab remains active
  setTimeout(() => { try { document.getElementById('tabDone')?.click(); } catch { } }, 0);
}

function onLoadPlan(idx) {
  const plans = loadStoredPlans();
  const s = plans[idx];
  if (!s) return;
  loadPlanForEdit(s, 'home');
  showScreen('editPlan');
}
function onStartPlan(idx) { onLoadPlan(idx); }

export function bindHomeNav() {
  document.getElementById('homeManualBtn')?.addEventListener('click', () => { showScreen('plan'); });
  const importPlansBtn = document.getElementById('importPlansBtn');
  const importPlansInput = document.getElementById('importPlansInput');
  importPlansBtn?.addEventListener('click', () => importPlansInput?.click());
  document.getElementById('menuImportPlan')?.addEventListener('click', () => importPlansInput?.click());
  const onDecoded = (decoded) => {
    const sessions = parsePeriodizationCsv(decoded);
    savePlans(sessions);
    renderHome(sessions);
    alert('Planos importados com sucesso.');
    // Switch to hamburger after first import
    try { document.getElementById('homeActions')?.classList.add('hidden'); document.getElementById('homeMenuWrap')?.classList.remove('hidden'); } catch { }
  };
  importPlansInput?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { onDecoded(tryDecodeContent(String(reader.result || ''))); }
      catch (err) { alert('Falha ao importar planos: ' + (err?.message || String(err))); }
    };
    reader.onerror = () => alert('Não foi possível ler o arquivo.');
    reader.readAsText(f);
  });
  try { renderHome(loadStoredPlans()); } catch { }

  // Preview modal wiring
  // Cancel button removed; close via X or backdrop
  document.getElementById('sessionPreviewClose')?.addEventListener('click', closePreview);
  document.getElementById('sessionPreviewStart')?.addEventListener('click', confirmPreview);
  const modal = document.getElementById('sessionPreviewModal');
  modal?.addEventListener('click', (e) => { if (e.target === modal) closePreview(); });
  // Empty-state big import button
  // Empty state drag & drop zone wiring
  const dropzone = document.getElementById('homeEmptyDropzone');
  if (dropzone) {
    const highlight = (on) => {
      dropzone.classList.toggle('ring-2', on);
      dropzone.classList.toggle('ring-purple-600/60', on);
    };
    dropzone.addEventListener('click', () => importPlansInput?.click());
    dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); importPlansInput?.click(); } });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); highlight(true); });
    dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); highlight(false); });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); highlight(false);
      const files = e.dataTransfer?.files;
      const f = files && files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const decoded = tryDecodeContent(String(reader.result || ''));
          const sessions = parsePeriodizationCsv(decoded);
          savePlans(sessions);
          renderHome(sessions);
          alert('Planos importados com sucesso.');
        } catch (err) {
          alert('Falha ao importar: ' + (err?.message || String(err)));
        }
      };
      reader.onerror = () => alert('Não foi possível ler o arquivo.');
      reader.readAsText(f);
    });
  }
  // Update Home when sessions complete
  window.addEventListener('sessions:updated', () => { try { renderHome(loadStoredPlans()); } catch { } });
  // Hamburger menu visibility & actions
  const actions = document.getElementById('homeActions');
  const menuWrap = document.getElementById('homeMenuWrap');
  const menuBtn = document.getElementById('homeMenuBtn');
  const menu = document.getElementById('homeMenu');
  const importSessionBtn = document.getElementById('homeImportSessionBtn');
  function refreshMenuVisibility() { const hasPlans = (loadStoredPlans().length > 0); if (actions) actions.classList.toggle('hidden', hasPlans); if (menuWrap) menuWrap.classList.toggle('hidden', !hasPlans); }
  refreshMenuVisibility();
  menuBtn?.addEventListener('click', () => { if (!menu) return; const hidden = menu.classList.toggle('hidden'); menuBtn?.setAttribute('aria-expanded', hidden ? 'false' : 'true'); });
  document.addEventListener('click', (e) => { if (!menu || !menuBtn) return; if (menu.contains(e.target) || menuBtn.contains(e.target)) return; menu.classList.add('hidden'); menuBtn?.setAttribute('aria-expanded', 'false'); });
  document.getElementById('menuManual')?.addEventListener('click', () => { showScreen('plan'); menu?.classList.add('hidden'); });
  document.getElementById('menuImportSession')?.addEventListener('click', () => { document.getElementById('homeImportSessionInput')?.click(); menu?.classList.add('hidden'); });
  document.getElementById('menuSettings')?.addEventListener('click', () => { try { openSettings(); } finally { menu?.classList.add('hidden'); } });
  document.getElementById('menuExportAll')?.addEventListener('click', () => { try { exportAllDoneCsv(); } finally { menu?.classList.add('hidden'); } });
  document.getElementById('menuResetApp')?.addEventListener('click', () => { try { resetApplication(); } finally { menu?.classList.add('hidden'); } });
}

// Build a single CSV aggregating all saved sessions (same columns as per-exported format)
function exportAllDoneCsv() {
  const dones = loadDoneSessions();
  if (!dones || !dones.length) { alert('Nenhuma sessão concluída disponível para exportar.'); return; }
  const HEADER = 'type;date;athlete;stage_index;duration_sec;lower;upper;avg;min;max;inTargetPct;samples;elapsed_sec;stage_elapsed_sec;hr;inTarget';
  const parts = [HEADER];
  for (const rec of dones) {
    const csv = String(rec?.csv || '').trim();
    if (!csv) continue; // skip records without CSV
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // skip per-session header
    for (let i = 1; i < lines.length; i++) parts.push(lines[i]);
  }
  if (parts.length <= 1) { alert('Nenhuma sessão com dados de CSV para exportar.'); return; }
  const out = parts.join('\n');
  const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateSlug = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url; a.download = `cardiomax_sessoes_${dateSlug}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function resetApplication() {
  const ok = confirm('Isso irá apagar periodizações e sessões salvas deste aplicativo neste dispositivo. Deseja continuar?');
  if (!ok) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_DONE_KEY);
  } catch { }
  try { location.reload(); } catch { }
}

// ============= Settings (Contrast Mode) ============= //
const CONTRAST_KEY = 'cardiomax:ui:contrast';
export function isContrastOn() {
  try { return localStorage.getItem(CONTRAST_KEY) === '1'; } catch { return false; }
}
export function applyContrastToDocument(on) {
  try {
    document.documentElement.classList.toggle('contrast', !!on);
    document.body.classList.toggle('contrast', !!on);
    // Notify charts/UI to re-style
    window.dispatchEvent(new CustomEvent('ui:contrast', { detail: { on: !!on } }));
    try { window.dispatchEvent(new Event('resize')); } catch { }
  } catch {}
}
export function openSettings() {
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('settingsClose');
  const toggle = document.getElementById('contrastToggle');
  if (!modal || !toggle) return;
  try { toggle.checked = isContrastOn(); } catch { }
  modal.classList.add('flex');
  modal.classList.remove('hidden');
  const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
  closeBtn?.addEventListener('click', close, { once: true });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
  toggle.onchange = () => {
    const on = !!toggle.checked;
    try { localStorage.setItem(CONTRAST_KEY, on ? '1' : '0'); } catch {}
    applyContrastToDocument(on);
  };
}
