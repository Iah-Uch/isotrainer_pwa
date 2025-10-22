// Module: Plans import, storage, rendering and interactions.
import { parseTimeToSeconds, fmtMMSS, pad2, clamp } from "./utils.js";
import { state, DEV_BYPASS_CONNECT } from './state.js';
import { loadPlanForEdit } from "./edit-plan.js";
import { FIXED_PLAN_LIBRARY } from './mesocycles.js';

// Re-export for backward compatibility
export { FIXED_PLAN_LIBRARY };

import {
  showScreen,
  loadCompletedSessionFromExportCsv,
  prepareFixedPlanFlow,
} from "./session.js";

const STORAGE_KEY = "isotrainer:plans";
const STORAGE_DONE_KEY = "isotrainer:doneSessions";
const REST_INTERVAL_KEY = "isotrainer:rest:interval";
const REST_POSITIONS_KEY = "isotrainer:rest:positions";
const REST_SKIP_KEY = "isotrainer:rest:skip";
const FLOW_STEP_ORDER_KEY = "isotrainer:flow:order";
const FIXED_PLAN_PREF_KEY = "isotrainer:home:fixedPlans";
const PROFILE_VERSION = 2;
const PROFILE_FORCE_KEY = "isotrainer:profiles:forceSelect";

// Flow step mapping (1-based index).
export const FLOW_TRAINING_STEPS = [
  {
    id: "R1",
    arm: "direito",
    label: "Braço Direito • Treino 1",
    description: "Inclui medição de força máxima.",
    captureMax: true,
    suffix: " • Série 1",
  },
  {
    id: "R2",
    arm: "direito",
    label: "Braço Direito • Treino 2",
    description: "Segunda série do braço direito.",
    captureMax: false,
    suffix: " • Série 2",
  },
  {
    id: "L1",
    arm: "esquerdo",
    label: "Braço Esquerdo • Treino 1",
    description: "Inclui medição de força máxima.",
    captureMax: true,
    suffix: " • Série 1",
  },
  {
    id: "L2",
    arm: "esquerdo",
    label: "Braço Esquerdo • Treino 2",
    description: "Segunda série do braço esquerdo.",
    captureMax: false,
    suffix: " • Série 2",
  },
];

export const FLOW_REST_SLOTS = [1, 2, 3];
export const DEFAULT_FLOW_STEP_ORDER = FLOW_TRAINING_STEPS.map((step) => step.id);
const FLOW_MEASUREMENT_SECONDS = 3;
const DEFAULT_REST_POSITIONS = [1, 3];

export function getFlowTrainingStepById(id) {
  if (!id) return null;
  return FLOW_TRAINING_STEPS.find((step) => step.id === id) || null;
}

export function sanitizeFlowStepOrder(input) {
  const seen = new Set();
  const order = [];
  const source = Array.isArray(input) ? input : [];
  source.forEach((value) => {
    const id = String(value);
    if (seen.has(id)) return;
    const meta = getFlowTrainingStepById(id);
    if (!meta) return;
    seen.add(id);
    order.push(id);
  });
  DEFAULT_FLOW_STEP_ORDER.forEach((id) => {
    if (!seen.has(id)) order.push(id);
  });
  return order;
}


export function getFixedPlanLibrary() {
  return FIXED_PLAN_LIBRARY.slice();
}

export function getFixedPlanById(id) {
  return FIXED_PLAN_LIBRARY.find((plan) => plan.id === id) || null;
}

function sumPlanStageSeconds(plan) {
  if (!plan || !Array.isArray(plan.stages)) return 0;
  return plan.stages.reduce((total, stage) => {
    const dur = Number(stage?.durationSec) || 0;
    return total + Math.max(0, Math.round(dur));
  }, 0);
}

function computeFixedPlanSessionSeconds(plan) {
  const stageTotal = sumPlanStageSeconds(plan);
  const restPositions = Array.isArray(state.restPositions)
    ? state.restPositions
    : [];
  const uniqueRest = Array.from(
    new Set(
      restPositions
        .map((slot) => normalizeRestSlot(slot))
        .filter((slot) => slot !== null),
    ),
  );
  const restInterval = clamp(Number(state.restIntervalSec) || 0, 0, 3600);
  const restTotal = uniqueRest.length * restInterval;
  const trainingRunsPerArm = 2;
  const arms = 2;
  const measurementTotal =
    FLOW_TRAINING_STEPS.filter((step) => step.captureMax).length *
    FLOW_MEASUREMENT_SECONDS;
  return stageTotal * trainingRunsPerArm * arms + restTotal + measurementTotal;
}

// ============= Profile Management ============= //

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function makeId(prefix, idx = 0) {
  return (
    `${prefix}_` +
          Math.random().toString(36).slice(2) +
          "_" +
          Date.now().toString(36) +
    (idx ? `_${idx}` : "")
  );
}

function defaultPlanState() {
  return {
    version: PROFILE_VERSION,
    activeProfileId: null,
    profiles: [],
  };
}

function inferProfileName(plans, fallback = "Atleta") {
  for (const plan of plans || []) {
    const candidate = String(plan?.athlete || "").trim();
    if (candidate) return candidate;
  }
  return fallback;
}

function isValidSession(s) {
  if (!s || typeof s.date !== "string" || typeof s.athlete !== "string") {
    return false;
  }
  // Fixed plan references are valid even with empty stages
  if (s.isFixedPlanReference && s.fixedPlanId) {
    return true;
  }
  // Regular sessions must have stages
  return Array.isArray(s.stages) && s.stages.length > 0;
}

function sanitizePlansForProfile(rawPlans, profileId) {
  const arr = Array.isArray(rawPlans) ? rawPlans.slice() : [];
  const list = [];
  let mutated = false;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!isValidSession(item)) {
        mutated = true;
      continue;
    }
    const plan = {
      ...item,
      stages: Array.isArray(item.stages)
        ? item.stages.map((st) => ({ ...st }))
        : [],
    };
    if (!plan.id) {
      plan.id = makeId("plan", list.length);
        mutated = true;
      }
    const numericIdx = Number(plan.idx);
    if (!Number.isFinite(numericIdx) || numericIdx < 1) {
      plan.idx = list.length + 1;
      mutated = true;
    } else {
      plan.idx = numericIdx;
    }
    if (plan.profileId !== profileId) {
      plan.profileId = profileId;
      mutated = true;
    }
    if (!Number.isFinite(Number(plan.totalDurationSec))) {
      try {
        // For fixed plan references, calculate from library
        if (plan.isFixedPlanReference && plan.fixedPlanId) {
          const fixedPlan = getFixedPlanById(plan.fixedPlanId);
          if (fixedPlan) {
            plan.totalDurationSec = sumPlanStageSeconds(fixedPlan);
          } else {
            plan.totalDurationSec = 0;
          }
        } else {
          // For regular sessions, sum from stages
          plan.totalDurationSec = plan.stages.reduce(
            (acc, st) => acc + Math.max(0, Number(st.durationSec) || 0),
            0,
          );
        }
        mutated = true;
  } catch {
        plan.totalDurationSec = 0;
      }
    }
    list.push(plan);
  }
  for (let i = 0; i < list.length; i++) {
    if (list[i].idx !== i + 1) {
      list[i].idx = i + 1;
      mutated = true;
    }
  }
  return { list, mutated };
}

function sanitizeProfile(rawProfile, index = 0) {
  if (!rawProfile || typeof rawProfile !== "object")
    return { profile: null, mutated: true };
  let mutated = false;
  const id =
    typeof rawProfile.id === "string" && rawProfile.id.trim()
      ? rawProfile.id.trim()
      : makeId("profile", index);
  if (id !== rawProfile.id) mutated = true;
  const { list: plans, mutated: plansMutated } = sanitizePlansForProfile(
    rawProfile.plans,
    id,
  );
  if (plansMutated) mutated = true;
  let name = String(rawProfile.name || "").trim();
  if (!name) {
    name = inferProfileName(plans, `Atleta ${index + 1}`);
    mutated = true;
  }
  const createdAt =
    typeof rawProfile.createdAt === "string" && rawProfile.createdAt
      ? rawProfile.createdAt
      : nowIso();
  let updatedAt =
    typeof rawProfile.updatedAt === "string" && rawProfile.updatedAt
      ? rawProfile.updatedAt
      : createdAt;
  if (plansMutated) updatedAt = nowIso();
  return {
    profile: {
      id,
      name,
      createdAt,
      updatedAt,
      plans,
    },
    mutated,
  };
}

function convertArrayToState(plansArray) {
  const profileId = makeId("profile", 0);
  const { list } = sanitizePlansForProfile(plansArray, profileId);
  const now = nowIso();
  return {
    version: PROFILE_VERSION,
    activeProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: inferProfileName(list, "Atleta"),
        createdAt: now,
        updatedAt: now,
        plans: list,
      },
    ],
  };
}

function enforceStateShape(rawState) {
  let mutated = false;
  if (!rawState || typeof rawState !== "object") {
    return { state: defaultPlanState(), mutated: true };
  }
  if (!Array.isArray(rawState.profiles) && Array.isArray(rawState.plans)) {
    return { state: convertArrayToState(rawState.plans), mutated: true };
  }
  const profiles = [];
  const rawProfiles = Array.isArray(rawState.profiles) ? rawState.profiles : [];
  for (let i = 0; i < rawProfiles.length; i++) {
    const { profile, mutated: profileMutated } = sanitizeProfile(rawProfiles[i], i);
    if (profile) profiles.push(profile);
    if (profileMutated) mutated = true;
  }
  let activeId =
    typeof rawState.activeProfileId === "string"
      ? rawState.activeProfileId
      : null;
  if (profiles.length) {
    if (!activeId || !profiles.some((p) => p.id === activeId)) {
      activeId = profiles[0].id;
      mutated = true;
    }
  } else if (activeId) {
    activeId = null;
    mutated = true;
  }
  const version = Number(rawState.version) === PROFILE_VERSION ? PROFILE_VERSION : PROFILE_VERSION;
  if (Number(rawState.version) !== PROFILE_VERSION) mutated = true;
  return {
    state: { version, activeProfileId: activeId, profiles },
    mutated,
  };
}

function writePlanState(planState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(planState));
  } catch {}
}

function syncActiveProfile(profileId) {
  try {
    state.activeProfileId = profileId || null;
  } catch {}
}

function readPlanState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) {
    syncActiveProfile(null);
    return defaultPlanState();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    syncActiveProfile(null);
    return defaultPlanState();
  }
  if (Array.isArray(parsed)) {
    const st = convertArrayToState(parsed);
    writePlanState(st);
    syncActiveProfile(st.activeProfileId);
    return st;
  }
  const { state: ensured, mutated } = enforceStateShape(parsed);
  if (mutated) writePlanState(ensured);
  syncActiveProfile(ensured.activeProfileId);
  return ensured;
}

export function getPlanProfiles() {
  const st = readPlanState();
  return st.profiles.map((p) => ({
    id: p.id,
    name: p.name,
    plansCount: Array.isArray(p.plans) ? p.plans.length : 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export function getActiveProfileId() {
  const st = readPlanState();
  return st.activeProfileId || null;
}

export function setActiveProfileId(profileId) {
  const st = readPlanState();
  if (!profileId || !st.profiles.some((p) => p.id === profileId)) {
    profileId = st.profiles.length ? st.profiles[0].id : null;
  }
  if (st.activeProfileId === profileId) {
    syncActiveProfile(profileId);
    return profileId;
  }
  st.activeProfileId = profileId;
  writePlanState(st);
  syncActiveProfile(profileId);
  return profileId;
}

export function markProfileSelectionRequired() {
  try {
    localStorage.setItem(PROFILE_FORCE_KEY, "1");
  } catch {}
}

export function clearProfileSelectionRequired() {
  try {
    localStorage.removeItem(PROFILE_FORCE_KEY);
  } catch {}
}

export function isProfileSelectionRequired() {
  try {
    return localStorage.getItem(PROFILE_FORCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function loadStoredPlans() {
  const st = readPlanState();
  const active = st.profiles.find((p) => p.id === st.activeProfileId);
  if (!active) return [];
  return active.plans.filter(isValidSession);
}

let pendingProfileReturnId = null;

export function savePlans(plans, opts = {}) {
  const arr = Array.isArray(plans) ? plans.slice() : [];
  const st = readPlanState();
  const providedName =
    typeof opts === "object" && opts && typeof opts.profileName === "string"
      ? opts.profileName.trim()
      : "";
  let targetId =
    opts && typeof opts.profileId === "string" && opts.profileId
      ? opts.profileId
      : null;
  let profile = targetId
    ? st.profiles.find((p) => p.id === targetId)
    : null;
  let createdNewProfile = false;
  const previousActiveId = st.activeProfileId || null;
  if (!profile) {
    targetId = targetId || makeId("profile", st.profiles.length);
    const now = nowIso();
    profile = {
      id: targetId,
      name:
        providedName || inferProfileName(arr, `Atleta ${st.profiles.length + 1}`),
      createdAt: now,
      updatedAt: now,
      plans: [],
    };
    st.profiles.push(profile);
    createdNewProfile = true;
  } else if (providedName && profile.name !== providedName) {
    profile.name = providedName;
  }
  const { list } = sanitizePlansForProfile(arr, profile.id);
  profile.plans = list;
  profile.updatedAt = nowIso();
  st.activeProfileId = profile.id;
  writePlanState(st);
  syncActiveProfile(profile.id);
  if (createdNewProfile) pendingProfileReturnId = previousActiveId;
  else pendingProfileReturnId = null;
  if (createdNewProfile && st.profiles.length > 1) markProfileSelectionRequired();
  if (st.profiles.length <= 1) clearProfileSelectionRequired();
  try {
    window.dispatchEvent(
      new CustomEvent("plans:updated", {
        detail: { activeProfileId: profile.id },
      }),
    );
  } catch {}
  return profile.plans.slice();
}

export function loadDoneSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_DONE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
export function saveDoneSessions(arr) {
  try {
    localStorage.setItem(STORAGE_DONE_KEY, JSON.stringify(arr || []));
  } catch { }
}
export function saveCompletedSession(record) {
  const cur = loadDoneSessions();
  const profileId = getActiveProfileId();
  // Prepend newest.
  try {
    if (!record || typeof record !== "object") return;
    if (profileId && !record.profileId) record.profileId = profileId;
    // De-duplicate by exact CSV content when available.
    try {
      if (record.csv) {
        const idx = cur.findIndex((r) => r && r.csv && r.csv === record.csv);
        if (idx !== -1) {
          // Already present; do not add duplicate.
          return saveDoneSessions(cur);
        }
      }
    } catch { }
    if (!record.id)
      record.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (!record.title)
      record.title = `${record.date || "Sessão"} • ${Number(record.stagesCount || 0)} estágios`;
    cur.unshift(record);
  } catch {
    cur.unshift(record);
  }
  saveDoneSessions(cur);
}

/* XOR + HEX decoding (server-compatible)
   - First 16 hex chars are key (8 bytes)
   - Remaining hex is payload
   - Decrypt: data[i] ^ key[i % key.length] */

function ensureHex(str, label = "conteúdo") {
  const s = String(str || "").trim();
  if (!s) throw new Error(`Nenhum ${label} fornecido.`);
  if (!/^[0-9a-fA-F]+$/.test(s))
    throw new Error(`${label} contém caracteres não-hex.`);
  if (s.length % 2 !== 0) throw new Error(`${label} possui comprimento ímpar.`);
  return s;
}

function hexToBytes(hex) {
  const s = ensureHex(hex, "HEX");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const v = parseInt(s.substr(i, 2), 16);
    if (!Number.isFinite(v)) throw new Error("HEX inválido.");
    out[i / 2] = v;
  }
  return out;
}

function xorDecryptHexBlob(blob) {
  const s = ensureHex(blob, "Arquivo");
  if (s.length < 18)
    throw new Error("Conteúdo muito curto para conter chave e dados.");
  const keyHex = s.slice(0, 16);
  const dataHex = s.slice(16);
  ensureHex(keyHex, "Chave");
  ensureHex(dataHex, "Payload");

  const key = hexToBytes(keyHex);
  const data = hexToBytes(dataHex);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];

  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(out);
  } catch {
    // Fallback latin-1 style
    let txt = "";
    for (let i = 0; i < out.length; i++) txt += String.fromCharCode(out[i]);
    return txt;
  }
}

// Decide how to interpret the file:
// - If it looks like a single hex blob (even length, hex only), try XOR decrypt.
// - Otherwise, treat it as plain semicolon-separated text.
function tryDecodeContent(rawText) {
  if (!rawText) return "";
  const s = String(rawText).trim();
  // Strip whitespace to detect hex-only payloads saved with accidental wraps.
  const compact = s.replace(/\s+/g, "");
  const hexish =
    compact.startsWith("0x") || compact.startsWith("0X")
      ? compact.slice(2)
      : compact;
  if (/^[0-9a-fA-F]+$/.test(hexish) && hexish.length % 2 === 0) {
    // Try as encrypted blob.
    try {
      return xorDecryptHexBlob(hexish);
    } catch {
      /* fall through */
    }
  }
  // Fallback to plaintext (semicolon-separated).
  return s;
}

/* CSV parsing (semicolon), mirrors server format
   0: <numSessions>;<initialDate>;<finalDate>;<athleteName>
   1: Training;Date;Stage;Stage Type;Time;MinBPM;MaxBPM
   2+: <sessionNo>;<DD/MM/YYYY>;<stageNo>;<type>;<HH:MM:SS>;<min>;<max> */

function normalizeText(text) {
  // Strip BOM, trim ends
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function parseMetaLine(line) {
  const parts = line.split(";");
  if (parts.length < 4)
    throw new Error(
      "Linha de metadados inválida (esperado: numSessões;dataInicial;dataFinal;nome).",
    );
  const numSessions = parseInt(parts[0], 10);
  if (!Number.isFinite(numSessions))
    throw new Error("Número de sessões inválido na linha de metadados.");
  const athlete = parts.slice(3).join(";").trim();
  if (!athlete) throw new Error("Nome/atleta ausente na linha de metadados.");
  return { numSessions, athlete };
}

function looksLikeHeader(parts) {
  if (parts.length < 7) return false;
  // Accept variations; only sanity-check column intent
  const p0 = (parts[0] || "").toLowerCase();
  const p1 = (parts[1] || "").toLowerCase();
  const p2 = (parts[2] || "").toLowerCase();
  const p3 = (parts[3] || "").toLowerCase();
  const p4 = (parts[4] || "").toLowerCase();
  const p5 = (parts[5] || "").toLowerCase();
  const p6 = (parts[6] || "").toLowerCase();
  return (
    /train/.test(p0) &&
    /date|data/.test(p1) &&
    /stage|etapa|fase/.test(p2) &&
    /type|tipo/.test(p3) &&
    /time|tempo/.test(p4) &&
    /min/.test(p5) &&
    /max/.test(p6)
  );
}

function parseRow(parts, lineNo) {
  if (parts.length < 7)
    throw new Error(`Linha ${lineNo}: colunas insuficientes (mínimo 7).`);
  const sessionNum = parseInt(parts[0], 10);
  if (!Number.isFinite(sessionNum))
    throw new Error(`Linha ${lineNo}: número da sessão inválido.`);
  const dateStr = String(parts[1] || "").trim();
  // Expect DD/MM/YYYY per backend
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    throw new Error(`Linha ${lineNo}: data inválida (esperado DD/MM/AAAA).`);
  }
  const type = String(parts[3] || "").trim(); // kept for parity with backend (not used in UI)
  const timeStr = String(parts[4] || "").trim();
  const min = Number(parts[5]);
  const max = Number(parts[6]);
  if (!timeStr || !/^\d{1,2}:\d{2}:\d{2}$/.test(timeStr)) {
    throw new Error(`Linha ${lineNo}: duração inválida (esperado HH:MM:SS).`);
  }
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
    throw new Error(
      `Linha ${lineNo}: limites de BPM inválidos (max deve ser > min).`,
    );
  }
  return { sessionNum, dateStr, type, timeStr, min, max };
}

function parseMesocycleReferenceCsv(lines) {
  // New format: date;client;planId;idx;version
  // Header is line 0, data starts at line 1
  if (lines.length < 2) {
    throw new Error("CSV vazio - nenhuma sessão encontrada.");
  }

  const sessions = [];
  const header = lines[0].toLowerCase().split(';').map(s => s.trim());
  
  console.log('Header:', header);
  
  // Check for version marker to ensure new format
  const versionIdx = header.findIndex(h => h === 'version' || h === 'versao');
  if (versionIdx === -1) {
    throw new Error(
      "Formato de CSV inválido ou desatualizado.\n\n" +
      "Este formato não é mais suportado. Use o Gerador de Periodização para criar novos planos compatíveis.\n\n" +
      "O CSV gerado pelo Gerador de Periodização inclui uma coluna 'version' que identifica o formato correto."
    );
  }
  
  // Find column indices
  const dateIdx = header.findIndex(h => h.includes('date') || h.includes('data'));
  const clientIdx = header.findIndex(h => h.includes('client') || h.includes('athlete') || h.includes('atleta'));
  const planIdIdx = header.findIndex(h => h.includes('planid') || h.includes('mesociclo'));
  
  console.log('Column indices:', { dateIdx, clientIdx, planIdIdx, versionIdx });
  
  if (dateIdx === -1 || clientIdx === -1 || planIdIdx === -1) {
    throw new Error("Formato de CSV inválido - colunas esperadas: date, client, planId, version");
  }

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';').map(s => s.trim());
    if (parts.length < 3) continue;

    const dateStr = parts[dateIdx];
    const client = parts[clientIdx];
    const planId = parts[planIdIdx];
    const version = versionIdx !== -1 ? parts[versionIdx] : '';
    
    // Validate version value on first data row
    if (i === 1 && version && !version.includes('isotrainer')) {
      throw new Error(
        "Formato de CSV inválido.\n\n" +
        "Este arquivo não foi gerado pelo Gerador de Periodização do IsoTrainer.\n\n" +
        "Use o Gerador de Periodização para criar planos compatíveis."
      );
    }

    console.log(`Linha ${i}: date=${dateStr}, client=${client}, planId=${planId}, version=${version}`);

    // Validate date format (DD/MM/YYYY)
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
      throw new Error(`Linha ${i + 1}: data inválida (esperado DD/MM/AAAA): ${dateStr}`);
    }

    // Validate that mesocycle exists in library
    const mesocycle = getFixedPlanById(planId);
    if (!mesocycle) {
      console.error(`Mesocycle not found: ${planId}`);
      throw new Error(`Linha ${i + 1}: mesociclo não encontrado na biblioteca: ${planId}\n\nMesociclos disponíveis: mesociclo-incorporacao, mesociclo-basico, mesociclo-estabilizador, mesociclo-controle, mesociclo-pre-otimizacao, mesociclo-recuperativo`);
    }

    console.log(`Found mesocycle: ${mesocycle.name}`);

    // Create a REFERENCE-ONLY session (lightweight, stages resolved at runtime)
    const session = {
      date: dateStr,
      athlete: client,  // Map client column to athlete field (internal field name)
      fixedPlanId: planId,  // Reference to FIXED_PLAN_LIBRARY
      isFixedPlanReference: true,  // Flag to indicate this is a reference
      stages: [],  // Empty - will be resolved from library at runtime
      totalDurationSec: 0,  // Will be calculated from library at runtime
    };
    
    console.log('Created reference session:', session);
    sessions.push(session);
  }

  if (!sessions.length) {
    throw new Error("Nenhuma sessão encontrada no CSV.");
  }

  console.log(`Total sessions created: ${sessions.length}`);
  return sessions;
}

export function parsePeriodizationCsv(text) {
  const src = normalizeText(text);
  if (!src) throw new Error("O arquivo está vazio.");

  const rawLines = src.split(/\r?\n/).map((l) => l.trim());
  const lines = rawLines.filter((l) => l.length > 0);
  if (lines.length < 2)
    throw new Error("Conteúdo insuficiente.");

  // Check for version column to ensure new format only
  const firstLine = lines[0].toLowerCase();
  const hasVersion = firstLine.includes('version') || firstLine.includes('versao');
  
  if (!hasVersion) {
    throw new Error(
      "Formato de CSV inválido ou desatualizado.\n\n" +
      "Este formato não é mais suportado. Use o Gerador de Periodização para criar planos compatíveis.\n\n" +
      "O CSV gerado pelo Gerador de Periodização inclui uma coluna 'version' que identifica o formato correto."
    );
  }
  
  console.log('Parsing mesocycle reference format (version validated)');
  return parseMesocycleReferenceCsv(lines);
}

/* Utility: today's plan selection. */

export function getTodayPlan(plans) {
  if (!plans || !plans.length) return null;
  const today = new Date();
  const yyyy = String(today.getFullYear());
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const candidates = plans.filter((p) => dateMatches(p.date, yyyy, mm, dd));
  return candidates[0] || null;
}

function dateMatches(dateStr, yyyy, mm, dd) {
  if (!dateStr) return false;
  const s = String(dateStr).trim();
  let m = s.match(/^(\d{1,2})[\/](\d{1,2})[\/]([\d]{2,4})$/);
  if (m) {
    const DD = m[1].padStart(2, "0");
    const MM = m[2].padStart(2, "0");
    const YYYY = m[3].length === 2 ? "20" + m[3] : m[3];
    return YYYY === yyyy && MM === mm && DD === dd;
  }
  m = s.match(/^([\d]{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const YYYY = m[1];
    const MM = m[2].padStart(2, "0");
    const DD = m[3].padStart(2, "0");
    return YYYY === yyyy && MM === mm && DD === dd;
  }
  return false;
}

/* Rendering & interactions. */

const PAGE_SIZE = 5;
let todoPage = 1; // A fazer
let todoTotalPages = 1;
let overduePage = 1; // Pendente
let overdueTotalPages = 1;
let donePage = 1; // Concluído
let doneTotalPages = 1;
let activeHomeTab = "fixed";

// Profile selection state
let cachedProfiles = [];
let visibleProfiles = [];
let selectedProfileId = null;
let activeProfileNameModalClose = null;
let previousProfileId = null;
let profileSearchTermRaw = "";
let profileSearchTerm = "";
let profileSearchTermFlat = "";
let profileSearchTokens = [];
let profileSearchExpanded = false;

function normalizeSearchString(str) {
  try {
    return String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  } catch {
    return String(str || "").toLowerCase();
  }
}

function fuzzyMatchToken(token, target) {
  if (!token) return true;
  let pos = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    pos = target.indexOf(ch, pos);
    if (pos === -1) return false;
    pos += 1;
  }
  return true;
}

function profileMatchesTokens(profile) {
  if (!profile || !profileSearchTokens.length) return true;
  const nameKey = normalizeSearchString(profile.name || "");
  const nameFlat = nameKey.replace(/\s+/g, "");
  const countKey = normalizeSearchString(String(profile.plansCount ?? ""));
  const countFlat = countKey.replace(/\s+/g, "");
  return profileSearchTokens.every((token) => {
    if (!token) return true;
    const tokenFlat = token.replace(/\s+/g, "");
    if (nameKey.includes(token) || countKey.includes(token)) return true;
    if (tokenFlat && (nameFlat.includes(tokenFlat) || countFlat.includes(tokenFlat)))
      return true;
    if (fuzzyMatchToken(token, nameKey)) return true;
    if (tokenFlat && fuzzyMatchToken(tokenFlat, nameFlat)) return true;
    return false;
  });
}

function getProfileMatchScore(profile, originalIndex = 0) {
  if (!profile) return -Infinity;
  const nameKey = normalizeSearchString(profile.name || "");
  const nameFlat = nameKey.replace(/\s+/g, "");
  const countKey = normalizeSearchString(String(profile.plansCount ?? ""));
  const countFlat = countKey.replace(/\s+/g, "");
  let score = 0;
  if (profileSearchTerm && nameKey === profileSearchTerm) score += 10000;
  if (profileSearchTermFlat && nameFlat === profileSearchTermFlat) score += 9000;
  if (profileSearchTerm && countKey === profileSearchTerm) score += 3000;
  if (profileSearchTermFlat && countFlat === profileSearchTermFlat)
    score += 2500;
  if (profileSearchTerm && nameKey.startsWith(profileSearchTerm)) score += 1200;
  if (profileSearchTermFlat && nameFlat.startsWith(profileSearchTermFlat))
    score += 1100;
  if (profileSearchTerm && nameKey.includes(profileSearchTerm)) score += 800;
  if (profileSearchTermFlat && nameFlat.includes(profileSearchTermFlat)) score += 700;
  if (profileSearchTerm && countKey.includes(profileSearchTerm)) score += 200;
  if (profileSearchTermFlat && countFlat.includes(profileSearchTermFlat)) score += 150;
  if (profileSearchTokens.length) {
    let pos = 0;
    let sequential = true;
    for (const token of profileSearchTokens) {
      const idx = nameKey.indexOf(token, pos);
      if (idx === -1) {
        sequential = false;
        break;
      }
      if (idx === pos) score += 80;
      else score += 40 - Math.min(40, idx - pos);
      pos = idx + token.length;
    }
    if (sequential) score += 200;
    else if (profileSearchTermFlat && nameFlat.includes(profileSearchTermFlat))
      score += 180;
  }
  if (profileSearchTerm) {
    score -= Math.abs(nameKey.length - profileSearchTerm.length);
  }
  score -= nameKey.length * 0.05;
  score -= originalIndex * 0.001;
  return score;
}

function filterProfiles(list) {
  if (!Array.isArray(list)) return [];
  if (!profileSearchTokens.length && !profileSearchTerm) return list.slice();
  const filtered = list.filter((profile) => profileMatchesTokens(profile));
  if (!profileSearchTerm && !profileSearchTermFlat) return filtered;
  return filtered
    .map((profile, idx) => ({ profile, idx, score: getProfileMatchScore(profile, idx) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((entry) => entry.profile);
}

function applyProfileSearchUiState({ focus = false } = {}) {
  const wrap = document.getElementById("profileSelectSearchInputWrap");
  const input = document.getElementById("profileSelectSearchInput");
  const btn = document.getElementById("profileSelectSearchBtn");
  if (wrap) wrap.classList.toggle("hidden", !profileSearchExpanded);
  if (btn) {
    btn.setAttribute("aria-expanded", profileSearchExpanded ? "true" : "false");
    btn.classList.toggle("bg-[#0b0b0c]", profileSearchExpanded);
    btn.classList.toggle("bg-[#0b0b0c]", !profileSearchExpanded);
    const searchIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4a6 6 0 014.9 9.6l4.7 4.7-1.4 1.4-4.7-4.7A6 6 0 1110 4zm0 2a4 4 0 100 8 4 4 0 000-8z"/></svg>';
    const collapseIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 5l7 7-7 7-1.4-1.4 5.6-5.6-5.6-5.6z"/></svg>';
    if (profileSearchExpanded) {
      btn.innerHTML = collapseIcon;
      btn.setAttribute("aria-label", "Fechar busca");
      btn.setAttribute("title", "Fechar busca");
    } else {
      btn.innerHTML = searchIcon;
      btn.setAttribute("aria-label", "Buscar atleta");
      btn.setAttribute("title", "Buscar atleta");
    }
  }
  if (input && input.value !== profileSearchTermRaw) input.value = profileSearchTermRaw;
  if (focus && profileSearchExpanded && input) {
    setTimeout(() => {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
      try {
        const len = input.value.length;
        input.setSelectionRange?.(len, len);
      } catch {}
    }, 0);
  }
}

function setProfileSearchExpanded(expanded, options = {}) {
  const focus = options.focus ?? expanded;
  profileSearchExpanded = !!expanded;
  applyProfileSearchUiState({ focus });
}

function setProfileSearchTermRaw(term, { skipRender = false } = {}) {
  profileSearchTermRaw = String(term ?? "");
  profileSearchTerm = normalizeSearchString(profileSearchTermRaw).trim();
  profileSearchTermFlat = profileSearchTerm.replace(/\s+/g, "");
  profileSearchTokens = profileSearchTerm
    ? profileSearchTerm.split(/\s+/).filter(Boolean)
    : [];
  if (!skipRender) renderProfileSelection();
}

function resetProfileSearchState({ clearTerm = true } = {}) {
  if (clearTerm && (profileSearchTermRaw || profileSearchTokens.length))
    setProfileSearchTermRaw("", { skipRender: true });
  setProfileSearchExpanded(false);
}

function expandProfileSearch() {
  setProfileSearchExpanded(true, { focus: true });
}

function collapseProfileSearch({ clearTerm = false } = {}) {
  if (clearTerm) setProfileSearchTermRaw("", { skipRender: true });
  setProfileSearchExpanded(false);
  renderProfileSelection();
}

function formatDateLabel(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    const dd = pad2(d.getDate());
    const mm = pad2(d.getMonth() + 1);
    const yy = d.getFullYear();
    return `${dd}/${mm}/${yy}`;
  } catch {
    return "";
  }
}

function updateActiveProfileBadge() {
  try {
    const wrap = document.getElementById("homeActiveProfileWrap");
    const nameEl = document.getElementById("homeActiveProfileName");
    const switchBtn = document.getElementById("homeSwitchProfileBtn");
    const profiles = getPlanProfiles();
    const activeId = getActiveProfileId();
    const active = profiles.find((p) => p.id === activeId) || null;
    
    // Update the name display
    if (nameEl) {
      if (active) {
        nameEl.textContent = active.name || "—";
      } else if (profiles.length > 0) {
        nameEl.textContent = profiles[0].name || "—";
      } else {
        nameEl.textContent = "—";
      }
    }
    
    // Always show the wrap if there are profiles (1 or more)
    const showWrap = profiles.length > 0;
    if (wrap) wrap.classList.toggle("hidden", !showWrap);
    
    // Show switch button when there are 2+ profiles
    if (switchBtn) switchBtn.classList.toggle("hidden", profiles.length <= 1);
  } catch {}
}

function updateProfileSelectionHighlight() {
  const list = document.getElementById("profileSelectList");
  if (!list) return;
  const containers = list.querySelectorAll("div.relative");
  containers.forEach((container) => {
    const btn = container.querySelector("[data-profile-id]");
    if (!btn) return;
    const isSelected = btn.getAttribute("data-profile-id") === selectedProfileId;
    btn.classList.toggle("border-amber-400/60", isSelected);
    btn.classList.toggle("bg-amber-500/10", isSelected);
    btn.classList.toggle("ring-2", isSelected);
    btn.classList.toggle("ring-amber-500/50", isSelected);
    btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
  });
}

function updateProfileSelectionContinue() {
  const continueBtn = document.getElementById("profileSelectContinue");
  if (!continueBtn) return;
  const selected = visibleProfiles.find((p) => p.id === selectedProfileId) || null;
  if (!selected) {
    continueBtn.classList.add("hidden");
    continueBtn.textContent = "Entrar";
    continueBtn.disabled = true;
    return;
  }
  continueBtn.disabled = false;
  continueBtn.classList.remove("hidden");
  continueBtn.textContent = "Entrar";
}

function handleProfileSelection(profileId) {
  if (!visibleProfiles.some((p) => p.id === profileId)) return;
  selectedProfileId = profileId;
  updateProfileSelectionHighlight();
  updateProfileSelectionContinue();
}

function renderProfileSelection() {
  const list = document.getElementById("profileSelectList");
  const empty = document.getElementById("profileSelectEmpty");
  const noResults = document.getElementById("profileSelectNoResults");
  if (!list) return;
  cachedProfiles = getPlanProfiles();
  const searchBtn = document.getElementById("profileSelectSearchBtn");
  const setSearchButtonDisabled = (disabled) => {
    if (!searchBtn) return;
    searchBtn.disabled = disabled;
    searchBtn.classList.toggle("opacity-50", disabled);
    searchBtn.classList.toggle("cursor-not-allowed", disabled);
  };
  list.innerHTML = "";
  const hasProfiles = cachedProfiles.length > 0;
  if (!hasProfiles) {
    visibleProfiles = [];
    setSearchButtonDisabled(true);
    resetProfileSearchState({ clearTerm: true });
    if (empty) empty.classList.remove("hidden");
    if (noResults) noResults.classList.add("hidden");
    selectedProfileId = null;
    updateProfileSelectionContinue();
    return;
  }
  setSearchButtonDisabled(false);
  applyProfileSearchUiState();
  if (empty) empty.classList.add("hidden");
  visibleProfiles = filterProfiles(cachedProfiles);
  if (!visibleProfiles.length) {
    if (noResults) noResults.classList.remove("hidden");
    selectedProfileId = null;
    updateProfileSelectionContinue();
    return;
  }
  if (noResults) noResults.classList.add("hidden");
  const activeId = getActiveProfileId();
  if (!selectedProfileId || !visibleProfiles.some((p) => p.id === selectedProfileId)) {
    const fallback = visibleProfiles.find((p) => p.id === activeId);
    selectedProfileId = fallback ? fallback.id : visibleProfiles[0].id;
  }
  visibleProfiles.forEach((profile) => {
    const container = document.createElement("div");
    container.className = "relative";
    
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.profileId = profile.id;
    btn.className =
      "w-full text-left rounded-xl border border-[#2a2a2a] bg-[#101011] px-4 py-3 pr-12 transition hover:bg-[#121213] focus:outline-none focus:ring-2 focus:ring-amber-500/40";
    const title = document.createElement("div");
    title.className = "text-lg font-semibold";
    title.textContent = profile.name || "—";
    const meta = document.createElement("div");
    meta.className = "text-sm text-slate-300";
    const count = Number(profile.plansCount || 0);
    const countLabel = count === 1 ? "1 sessão" : `${count} sessões`;
    const dateLabel = formatDateLabel(profile.updatedAt);
    meta.textContent = dateLabel
      ? `${countLabel} • Atualizado ${dateLabel}`
      : countLabel;
    btn.appendChild(title);
    btn.appendChild(meta);
    btn.addEventListener("click", () => {
      handleProfileSelection(profile.id);
    });
    btn.addEventListener("dblclick", () => {
      handleProfileSelection(profile.id);
      confirmProfileSelection();
    });
    
    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className =
      "absolute right-3 top-1/2 -translate-y-1/2 h-9 w-9 grid place-items-center rounded-full bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 hover:text-rose-300 transition";
    deleteBtn.title = "Excluir atleta";
    deleteBtn.setAttribute("aria-label", `Excluir ${profile.name}`);
    deleteBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6 7h12l-1 12a2 2 0 01-2 2H9a2 2 0 01-2-2L6 7zm9-3l-1-1h-4l-1 1H5v2h14V4z" />
      </svg>
    `;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProfile(profile.id);
    });
    
    container.appendChild(btn);
    container.appendChild(deleteBtn);
    list.appendChild(container);
  });
  updateProfileSelectionHighlight();
  updateProfileSelectionContinue();
  const profileScreen = document.getElementById("profileSelectScreen");
  if (profileScreen && !profileScreen.classList.contains("hidden")) {
    setTimeout(() => {
      try {
        if (profileSearchExpanded) {
          const input = document.getElementById("profileSelectSearchInput");
          if (input && document.activeElement !== input) {
            try {
              input.focus({ preventScroll: true });
            } catch {
              input.focus();
            }
            try {
              const len = input.value.length;
              input.setSelectionRange?.(len, len);
            } catch {}
          }
          return;
        }
        const activeBtn = list.querySelector(
          `[data-profile-id="${selectedProfileId}"]`,
        );
        activeBtn?.focus();
      } catch {}
    }, 0);
  }
}

export function confirmProfileSelection() {
  if (!selectedProfileId) return;
  let selected = cachedProfiles.find((p) => p.id === selectedProfileId);
  if (!selected) selected = getPlanProfiles().find((p) => p.id === selectedProfileId);
  if (!selected) return;
  resetProfileSearchState({ clearTerm: true });
  const resolvedId = setActiveProfileId(selected.id);
  selectedProfileId = resolvedId;
  clearProfileSelectionRequired();
  updateActiveProfileBadge();
  try {
    renderHome(loadStoredPlans());
  } catch {}
  try {
    showScreen("home");
  } catch {}
  try {
    window.dispatchEvent(
      new CustomEvent("plans:activeProfileChanged", {
        detail: { profileId: resolvedId },
      }),
    );
  } catch {}
  previousProfileId = null;
  pendingProfileReturnId = null;
}

export function openProfileSelectionScreen() {
  previousProfileId =
    pendingProfileReturnId !== null
      ? pendingProfileReturnId
      : getActiveProfileId();
  pendingProfileReturnId = null;
  resetProfileSearchState({ clearTerm: true });
  selectedProfileId = getActiveProfileId();
  renderProfileSelection();
  try {
    showScreen("profiles");
  } catch {}
}

export function cancelProfileSelection() {
  resetProfileSearchState({ clearTerm: true });
  let targetId = previousProfileId;
  if (targetId != null) targetId = setActiveProfileId(targetId);
  else targetId = getActiveProfileId();
  previousProfileId = null;
  pendingProfileReturnId = null;
  selectedProfileId = null;
  clearProfileSelectionRequired();
  updateActiveProfileBadge();
  try {
    renderHome(loadStoredPlans());
  } catch {}
  try {
    showScreen("home");
  } catch {}
  try {
    window.dispatchEvent(
      new CustomEvent("plans:activeProfileChanged", {
        detail: { profileId: targetId },
      }),
    );
  } catch {}
}

function deleteProfile(profileId) {
  if (!profileId) return;
  
  const st = readPlanState();
  const profile = st.profiles.find(p => p.id === profileId);
  if (!profile) return;
  
  const count = Array.isArray(profile.plans) ? profile.plans.length : 0;
  const message = count > 0
    ? `Tem certeza que deseja excluir "${profile.name}"?\n\nIsso removerá ${count} ${count === 1 ? 'sessão' : 'sessões'} agendadas e todas as sessões concluídas deste atleta.`
    : `Tem certeza que deseja excluir "${profile.name}"?`;
  
  const ok = confirm(message);
  if (!ok) return;
  
  // Remove the profile
  st.profiles = st.profiles.filter(p => p.id !== profileId);
  
  // Also remove completed sessions for this profile
  try {
    const allDones = loadDoneSessions();
    const filteredDones = allDones.filter(rec => {
      if (!rec) return true;
      if (rec.profileId === profileId) return false;
      // Also check if the record matches plans from this profile
      const planIds = (profile.plans || []).map(p => p.id).filter(Boolean);
      if (rec.planId && planIds.includes(rec.planId)) return false;
      return true;
    });
    saveDoneSessions(filteredDones);
  } catch {}
  
  // If we deleted the active profile, switch to another or null
  if (st.activeProfileId === profileId) {
    st.activeProfileId = st.profiles.length > 0 ? st.profiles[0].id : null;
  }
  
  writePlanState(st);
  syncActiveProfile(st.activeProfileId);
  
  // Update UI
  if (st.profiles.length === 0) {
    // No more profiles, go to home with empty state
    clearProfileSelectionRequired();
    updateActiveProfileBadge();
    try {
      renderHome([]);
    } catch {}
    try {
      showScreen("home");
    } catch {}
  } else if (st.profiles.length === 1) {
    // Only one profile left, auto-select it and go to home
    clearProfileSelectionRequired();
    updateActiveProfileBadge();
    try {
      renderHome(loadStoredPlans());
    } catch {}
    try {
      showScreen("home");
    } catch {}
  } else {
    // Multiple profiles remain, refresh the selector
    renderProfileSelection();
  }
  
  try {
    window.dispatchEvent(
      new CustomEvent("plans:updated", {
        detail: { activeProfileId: st.activeProfileId },
      }),
    );
  } catch {}
}

function promptProfileName(defaultName, fileLabel = "") {
  const modal = document.getElementById("profileNameModal");
  const input = document.getElementById("profileNameInput");
  const cancelBtn = document.getElementById("profileNameCancel");
  const confirmBtn = document.getElementById("profileNameConfirm");
  const errorEl = document.getElementById("profileNameError");
  const fileEl = document.getElementById("profileNameModalFile");
  if (!modal || !input || !cancelBtn || !confirmBtn) {
    return Promise.resolve(String(defaultName || "").trim());
  }
  if (typeof activeProfileNameModalClose === "function") {
    try {
      activeProfileNameModalClose(null);
    } catch {}
    activeProfileNameModalClose = null;
  }
  return new Promise((resolve) => {
    function cleanup(result) {
      modal.classList.add("hidden");
      document.removeEventListener("keydown", onKeydown, true);
      modal.removeEventListener("click", onBackdrop);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      input.removeEventListener("input", onInput);
      if (errorEl) {
        errorEl.classList.add("hidden");
        errorEl.textContent = "";
      }
      activeProfileNameModalClose = null;
      resolve(result);
    }
    function onInput() {
      if (errorEl) errorEl.classList.add("hidden");
    }
    function onConfirm() {
      const value = String(input.value || "").trim();
      if (!value) {
        if (errorEl) {
          errorEl.textContent = "Informe um nome para identificar esta periodização.";
          errorEl.classList.remove("hidden");
        }
        input.focus();
        return;
      }
      cleanup(value);
    }
    function onCancel() {
      cleanup(null);
    }
    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onConfirm();
      }
    }
    function onBackdrop(e) {
      if (e.target === modal) onCancel();
    }
    activeProfileNameModalClose = cleanup;
    if (fileEl) {
      if (fileLabel) {
        fileEl.textContent = fileLabel;
        fileEl.classList.remove("hidden");
      } else {
        fileEl.textContent = "";
        fileEl.classList.add("hidden");
      }
    }
    input.value = defaultName || "";
    if (errorEl) errorEl.classList.add("hidden");
    modal.classList.remove("hidden");
    setTimeout(() => {
      try {
        input.focus();
        if (input.value) input.select();
      } catch {}
    }, 0);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("input", onInput);
    document.addEventListener("keydown", onKeydown, true);
  });
}

export function renderHome(plans) {
  const root = document.getElementById("homeScreen");
  if (!root) return;
  try {
    renderProfileSelection();
  } catch {}
  updateActiveProfileBadge();
  const todoListEl = document.getElementById("todoList");
  const overdueListEl = document.getElementById("overdueList");
  const todayEl = document.getElementById("todayPlan");
  const empty = document.getElementById("plansEmpty");
  const emptyState = document.getElementById("homeEmptyState");
  const contentWrap = document.getElementById("homeContentWrap");
  const tabsWrap = document.getElementById("homeTabs");
  const doneList = document.getElementById("plansDoneList");
  const tabFixedBtn = document.getElementById("tabFixed");
  const tabTodoBtn = document.getElementById("tabTodo");
  const tabOverdueBtn = document.getElementById("tabOverdue");
  const tabDoneBtn = document.getElementById("tabDone");
  const panelFixed = document.getElementById("panelFixed");
  const panelTodo = document.getElementById("panelTodo");
  const panelOverdue = document.getElementById("panelOverdue");
  const panelDone = document.getElementById("panelDone");
  const todoPager = document.getElementById("todoPager");
  const todoPagerPrev = document.getElementById("todoPagerPrev");
  const todoPagerNext = document.getElementById("todoPagerNext");
  const todoPagerInfo = document.getElementById("todoPagerInfo");
  const overduePager = document.getElementById("overduePager");
  const overduePagerPrev = document.getElementById("overduePagerPrev");
  const overduePagerNext = document.getElementById("overduePagerNext");
  const overduePagerInfo = document.getElementById("overduePagerInfo");
  const src = Array.isArray(plans) ? plans.slice() : [];
  const activeProfileId = getActiveProfileId();
  const planIds = new Set(
    src.map((p) => (p && typeof p.id === "string" ? p.id : null)).filter(Boolean),
  );
  const planIdxs = new Set(
    src
      .map((p) => {
        const idx = Number(p?.idx);
        return Number.isFinite(idx) ? idx : null;
      })
      .filter((v) => v !== null),
  );
  const allDones = loadDoneSessions();
  const dones = allDones.filter((rec) => {
    if (!rec) return false;
    if (activeProfileId && rec.profileId) return rec.profileId === activeProfileId;
    if (activeProfileId) {
      if (rec.planId && planIds.has(rec.planId)) return true;
      const idx = Number(rec.planIdx);
      if (Number.isFinite(idx) && planIdxs.has(idx)) return true;
      return false;
    }
    return true;
  });
  const showFixed = !!state.showFixedPlans;
  const hasPlans = src.length > 0;
  const hasLibrary = showFixed
    ? renderFixedPlans(getFixedPlanLibrary())
    : (renderFixedPlans([]), false);

  const homeActions = document.getElementById("homeActions");
  const homeMenuWrap = document.getElementById("homeMenuWrap");
  if (!hasPlans && !showFixed) {
    if (emptyState) emptyState.classList.remove("hidden");
    if (homeActions) homeActions.classList.remove("hidden");
  } else {
    if (emptyState) emptyState.classList.add("hidden");
    if (homeActions) homeActions.classList.add("hidden");
  }

  const hasAnyForContent =
    (showFixed ? hasLibrary : hasPlans) || dones.length > 0;
  if (contentWrap) contentWrap.classList.toggle("hidden", !hasAnyForContent);
  const showTabs = (showFixed && hasLibrary) || (!showFixed && hasPlans) || dones.length > 0;
  if (tabsWrap) tabsWrap.classList.toggle("hidden", !showTabs);
  if (!hasAnyForContent) {
    if (empty) empty.classList.add("hidden");
    return;
  }

  function isDone(plan) {
    if (!plan) return false;
    const sid = plan.id;
    const sidx = Number(plan.idx);
    const fixedId = plan.fixedPlanId;
    return dones.some((rec) => {
      if (!rec) return false;
      // Match by plan ID
      if (sid && rec.planId && rec.planId === sid) return true;
      // Match by plan index (fallback)
      if (
        (!sid || !rec.planId) &&
        Number.isFinite(sidx) &&
        Number(rec.planIdx) === sidx
      )
        return true;
      // Match by fixed plan reference
      if (fixedId && rec.fixedPlanId && rec.fixedPlanId === fixedId) {
        // For fixed plans, also need to match the date to distinguish different scheduled instances
        if (rec.date === plan.date) return true;
      }
      return false;
    });
  }

  const pendingAll = showFixed ? [] : src.filter((plan) => !isDone(plan));

  const parseDateKey = (input) => {
    const value = String(input || "").trim();
    let match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (match) {
      const DD = match[1].padStart(2, "0");
      const MM = match[2].padStart(2, "0");
      const YYYY = match[3].length === 2 ? "20" + match[3] : match[3];
      return Number(`${YYYY}${MM}${DD}`);
    }
    match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const YYYY = match[1];
      const MM = match[2].padStart(2, "0");
      const DD = match[3].padStart(2, "0");
      return Number(`${YYYY}${MM}${DD}`);
    }
    return NaN;
  };

  const today = new Date();
  const todayKey = Number(
    String(today.getFullYear()) +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0"),
  );
  const isFutureOrToday = (plan) => {
    const key = parseDateKey(plan?.date);
    return Number.isFinite(key) && key >= todayKey;
  };
  const isPast = (plan) => {
    const key = parseDateKey(plan?.date);
    return Number.isFinite(key) && key < todayKey;
  };

  const todoItems = pendingAll.filter(isFutureOrToday);
  const overdueItems = pendingAll.filter(isPast);
  const showPendingLists = !showFixed && hasPlans;

  if (tabFixedBtn)
    tabFixedBtn.classList.toggle("hidden", !(showFixed && hasLibrary));
  if (tabTodoBtn) tabTodoBtn.classList.toggle("hidden", showFixed);
  if (tabOverdueBtn) tabOverdueBtn.classList.toggle("hidden", showFixed);
  if (panelFixed)
    panelFixed.classList.toggle("hidden", !(showFixed && hasLibrary));

  if (panelTodo) panelTodo.classList.toggle("hidden", !showPendingLists);
  if (panelOverdue)
    panelOverdue.classList.toggle("hidden", !showPendingLists);

  if (todayEl) {
    todayEl.innerHTML = "";
    if (showPendingLists) {
      const todayPlan = getTodayPlan(todoItems);
      if (todayPlan) {
        const idx = src.findIndex((plan) =>
          plan?.id && todayPlan?.id
            ? plan.id === todayPlan.id
            : plan === todayPlan,
        );
        todayEl.appendChild(
          makePlanCard(todayPlan, true, idx >= 0 ? idx : 0),
        );
      } else {
        const div = document.createElement("div");
        div.className = "text-slate-400 text-sm";
        div.textContent = "Nenhum plano para hoje.";
        todayEl.appendChild(div);
      }
    }
  }

  if (todoListEl) {
    todoListEl.innerHTML = "";
    if (showPendingLists) {
      todoTotalPages = Math.max(1, Math.ceil(todoItems.length / PAGE_SIZE));
      todoPage = Math.min(Math.max(1, todoPage), todoTotalPages);
      const start = (todoPage - 1) * PAGE_SIZE;
      const pageItems = todoItems.slice(start, start + PAGE_SIZE);
      pageItems.forEach((plan) => {
        const idx = src.findIndex((candidate) =>
          candidate?.id && plan?.id
            ? candidate.id === plan.id
            : candidate === plan,
        );
        todoListEl.appendChild(
          makePlanCard(plan, false, idx >= 0 ? idx : 0),
        );
      });
    }
  }

  if (overdueListEl) {
    overdueListEl.innerHTML = "";
    if (showPendingLists) {
      overdueTotalPages = Math.max(1, Math.ceil(overdueItems.length / PAGE_SIZE));
      overduePage = Math.min(Math.max(1, overduePage), overdueTotalPages);
      const startO = (overduePage - 1) * PAGE_SIZE;
      const pageOverdue = overdueItems.slice(startO, startO + PAGE_SIZE);
      pageOverdue.forEach((plan) => {
        const idx = src.findIndex((candidate) =>
          candidate?.id && plan?.id
            ? candidate.id === plan.id
            : candidate === plan,
        );
        overdueListEl.appendChild(
          makePlanCard(plan, false, idx >= 0 ? idx : 0),
        );
      });
    }
  }


  if (doneList) {
    doneList.innerHTML = "";
    if (!dones.length) {
      const d = document.createElement("div");
      d.className = "text-sm text-slate-400";
      d.textContent = "Nenhuma sessão concluída ainda.";
      doneList.appendChild(d);
    } else {
      doneTotalPages = Math.max(1, Math.ceil(dones.length / PAGE_SIZE));
      donePage = Math.min(Math.max(1, donePage), doneTotalPages);
      const startD = (donePage - 1) * PAGE_SIZE;
      const pageDones = dones.slice(startD, startD + PAGE_SIZE);
      pageDones.forEach((rec, i) =>
        doneList.appendChild(makeDoneCard(rec, startD + i)),
      );
    }
  }

  if (todoPager && todoPagerPrev && todoPagerNext && todoPagerInfo) {
    if (!showPendingLists) todoPager.classList.add("hidden");
    else todoPager.classList.toggle("hidden", todoItems.length <= PAGE_SIZE);
    todoPagerPrev.disabled = !showPendingLists || todoPage <= 1;
    todoPagerNext.disabled =
      !showPendingLists || todoPage >= todoTotalPages;
    todoPagerInfo.textContent = showPendingLists
      ? `Página ${todoPage} de ${todoTotalPages}`
      : "—";
    todoPagerPrev.onclick = () => {
      if (showPendingLists && todoPage > 1) {
        todoPage -= 1;
        renderHome(loadStoredPlans());
      }
    };
    todoPagerNext.onclick = () => {
      if (showPendingLists && todoPage < todoTotalPages) {
        todoPage += 1;
        renderHome(loadStoredPlans());
      }
    };
  }

  if (
    overduePager &&
    overduePagerPrev &&
    overduePagerNext &&
    overduePagerInfo
  ) {
    if (!showPendingLists) overduePager.classList.add("hidden");
    else
      overduePager.classList.toggle(
        "hidden",
        overdueItems.length <= PAGE_SIZE,
      );
    overduePagerPrev.disabled =
      !showPendingLists || overduePage <= 1;
    overduePagerNext.disabled =
      !showPendingLists || overduePage >= overdueTotalPages;
    overduePagerInfo.textContent = showPendingLists
      ? `Página ${overduePage} de ${overdueTotalPages}`
      : "—";
    overduePagerPrev.onclick = () => {
      if (showPendingLists && overduePage > 1) {
        overduePage -= 1;
        renderHome(loadStoredPlans());
      }
    };
    overduePagerNext.onclick = () => {
      if (showPendingLists && overduePage < overdueTotalPages) {
        overduePage += 1;
        renderHome(loadStoredPlans());
      }
    };
  }

  const dp = document.getElementById("donePager");
  const dPrev = document.getElementById("donePagerPrev");
  const dNext = document.getElementById("donePagerNext");
  const dInfo = document.getElementById("donePagerInfo");
  if (dp && dPrev && dNext && dInfo) {
    dp.classList.toggle("hidden", dones.length <= PAGE_SIZE);
    dPrev.disabled = donePage <= 1;
    dNext.disabled = donePage >= doneTotalPages;
    dInfo.textContent = `Página ${donePage} de ${doneTotalPages}`;
    dPrev.onclick = () => {
      if (donePage > 1) {
        donePage -= 1;
        renderHome(loadStoredPlans());
      }
    };
    dNext.onclick = () => {
      if (donePage < doneTotalPages) {
        donePage += 1;
        renderHome(loadStoredPlans());
      }
    };
  }

  function activate(tab) {
    const isFixed = tab === "fixed";
    const isTodo = tab === "todo";
    const isOverdue = tab === "overdue";
    const isDone = tab === "done";
    activeHomeTab = tab;
    if (tabFixedBtn) {
      tabFixedBtn.classList.toggle("bg-slate-700", isFixed);
      tabFixedBtn.classList.toggle("bg-slate-800", !isFixed);
    }
    if (tabTodoBtn) {
      tabTodoBtn.classList.toggle("bg-slate-700", isTodo);
      tabTodoBtn.classList.toggle("bg-slate-800", !isTodo);
    }
    if (tabOverdueBtn) {
      tabOverdueBtn.classList.toggle("bg-slate-700", isOverdue);
      tabOverdueBtn.classList.toggle("bg-slate-800", !isOverdue);
    }
    if (tabDoneBtn) {
      tabDoneBtn.classList.toggle("bg-slate-700", isDone);
      tabDoneBtn.classList.toggle("bg-slate-800", !isDone);
    }
    if (panelFixed) panelFixed.classList.toggle("hidden", !isFixed);
    if (panelTodo) panelTodo.classList.toggle("hidden", !isTodo);
    if (panelOverdue) panelOverdue.classList.toggle("hidden", !isOverdue);
    if (panelDone) panelDone.classList.toggle("hidden", !isDone);
  }

  if (tabFixedBtn) {
    const fixedEnabled = showFixed && hasLibrary;
    tabFixedBtn.disabled = !fixedEnabled;
    tabFixedBtn.classList.toggle("opacity-50", !fixedEnabled);
    tabFixedBtn.classList.toggle("cursor-not-allowed", !fixedEnabled);
    tabFixedBtn.title = fixedEnabled ? "" : "Ative planos fixos nas configurações";
    tabFixedBtn.onclick = () => {
      if (fixedEnabled) activate("fixed");
    };
  }
  if (tabTodoBtn) {
    tabTodoBtn.disabled = !showPendingLists;
    tabTodoBtn.classList.toggle("opacity-50", !showPendingLists);
    tabTodoBtn.classList.toggle("cursor-not-allowed", !showPendingLists);
    tabTodoBtn.title = showPendingLists
      ? ""
      : "Importe uma periodização para ver A fazer";
    tabTodoBtn.onclick = () => {
      if (showPendingLists) activate("todo");
    };
  }
  if (tabOverdueBtn) {
    tabOverdueBtn.disabled = !showPendingLists;
    tabOverdueBtn.classList.toggle("opacity-50", !showPendingLists);
    tabOverdueBtn.classList.toggle("cursor-not-allowed", !showPendingLists);
    tabOverdueBtn.title = showPendingLists
      ? ""
      : "Importe uma periodização para ver Pendente";
    tabOverdueBtn.onclick = () => {
      if (showPendingLists) activate("overdue");
    };
  }
  if (tabDoneBtn) {
    tabDoneBtn.onclick = () => activate("done");
  }

  const availableTabs = {
    fixed: showFixed && hasLibrary,
    todo: showPendingLists,
    overdue: showPendingLists,
    done: dones.length > 0,
  };
  let desiredTab = activeHomeTab;
  if (!availableTabs[desiredTab]) {
    // Default to 'todo' (A fazer) when fixed plans are off
    if (availableTabs.fixed) desiredTab = "fixed";
    else if (availableTabs.todo) desiredTab = "todo";
    else if (availableTabs.overdue) desiredTab = "overdue";
    else if (availableTabs.done) desiredTab = "done";
    else desiredTab = "done";
  }
  activate(desiredTab);
}

let previewIndex = null;

let activeFixedPlan = null;

function openFixedPlanModal(plan) {
  if (!plan) return;
  const modal = document.getElementById("fixedPlanModal");
  const titleEl = document.getElementById("fixedPlanTitle");
  const summaryEl = document.getElementById("fixedPlanSummary");
  const metaEl = document.getElementById("fixedPlanMeta");
  const listEl = document.getElementById("fixedPlanStageList");
  const startBtn = document.getElementById("fixedPlanStartBtn");
  if (!modal || !titleEl || !metaEl || !listEl || !startBtn) {
    prepareFixedPlanFlow(plan.id);
    return;
  }
  activeFixedPlan = plan;
  titleEl.textContent = plan.name || "Plano";
  if (summaryEl) summaryEl.textContent = plan.summary || "";
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const stageTotalSec = sumPlanStageSeconds(plan);
  const sessionTotalSec = computeFixedPlanSessionSeconds(plan);
  metaEl.textContent = `${stages.length} estágios • Sessão ≈ ${fmtMMSS(sessionTotalSec)}`;
  const restCount = Array.isArray(state.restPositions)
    ? new Set(
      state.restPositions
        .map((slot) => normalizeRestSlot(slot))
        .filter((slot) => slot !== null),
    ).size
    : 0;
  const restInterval = clamp(Number(state.restIntervalSec) || 0, 0, 3600);
  const restDetails = document.getElementById("fixedPlanMetaRest");
  if (restDetails) {
    const restLabel = restCount
      ? `${restCount} × ${fmtMMSS(restInterval)}`
      : "Nenhum";
    const perArmSeconds = stageTotalSec * 2 + FLOW_MEASUREMENT_SECONDS;
    restDetails.textContent = `Por braço: ${fmtMMSS(perArmSeconds)} • Descansos: ${restLabel}`;
  }
  listEl.innerHTML = "";
  stages.forEach((stage, index) => {
    const item = document.createElement("li");
    item.className = "rounded-lg border border-white/10 bg-white/5 px-3 py-2";
    const lower = Math.round((Number(stage.lowerPct) || 0) * 100);
    const upper = Math.round((Number(stage.upperPct) || 0) * 100);
    item.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="font-medium">E${index + 1} • ${stage.label || "Estágio"}</div>
        <div class="text-sm text-slate-300">${fmtMMSS(stage.durationSec || 0)}</div>
      </div>
      <div class="text-xs text-slate-400 mt-1">Alvo: ${lower}-${upper}% da força máxima</div>
    `;
    listEl.appendChild(item);
  });
  startBtn.disabled = !plan.id;
  startBtn.setAttribute("data-plan-id", plan.id || "");
  modal.classList.remove("hidden");
  try {
    startBtn.focus();
  } catch { }
}

function closeFixedPlanModal() {
  const modal = document.getElementById("fixedPlanModal");
  if (modal) modal.classList.add("hidden");
  activeFixedPlan = null;
}

function confirmFixedPlanModal() {
  if (!activeFixedPlan || !activeFixedPlan.id) {
    try {
      console.warn('[nav] confirmFixedPlanModal called without active plan; using start button target directly');
    } catch { }
  }
  const planId = activeFixedPlan?.id;
  try {
    console.log('[nav] confirmFixedPlanModal', { planId });
  } catch { }
  closeFixedPlanModal();
  try {
    state.editOrigin = 'home';
    const resolvedId = planId;
    // Queue the plan start if we are not already in flow mode.
    if (state.flowActive) {
      try {
        console.log('[nav] fixed plan start bypassed: flow already active');
      } catch { }
    } else {
      state.pendingIntent = {
        type: 'startFixedPlan',
        planId: resolvedId,
      };
      try {
        console.log('[nav] pendingIntent set (fixed plan)', {
          planId: resolvedId,
        });
      } catch { }
    }
    state.startReturnScreen = 'home';
  } catch { }
  activeFixedPlan = null;
  if (window.showConnectScreen) window.showConnectScreen();
  else showScreen('connect');
  window.updateConnectUi?.();
}

function bindFixedPlanModal() {
  const modal = document.getElementById("fixedPlanModal");
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = "1";
  const closeBtn = document.getElementById("fixedPlanCloseBtn");
  const cancelBtn = document.getElementById("fixedPlanCancelBtn");
  const startBtn = document.getElementById("fixedPlanStartBtn");
  closeBtn?.addEventListener("click", () => closeFixedPlanModal());
  cancelBtn?.addEventListener("click", () => closeFixedPlanModal());
  startBtn?.addEventListener("click", () => confirmFixedPlanModal());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeFixedPlanModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFixedPlanModal();
  });
}

function renderFixedPlans(plans) {
  const wrap = document.getElementById("fixedPlansWrap");
  const list = document.getElementById("fixedPlansList");
  if (!wrap || !list) return false;
  const entries = Array.isArray(plans) ? plans : [];
  const hasEntries = entries.length > 0;
  wrap.classList.toggle("hidden", !hasEntries);
  list.innerHTML = "";
  if (!hasEntries) return false;

  entries.forEach((plan) => {
    if (!plan || !Array.isArray(plan.stages)) return;
    const sessionTotalSec = computeFixedPlanSessionSeconds(plan);
    const lowerValues = plan.stages
      .map((stage) => Number(stage.lowerPct))
      .filter((value) => Number.isFinite(value));
    const upperValues = plan.stages
      .map((stage) => Number(stage.upperPct))
      .filter((value) => Number.isFinite(value));
    const lowerPct = lowerValues.length ? Math.min(...lowerValues) : 0;
    const upperPct = upperValues.length ? Math.max(...upperValues) : 1;
    const card = document.createElement("div");
    card.className =
      "rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4 flex flex-col gap-3";

    const header = document.createElement("div");
    header.className = "flex flex-col gap-2";
    const titleRow = document.createElement("div");
    titleRow.className = "flex items-start justify-between gap-3";
    const title = document.createElement("div");
    title.className = "text-lg font-semibold";
    title.textContent = plan.name || "Plano";
    titleRow.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "text-xs text-slate-400";
    meta.textContent = `Sessão ≈ ${fmtMMSS(sessionTotalSec)}`;
    titleRow.appendChild(meta);
    header.appendChild(titleRow);
    if (plan.summary) {
      const summary = document.createElement("p");
      summary.className = "text-sm text-slate-400";
      summary.textContent = plan.summary;
      header.appendChild(summary);
    }
    const zoneRange = `${Math.round(lowerPct * 100)}-${Math.round(upperPct * 100)}`;
    const zone = document.createElement("div");
    zone.className = "text-xs text-slate-400";
    zone.textContent = `Zona alvo: ${zoneRange}% da força máxima`;
    header.appendChild(zone);
    card.appendChild(header);

    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Abrir ${plan.name || "plano"}`);
    const open = () => openFixedPlanModal(plan);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    list.appendChild(card);
  });

  return true;
}

function makePlanCard(session, isToday = false, index = 0) {
  // Check if this is a fixed plan reference
  const isFixedRef = session.isFixedPlanReference && session.fixedPlanId;
  let displayData = session;
  
  if (isFixedRef) {
    // Resolve the fixed plan from the library for display
    const fixedPlan = getFixedPlanById(session.fixedPlanId);
    if (fixedPlan) {
      displayData = {
        ...session,
        fixedPlanName: fixedPlan.name,
        stages: fixedPlan.stages || [],
        totalDurationSec: sumPlanStageSeconds(fixedPlan),
      };
    }
  }
  
  const card = document.createElement("div");
  card.className =
    "rounded-xl border border-[#2a2a2a] bg-gradient-to-br from-[#101011] to-[#0b0b0c] p-4 flex items-center justify-between gap-3 hover:from-[#121213] hover:to-[#0e0e0f] transition cursor-pointer";
  const info = document.createElement("div");
  const titleRow = document.createElement("div");
  titleRow.className = "flex items-center gap-2";
  const title = document.createElement("div");
  title.className = "font-semibold";
  title.textContent = `${session.date || "—"}`;
  titleRow.appendChild(title);
  if (isToday) {
    const badge = document.createElement("span");
    badge.className =
      "px-2 py-0.5 text-xs rounded-full bg-amber-600/20 text-amber-300 border border-amber-600/30";
    badge.textContent = "Hoje";
    titleRow.appendChild(badge);
  }
  if (isFixedRef && displayData.fixedPlanName) {
    const fixedBadge = document.createElement("span");
    fixedBadge.className =
      "px-2 py-0.5 text-xs rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20";
    fixedBadge.textContent = displayData.fixedPlanName;
    titleRow.appendChild(fixedBadge);
  }
  const sub = document.createElement("div");
  sub.className = "text-slate-300 text-sm";
  sub.textContent = `${session.athlete || "—"} • ${displayData.stages.length} estágios • ${fmtMMSS(displayData.totalDurationSec || 0)}`;
  info.appendChild(titleRow);
  info.appendChild(sub);
  card.appendChild(info);
  card.addEventListener("click", () => openPreview(index));
  return card;
}

function makeDoneCard(rec, index = 0) {
  const card = document.createElement("div");
  card.className =
    "rounded-xl border border-white/10 bg-gradient-to-br from-white/5 to-white/10 p-4 flex items-center justify-between gap-3 hover:from-white/10 hover:to-white/20 transition cursor-pointer";
  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "font-semibold";
  title.textContent = rec.title || rec.date || "—";
  const sub = document.createElement("div");
  sub.className = "text-slate-400 text-sm";
  const parts = [];
  const seriesCount = Array.isArray(rec.steps) ? rec.steps.length : 0;
  if (seriesCount > 0)
    parts.push(`${seriesCount} ${seriesCount === 1 ? "série" : "séries"}`);
  parts.push(`${rec.stagesCount} estágios`);
  parts.push(`${fmtMMSS(rec.totalDurationSec)}`);
  // Append completion time if available
  try {
    if (rec?.completedAt) {
      const d = new Date(rec.completedAt);
      if (!isNaN(d.getTime())) {
        const full = d.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        parts.push(`Finalizada ${full}`);
      }
    } else if (rec?.date) {
      parts.push(`Finalizada ${rec.date}`);
    }
  } catch { }
  sub.textContent = parts.join(" • ");
  info.appendChild(title);
  info.appendChild(sub);
  card.appendChild(info);
  // Open modal with actions when clicking the card
  card.addEventListener("click", () => openDonePreview(index));
  return card;
}

function openPreview(index) {
  previewIndex = index;
  const plans = loadStoredPlans();
  const s = plans[index];
  const modal = document.getElementById("sessionPreviewModal");
  const body = document.getElementById("sessionPreviewBody");
  const startBtn = document.getElementById("sessionPreviewStart");
  const editBtn = document.getElementById("sessionPreviewEdit");
  // Top bar controls
  const viewBtnTop = document.getElementById("sessionPreviewView");
  const dlBtnTop = document.getElementById("sessionPreviewDownload");
  const renBtnTop = document.getElementById("sessionPreviewRename");
  const delBtnTop = document.getElementById("sessionPreviewDelete");
  // Bottom bar controls
  const viewBtnBottom = document.getElementById("sessionPreviewViewBottom");
  const dlBtnBottom = document.getElementById("sessionPreviewDownloadBottom");
  const renBtnBottom = document.getElementById("sessionPreviewRenameBottom");
  const delBtnBottom = document.getElementById("sessionPreviewDeleteBottom");
  if (!modal || !body || !s) return;
  
  // Check if this is a fixed plan reference
  const isFixedRef = s.isFixedPlanReference && s.fixedPlanId;
  let displayData = s;
  
  if (isFixedRef) {
    // Resolve the fixed plan from the library
    const fixedPlan = getFixedPlanById(s.fixedPlanId);
    if (fixedPlan) {
      // Create display data combining reference info with library data
      displayData = {
        ...s,
        fixedPlanName: fixedPlan.name,
        fixedPlanSummary: fixedPlan.summary,
        stages: fixedPlan.stages || [],
        totalDurationSec: sumPlanStageSeconds(fixedPlan),
      };
    }
  }
  
  body.innerHTML = "";
  
  // Use fixed plan modal style layout
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-4";
  
  // Header section
  const header = document.createElement("div");
  header.className = "flex items-start justify-between gap-3";
  
  const headerContent = document.createElement("div");
  const h = document.createElement("h3");
  h.className = "text-xl font-semibold";
  h.textContent = s.date || "Sessão";
  headerContent.appendChild(h);
  
  // Show fixed plan name as subtitle if it's a reference
  if (isFixedRef && displayData.fixedPlanName) {
    const subtitle = document.createElement("p");
    subtitle.className = "mt-1 text-sm text-slate-200";
    subtitle.textContent = displayData.fixedPlanName;
    headerContent.appendChild(subtitle);
  } else if (s.athlete) {
    const subtitle = document.createElement("p");
    subtitle.className = "mt-1 text-sm text-slate-200";
    subtitle.textContent = s.athlete;
    headerContent.appendChild(subtitle);
  }
  
  header.appendChild(headerContent);
  wrap.appendChild(header);
  
  // Meta information
  const stages = displayData.stages || [];
  const meta = document.createElement("div");
  meta.className = "text-sm text-slate-300";
  
  if (isFixedRef) {
    // For fixed plan references, show the full flow session details
    const stageTotalSec = displayData.totalDurationSec || 0;
    const sessionTotalSec = computeFixedPlanSessionSeconds({ stages });
    meta.textContent = `${stages.length} estágios • Sessão ≈ ${fmtMMSS(sessionTotalSec)}`;
    
    // Add rest details
    const restCount = Array.isArray(state.restPositions)
      ? new Set(
          state.restPositions
            .map((slot) => normalizeRestSlot(slot))
            .filter((slot) => slot !== null),
        ).size
      : 0;
    const restInterval = clamp(Number(state.restIntervalSec) || 0, 0, 3600);
    const restDetails = document.createElement("div");
    restDetails.className = "text-xs text-slate-500";
    const restLabel = restCount
      ? `${restCount} × ${fmtMMSS(restInterval)}`
      : "Nenhum";
    const perArmSeconds = stageTotalSec * 2 + FLOW_MEASUREMENT_SECONDS;
    restDetails.textContent = `Por braço: ${fmtMMSS(perArmSeconds)} • Descansos: ${restLabel}`;
  wrap.appendChild(meta);
    wrap.appendChild(restDetails);
  } else {
    // For regular sessions, show simpler meta
    meta.textContent = `${stages.length} estágios • ${fmtMMSS(displayData.totalDurationSec || 0)}`;
    wrap.appendChild(meta);
  }
  
  // Stage list
  const list = document.createElement("ul");
  list.className = "space-y-2 max-h-64 overflow-auto";
  
  stages.forEach((st, index) => {
    const item = document.createElement("li");
    item.className = "rounded-lg border border-[#2a2a2a] bg-[#101011] px-3 py-2";
    
    const topRow = document.createElement("div");
    topRow.className = "flex items-center justify-between gap-2";
    
    const stageLabel = document.createElement("div");
    stageLabel.className = "font-medium";
    stageLabel.textContent = `E${st.index || index + 1} • ${st.label || "Estágio"}`;
    
    const stageDuration = document.createElement("div");
    stageDuration.className = "text-sm text-slate-300";
    stageDuration.textContent = fmtMMSS(st.durationSec || 0);
    
    topRow.appendChild(stageLabel);
    topRow.appendChild(stageDuration);
    item.appendChild(topRow);
    
    // Range details
    const rangeDiv = document.createElement("div");
    rangeDiv.className = "text-xs text-slate-400 mt-1";
    
    if (isFixedRef && st.lowerPct != null && st.upperPct != null) {
      // Show percentages for fixed plan references
      const lower = Math.round((Number(st.lowerPct) || 0) * 100);
      const upper = Math.round((Number(st.upperPct) || 0) * 100);
      rangeDiv.textContent = `Alvo: ${lower}-${upper}% da força máxima`;
    } else if (st.lower != null && st.upper != null) {
      // Show absolute values for regular sessions
      rangeDiv.textContent = `Alvo: ${st.lower}-${st.upper} kgf`;
    }
    
    item.appendChild(rangeDiv);
    list.appendChild(item);
  });
  
  wrap.appendChild(list);
  body.appendChild(wrap);
  
  // Configure buttons based on session type
  if (startBtn) {
    startBtn.classList.remove("hidden");
    if (isFixedRef) {
      startBtn.textContent = "Iniciar fluxo";
    } else {
      startBtn.textContent = "Iniciar sessão";
    }
  }
  
  if (editBtn) {
    if (isFixedRef) {
      // Fixed plan references can't be edited
      editBtn.classList.add("hidden");
    } else {
    editBtn.classList.remove("hidden");
    editBtn.onclick = () => {
      try {
        closePreview();
        loadPlanForEdit(s, "home");
        showScreen("editPlan");
      } catch { }
    };
  }
  }
  
  modal.classList.remove("hidden");
}

function closePreview() {
  const modal = document.getElementById("sessionPreviewModal");
  if (modal) modal.classList.add("hidden");
  previewIndex = null;
}

function confirmPreview() {
  const idx = previewIndex;
  try {
    console.log('[nav] confirmPreview', { index: idx });
  } catch { }
  closePreview();
  if (typeof idx !== "number") return;
  const plans = loadStoredPlans();
  const s = plans[idx];
  if (!s) return;
  
  // Check if this is a fixed plan reference
  const isFixedRef = s.isFixedPlanReference && s.fixedPlanId;
  
  if (isFixedRef) {
    // Use the fixed plan flow instead of regular session
    try {
      state.editOrigin = 'home';
      state.pendingIntent = {
        type: 'startFixedPlan',
        planId: s.fixedPlanId,
        sourceSession: {  // Preserve original session reference
          id: s.id,
          idx: s.idx,
          date: s.date,
          athlete: s.athlete,
          fixedPlanId: s.fixedPlanId,
          isFixedPlanReference: s.isFixedPlanReference,
        },
      };
      state.startReturnScreen = 'home';
      try {
        console.log('[nav] pendingIntent set (fixed plan reference)', {
          planId: s.fixedPlanId,
        });
      } catch { }
      if (window.showConnectScreen) window.showConnectScreen();
      else showScreen('connect');
      window.updateConnectUi?.();
    } catch (err) {
      console.error('Error starting fixed plan reference:', err);
      alert('Erro ao iniciar plano fixo: ' + (err?.message || String(err)));
    }
    return;
  }
  
  // Direct start flow: editing is optional via the Edit button
  try {
    const sessionCopy = JSON.parse(JSON.stringify(s));
    if (sessionCopy.id && !sessionCopy.planId)
      sessionCopy.planId = sessionCopy.id;
    if (
      Number.isFinite(Number(sessionCopy.idx)) &&
      !Number.isFinite(Number(sessionCopy.planIdx))
    )
      sessionCopy.planIdx = Number(sessionCopy.idx);
    state.editOrigin = "home";
    state.pendingIntent = { type: "startEdited", session: sessionCopy };
    state.startReturnScreen = "home";
    try {
      console.log('[nav] pendingIntent set (home preview)', {
        type: 'startEdited',
        origin: 'home',
      });
    } catch { }
    if (window.showConnectScreen) window.showConnectScreen();
    else showScreen('connect');
    window.updateConnectUi?.();
  } catch {
    // Fallback: open editor
    loadPlanForEdit(s, "home");
    showScreen("editPlan");
  }
}

function openDonePreview(index) {
  const plans = loadDoneSessions();
  const rec = plans[index];
  const modal = document.getElementById("sessionPreviewModal");
  const body = document.getElementById("sessionPreviewBody");
  const startBtn = document.getElementById("sessionPreviewStart");
  const editBtn = document.getElementById("sessionPreviewEdit");
  const viewBtnBottom = document.getElementById("sessionPreviewViewBottom");
  const dlBtnBottom = document.getElementById("sessionPreviewDownloadBottom");
  if (!modal || !body || !rec) return;
  
  body.innerHTML = "";
  
  // Use fixed plan modal style layout
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-4";
  
  // Header section
  const header = document.createElement("div");
  header.className = "flex items-start justify-between gap-3";
  
  const headerContent = document.createElement("div");
  const h = document.createElement("h3");
  h.className = "text-xl font-semibold";
  h.textContent = rec.title || rec.date || "Sessão Concluída";
  headerContent.appendChild(h);
  
  if (rec.date && rec.title !== rec.date) {
    const subtitle = document.createElement("p");
    subtitle.className = "mt-1 text-sm text-slate-200";
    subtitle.textContent = rec.date;
    headerContent.appendChild(subtitle);
  }
  
  header.appendChild(headerContent);
  wrap.appendChild(header);
  
  // Meta information
  const meta = document.createElement("div");
  meta.className = "text-sm text-slate-300";
  meta.textContent = `${rec.stagesCount} estágios • ${fmtMMSS(rec.totalDurationSec)}`;
  wrap.appendChild(meta);
  
  // Stats
  const stats = document.createElement("div");
  stats.className = "grid grid-cols-2 gap-2 text-sm";
  const mk = (label, val) => {
    const d = document.createElement("div");
    d.className = "rounded-lg border border-[#2a2a2a] bg-[#101011] p-2";
    d.innerHTML = `<div class="text-slate-400 text-xs">${label}</div><div class="font-semibold">${val}</div>`;
    return d;
  };
  stats.appendChild(mk("Força média", `${(rec?.stats?.avg ?? 0).toFixed(1)} kgf`));
  stats.appendChild(mk("Força máx", `${(rec?.stats?.max ?? 0).toFixed(1)} kgf`));
  stats.appendChild(mk("Força mín", `${(rec?.stats?.min ?? 0).toFixed(1)} kgf`));
  stats.appendChild(mk("No alvo", `${(rec?.stats?.inTargetPct ?? 0).toFixed(1)}%`));
  wrap.appendChild(stats);
  if (Array.isArray(rec.steps) && rec.steps.length > 1) {
    const stepsWrap = document.createElement("div");
    stepsWrap.className = "space-y-2";
    const stepsTitle = document.createElement("div");
    stepsTitle.className = "text-xs font-semibold uppercase tracking-wide text-slate-300";
    stepsTitle.textContent = "Séries";
    const list = document.createElement("ul");
    list.className = "space-y-1 max-h-32 overflow-auto";
    rec.steps.forEach((step, idx) => {
      const li = document.createElement("li");
      li.className =
        "flex items-center justify-between gap-2 rounded-lg border border-[#2a2a2a] bg-[#101011] px-3 py-2";
      const label = document.createElement("span");
      label.className = "font-medium text-sm";
      label.textContent = step?.title || `Série ${idx + 1}`;
      const details = document.createElement("span");
      details.className = "text-xs text-slate-300";
      const stageCount = Number(step?.stageCount) ||
        (Array.isArray(step?.stages) ? step.stages.length : 0);
      const duration = Number(step?.totalDurationSec) || 0;
      details.textContent = `${stageCount} estágios • ${fmtMMSS(duration)}`;
      li.appendChild(label);
      li.appendChild(details);
      list.appendChild(li);
    });
    stepsWrap.appendChild(stepsTitle);
    stepsWrap.appendChild(list);
    wrap.appendChild(stepsWrap);
  }
  
  body.appendChild(wrap);
  
  // Configure buttons for done sessions
  if (startBtn) startBtn.classList.add("hidden");
  if (editBtn) editBtn.classList.add("hidden");
  
  // View button - shows the CSV playback
  const canView = !!rec.csv;
  if (viewBtnBottom) {
    viewBtnBottom.classList.toggle("hidden", !canView);
    viewBtnBottom.textContent = "Visualizar";
    viewBtnBottom.onclick = () => {
      try {
        if (rec.csv) {
          closePreview();
          loadCompletedSessionFromExportCsv(rec.csv, rec.steps);
        }
      } catch { }
    };
  }
  
  // Download button
  if (dlBtnBottom) {
    dlBtnBottom.classList.toggle("hidden", !rec.csv || rec.isImported);
    dlBtnBottom.textContent = "Baixar CSV";
    dlBtnBottom.onclick = () => {
      try {
        const blob = new Blob([rec.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateSlug = String(rec.date || "").replace(/\s+/g, "_");
        a.href = url;
        a.download = `isotrainer_${dateSlug || "session"}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch { }
    };
  }
  
  modal.classList.remove("hidden");
}

// Rename a completed session record
function renameDone(index) {
  /* replaced by inline rename */
}

// Delete a completed session record
function deleteDone(index) {
  const arr = loadDoneSessions();
  const rec = arr[index];
  if (!rec) return;
  const ok = confirm("Tem certeza que deseja excluir esta sessão?");
  if (!ok) return;
  arr.splice(index, 1);
  saveDoneSessions(arr);
  try {
    renderHome(loadStoredPlans());
  } catch { }
  try {
    closePreview();
  } catch { }
  // Ensure Done tab remains active
  setTimeout(() => {
    try {
      document.getElementById("tabDone")?.click();
    } catch { }
  }, 0);
}

function onLoadPlan(idx) {
  const plans = loadStoredPlans();
  const s = plans[idx];
  if (!s) return;
  loadPlanForEdit(s, "home");
  showScreen("editPlan");
}
function onStartPlan(idx) {
  onLoadPlan(idx);
}

export function bindHomeNav() {
  document.getElementById("homeManualBtn")?.addEventListener("click", () => {
    showScreen("plan");
  });
  const importPlansBtn = document.getElementById("importPlansBtn");
  const importPlansInput = document.getElementById("importPlansInput");
  importPlansBtn?.addEventListener("click", () => importPlansInput?.click());
  document
    .getElementById("menuImportPlan")
    ?.addEventListener("click", () => importPlansInput?.click());
  document.getElementById("menuPlanGenerator")?.addEventListener("click", () => {
    window.location.href = "/plan-generator.html";
  });
  const profileImportBtn = document.getElementById("profileSelectImport");
  const profileContinueBtn = document.getElementById("profileSelectContinue");
  const profileCloseBtn = document.getElementById("profileSelectClose");
  const profileSearchBtn = document.getElementById("profileSelectSearchBtn");
  const profileSearchInput = document.getElementById("profileSelectSearchInput");
  const switchProfileBtn = document.getElementById("homeSwitchProfileBtn");
  
  const onDecoded = async (decoded, meta = {}) => {
    const sessions = parsePeriodizationCsv(decoded);
    const fallbackName = inferProfileName(sessions, "");
    const preferredName = await promptProfileName(
      fallbackName,
      String(meta.fileName || "").trim(),
    );
    if (!preferredName) return;
    const profiles = getPlanProfiles();
    const existing = profiles.find((p) =>
      String(p?.name || "").toLowerCase() === preferredName.toLowerCase(),
    );
    savePlans(sessions, {
      profileId: existing?.id,
      profileName: preferredName,
    });
    // Turn off fixed plans after import
    persistFixedPlanPreference(false);
    // Update toggle UI
    try {
      const toggle = document.getElementById("fixedPlanToggle");
      if (toggle) toggle.checked = false;
    } catch { }
    const updated = loadStoredPlans();
    renderHome(updated);
    const successMsg = existing
      ? "Periodização atualizada com sucesso."
      : "Planos importados com sucesso.";
    alert(successMsg);
    // Switch to hamburger after first import
    try {
      document.getElementById("homeActions")?.classList.add("hidden");
      document.getElementById("homeMenuWrap")?.classList.remove("hidden");
    } catch { }
  };
  
  const triggerImport = () => importPlansInput?.click();
  importPlansBtn?.addEventListener("click", triggerImport);
  profileImportBtn?.addEventListener("click", triggerImport);
  switchProfileBtn?.addEventListener("click", () => openProfileSelectionScreen());
  profileContinueBtn?.addEventListener("click", () => confirmProfileSelection());
  profileCloseBtn?.addEventListener("click", () => cancelProfileSelection());
  profileSearchBtn?.addEventListener("click", () => {
    if (profileSearchExpanded) collapseProfileSearch({ clearTerm: true });
    else expandProfileSearch();
  });
  profileSearchInput?.addEventListener("input", (e) => {
    setProfileSearchTermRaw(e.target.value);
  });
  profileSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      collapseProfileSearch({ clearTerm: true });
    }
  });
  
  importPlansInput?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fileName = f.name || "";
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const decoded = tryDecodeContent(String(reader.result || ""));
        await onDecoded(decoded, { fileName });
      } catch (err) {
        alert("Falha ao importar planos: " + (err?.message || String(err)));
      } finally {
        importPlansInput.value = "";
      }
    };
    reader.onerror = () => {
      alert("Não foi possível ler o arquivo.");
      importPlansInput.value = "";
    };
    reader.readAsText(f);
  });
  try {
    hydrateFixedPlanPreference();
  } catch { }
  try {
    hydrateRestSettingsFromStorage();
  } catch { }
  try {
    initFixedPlanToggle();
  } catch { }
  try {
    initRestSettingsUI();
  } catch { }
  try {
    bindFixedPlanModal();
  } catch { }
  try {
    renderHome(loadStoredPlans());
  } catch { }

  // Preview modal wiring. Close via X or backdrop.
  document
    .getElementById("sessionPreviewClose")
    ?.addEventListener("click", closePreview);
  document
    .getElementById("sessionPreviewStart")
    ?.addEventListener("click", confirmPreview);
  const modal = document.getElementById("sessionPreviewModal");
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closePreview();
  });
  // Empty state drag & drop zone wiring.
  const dropzone = document.getElementById("homeEmptyDropzone");
  if (dropzone) {
    const highlight = (on) => {
      dropzone.classList.toggle("ring-2", on);
      dropzone.classList.toggle("ring-purple-600/60", on);
    };
    dropzone.addEventListener("click", () => importPlansInput?.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        importPlansInput?.click();
      }
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      highlight(true);
    });
    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      highlight(false);
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      highlight(false);
      const files = e.dataTransfer?.files;
      const f = files && files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const decoded = tryDecodeContent(String(reader.result || ""));
          const sessions = parsePeriodizationCsv(decoded);
          savePlans(sessions);
          // Turn off fixed plans after import
          persistFixedPlanPreference(false);
          // Update toggle UI
          try {
            const toggle = document.getElementById("fixedPlanToggle");
            if (toggle) toggle.checked = false;
          } catch { }
          renderHome(sessions);
          alert("Planos importados com sucesso.");
        } catch (err) {
          alert("Falha ao importar: " + (err?.message || String(err)));
        }
      };
      reader.onerror = () => alert("Não foi possível ler o arquivo.");
      reader.readAsText(f);
    });
  }
  // Update Home when sessions complete.
  window.addEventListener("sessions:updated", () => {
    try {
      renderHome(loadStoredPlans());
    } catch { }
  });
  window.addEventListener("plans:updated", () => {
    try {
      updateActiveProfileBadge();
      renderProfileSelection();
    } catch {}
  });
  // Hamburger menu visibility and actions.
  const actions = document.getElementById("homeActions");
  const menuWrap = document.getElementById("homeMenuWrap");
  const menuBtn = document.getElementById("homeMenuBtn");
  const menu = document.getElementById("homeMenu");
  const importSessionBtn = document.getElementById("homeImportSessionBtn");
  function refreshMenuVisibility() {
    const hasPlans = loadStoredPlans().length > 0;
    if (actions) actions.classList.toggle("hidden", hasPlans);
    if (menuWrap) menuWrap.classList.toggle("hidden", !hasPlans);
  }
  refreshMenuVisibility();
  menuBtn?.addEventListener("click", () => {
    if (!menu) return;
    const hidden = menu.classList.toggle("hidden");
    menuBtn?.setAttribute("aria-expanded", hidden ? "false" : "true");
  });
  document.addEventListener("click", (e) => {
    if (!menu || !menuBtn) return;
    if (menu.contains(e.target) || menuBtn.contains(e.target)) return;
    menu.classList.add("hidden");
    menuBtn?.setAttribute("aria-expanded", "false");
  });
  document.getElementById("menuManual")?.addEventListener("click", () => {
    showScreen("plan");
    menu?.classList.add("hidden");
  });
  document
    .getElementById("menuImportSession")
    ?.addEventListener("click", () => {
      document.getElementById("homeImportSessionInput")?.click();
      menu?.classList.add("hidden");
    });
  document.getElementById("menuSettings")?.addEventListener("click", () => {
    try {
      openSettings();
    } finally {
      menu?.classList.add("hidden");
    }
  });
  document.getElementById("menuExportAll")?.addEventListener("click", () => {
    try {
      exportAllDoneCsv();
    } finally {
      menu?.classList.add("hidden");
    }
  });
  document.getElementById("menuResetApp")?.addEventListener("click", () => {
    try {
      resetApplication();
    } finally {
      menu?.classList.add("hidden");
    }
  });
}

// Build a single CSV aggregating all saved sessions (same columns as per-exported format)
function exportAllDoneCsv() {
  const dones = loadDoneSessions();
  if (!dones || !dones.length) {
    alert("Nenhuma sessão concluída disponível para exportar.");
    return;
  }
  // Header with units in column names
  const HEADER =
    "type;date;client;stage;duration_sec;lower_kgf;upper_kgf;avg_kgf;min_kgf;max_kgf;in_target_pct;samples;elapsed_sec;stage_elapsed_sec;force_kgf;in_target";
  const parts = [HEADER];
  for (const rec of dones) {
    const csv = String(rec?.csv || "").trim();
    if (!csv) continue; // skip records without CSV
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    // skip per-session header (line 0)
    for (let i = 1; i < lines.length; i++) parts.push(lines[i]);
  }
  if (parts.length <= 1) {
    alert("Nenhuma sessão com dados de CSV para exportar.");
    return;
  }
  const out = parts.join("\n");
  const blob = new Blob([out], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateSlug = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `isotrainer_all_sessions_${dateSlug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetApplication() {
  const ok = confirm(
    "Isso irá apagar periodizações e sessões salvas deste aplicativo neste dispositivo. Deseja continuar?",
  );
  if (!ok) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_DONE_KEY);
  } catch { }
  try {
    location.reload();
  } catch { }
}

// ============= Rest Settings & Flow Preferences ============= //

function loadRestIntervalFromStorage() {
  try {
    const raw = Number(localStorage.getItem(REST_INTERVAL_KEY));
    if (Number.isFinite(raw)) return clamp(Math.round(raw), 10, 600);
  } catch { }
  return 120;
}

function loadFlowStepOrderFromStorage() {
  try {
    const raw = localStorage.getItem(FLOW_STEP_ORDER_KEY);
    if (!raw) return DEFAULT_FLOW_STEP_ORDER.slice();
    const arr = JSON.parse(raw);
    return sanitizeFlowStepOrder(arr);
  } catch { }
  return DEFAULT_FLOW_STEP_ORDER.slice();
}

function mapLegacyRestSlot(value) {
  const legacy = Number(value);
  if (!Number.isFinite(legacy)) return null;
  if (legacy === 2) return 1;
  if (legacy === 4) return 2;
  if (legacy === 6) return 3;
  return null;
}

function normalizeRestSlot(value) {
  const slot = Number(value);
  if (!Number.isFinite(slot)) return null;
  const normalized = Math.trunc(slot);
  return FLOW_REST_SLOTS.includes(normalized) ? normalized : null;
}

function loadRestPositionsFromStorage() {
  try {
    const raw = localStorage.getItem(REST_POSITIONS_KEY);
    if (raw === null) return DEFAULT_REST_POSITIONS.slice();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_REST_POSITIONS.slice();
    const seen = new Set();
    const slots = [];
    for (const entry of arr) {
      let slot = normalizeRestSlot(entry);
      if (slot === null) slot = mapLegacyRestSlot(entry);
      if (slot === null || seen.has(slot)) continue;
      seen.add(slot);
      slots.push(slot);
    }
    if (slots.length) return slots;
    if (arr.length === 0) return [];
  } catch { }
  return DEFAULT_REST_POSITIONS.slice();
}

function loadRestSkipFromStorage() {
  try {
    return localStorage.getItem(REST_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function hydrateRestSettingsFromStorage() {
  state.restIntervalSec = loadRestIntervalFromStorage();
  state.flowStepOrder = sanitizeFlowStepOrder(loadFlowStepOrderFromStorage());
  state.restPositions = loadRestPositionsFromStorage();
  state.restSkipEnabled = loadRestSkipFromStorage();
}

function loadFixedPlanPreference() {
  try {
    const raw = localStorage.getItem(FIXED_PLAN_PREF_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch { }
  return true;
}

function persistFixedPlanPreference(on) {
  state.showFixedPlans = !!on;
  try {
    localStorage.setItem(FIXED_PLAN_PREF_KEY, state.showFixedPlans ? "1" : "0");
  } catch { }
}

export function hydrateFixedPlanPreference() {
  state.showFixedPlans = loadFixedPlanPreference();
}

function persistRestInterval(value) {
  state.restIntervalSec = clamp(Math.round(value), 10, 600);
  try {
    localStorage.setItem(REST_INTERVAL_KEY, String(state.restIntervalSec));
  } catch { }
}

function persistFlowStepOrder(order) {
  const sanitized = sanitizeFlowStepOrder(order);
  state.flowStepOrder = sanitized;
  try {
    localStorage.setItem(FLOW_STEP_ORDER_KEY, JSON.stringify(sanitized));
  } catch { }
}

function persistRestPositions(list) {
  const seen = new Set();
  const next = [];
  if (Array.isArray(list)) {
    list.forEach((entry) => {
      let slot = normalizeRestSlot(entry);
      if (slot === null) slot = mapLegacyRestSlot(entry);
      if (slot === null || seen.has(slot)) return;
      seen.add(slot);
      next.push(slot);
    });
  }
  next.sort((a, b) => a - b);
  state.restPositions = next;
  try {
    localStorage.setItem(REST_POSITIONS_KEY, JSON.stringify(state.restPositions));
  } catch { }
}

function persistRestSkip(flag) {
  state.restSkipEnabled = !!flag;
  try {
    localStorage.setItem(REST_SKIP_KEY, state.restSkipEnabled ? "1" : "0");
  } catch { }
}

function applyRestSkipPreference() {
  const skipBtn = document.getElementById("restSkipBtn");
  if (!skipBtn) return;
  skipBtn.classList.toggle("hidden", !state.restSkipEnabled);
  skipBtn.disabled = !state.restSkipEnabled;
}

function renderRestPositionsSettings() {
  const list = document.getElementById("restPositionsList");
  const addBtn = document.getElementById("restAddBtn");
  if (!list) return;
  list.innerHTML = "";
  const stepOrder = sanitizeFlowStepOrder(state.flowStepOrder);
  state.flowStepOrder = stepOrder;
  const activeRest = Array.isArray(state.restPositions)
    ? state.restPositions
      .map((slot) => normalizeRestSlot(slot))
      .filter((slot) => slot !== null)
    : [];
  const restSet = new Set(activeRest);

  stepOrder.forEach((stepId, index) => {
    const step = getFlowTrainingStepById(stepId);
    if (!step) return;
    const item = document.createElement("li");
    item.className =
      "rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm";
    const subtitle = step.captureMax
      ? "Inclui medição de força máxima antes da série."
      : "Usa a última medição registrada para esta série.";
    item.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-400">Passo ${index + 1}</div>
          <div class="font-medium text-slate-200">${step.label}</div>
          <div class="text-xs text-slate-400 mt-1">${subtitle}</div>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" data-act="stepUp" data-step-id="${step.id}" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900/60" ${index > 0 ? "" : "disabled"} aria-label="Mover passo para cima">
            &uarr;
          </button>
          <button type="button" data-act="stepDown" data-step-id="${step.id}" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900/60" ${index < stepOrder.length - 1 ? "" : "disabled"} aria-label="Mover passo para baixo">
            &darr;
          </button>
        </div>
      </div>
    `;
    list.appendChild(item);

    if (index >= stepOrder.length - 1) return;

    const slotId = index + 1;
    const hasRest = restSet.has(slotId);
    const restItem = document.createElement("li");
    restItem.className =
      "flex items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm";
    const buttonClass = hasRest
      ? "bg-amber-500 text-black hover:bg-amber-400/80"
      : "bg-slate-800 text-slate-200 hover:bg-slate-700";
    restItem.innerHTML = `
      <div>
        <div class="font-medium text-amber-200">Descanso após este passo</div>
        <div class="text-xs text-amber-200/80">${hasRest
        ? "Será exibida a contagem regressiva antes do próximo passo."
        : "Ative para inserir um descanso aqui."
      }</div>
      </div>
      <button type="button" data-act="toggleRest" data-slot="${slotId}" class="px-3 py-1 rounded-lg ${buttonClass}">
        ${hasRest ? "Remover" : "Adicionar"}
      </button>
    `;
    list.appendChild(restItem);
  });

  if (addBtn) {
    const maxSlot = Math.max(0, stepOrder.length - 1);
    const disabled = FLOW_REST_SLOTS.every(
      (slot) => slot > maxSlot || restSet.has(slot),
    );
    addBtn.disabled = disabled;
    addBtn.classList.toggle("opacity-40", disabled);
    addBtn.classList.toggle("cursor-not-allowed", disabled);
    addBtn.textContent = disabled
      ? "Todos os descansos foram adicionados"
      : "Adicionar próximo descanso disponível";
  }
  applyRestSkipPreference();
}

export function initRestSettingsUI() {
  const intervalInput = document.getElementById("restIntervalInput");
  if (intervalInput) {
    intervalInput.value = String(state.restIntervalSec);
    intervalInput.onchange = () => {
      const next = clamp(Math.round(Number(intervalInput.value) || 0), 10, 600);
      persistRestInterval(next);
      intervalInput.value = String(state.restIntervalSec);
      renderHome(loadStoredPlans());
    };
  }

  const skipToggle = document.getElementById("restSkipToggle");
  if (skipToggle) {
    skipToggle.checked = !!state.restSkipEnabled;
    skipToggle.onchange = () => {
      persistRestSkip(!!skipToggle.checked);
      applyRestSkipPreference();
    };
  }

  const list = document.getElementById("restPositionsList");
  if (list && !list.dataset.bound) {
    list.dataset.bound = "1";
    list.addEventListener("click", (event) => {
      const stepBtn = event.target.closest("button[data-act][data-step-id]");
      if (stepBtn) {
        event.preventDefault();
        const { act } = stepBtn.dataset;
        const stepId = stepBtn.dataset.stepId;
        if (!stepId || (act !== "stepUp" && act !== "stepDown")) return;
        const order = sanitizeFlowStepOrder(state.flowStepOrder);
        const idx = order.indexOf(stepId);
        if (idx === -1) return;
        const direction = act === "stepUp" ? -1 : 1;
        const target = idx + direction;
        if (target < 0 || target >= order.length) return;
        const swapped = order.slice();
        const tmp = swapped[target];
        swapped[target] = swapped[idx];
        swapped[idx] = tmp;
        persistFlowStepOrder(swapped);
        renderRestPositionsSettings();
        renderHome(loadStoredPlans());
        return;
      }

      const restBtn = event.target.closest("button[data-act][data-slot]");
      if (!restBtn) return;
      event.preventDefault();
      if (restBtn.dataset.act !== "toggleRest") return;
      const slot = normalizeRestSlot(restBtn.dataset.slot);
      if (slot === null) return;
      const current = Array.isArray(state.restPositions)
        ? state.restPositions.slice()
        : [];
      const set = new Set(
        current
          .map((value) => normalizeRestSlot(value))
          .filter((value) => value !== null),
      );
      if (set.has(slot)) set.delete(slot);
      else set.add(slot);
      persistRestPositions(Array.from(set));
      renderRestPositionsSettings();
      renderHome(loadStoredPlans());
    });
  }

  const addBtn = document.getElementById("restAddBtn");
  if (addBtn) {
    addBtn.onclick = (event) => {
      event.preventDefault();
      const order = sanitizeFlowStepOrder(state.flowStepOrder);
      state.flowStepOrder = order;
      const restSet = new Set(
        state.restPositions
          .map((value) => normalizeRestSlot(value))
          .filter((value) => value !== null),
      );
      const maxSlot = Math.max(0, order.length - 1);
      const available = FLOW_REST_SLOTS.filter(
        (slot) => slot <= maxSlot && !restSet.has(slot),
      );
      if (!available.length) return;
      restSet.add(available[0]);
      persistRestPositions(Array.from(restSet));
      renderRestPositionsSettings();
      renderHome(loadStoredPlans());
    };
  }

  renderRestPositionsSettings();
}

function initFixedPlanToggle() {
  const toggle = document.getElementById("fixedPlanToggle");
  if (!toggle) return;
  toggle.checked = !!state.showFixedPlans;
  toggle.onchange = () => {
    persistFixedPlanPreference(!!toggle.checked);
    renderHome(loadStoredPlans());
  };
}

// ============= Settings (Contrast Mode & Colors) ============= //
const CONTRAST_KEY = "isotrainer:ui:contrast";
const LEGACY_COLORS_KEY = "isotrainer:ui:legacy-galileu-colors";
export function isContrastOn() {
  try {
    return localStorage.getItem(CONTRAST_KEY) === "1";
  } catch {
    return false;
  }
}
export function applyContrastToDocument(on) {
  try {
    document.documentElement.classList.toggle("contrast", !!on);
    document.body.classList.toggle("contrast", !!on);
    // Notify charts/UI to re-style
    window.dispatchEvent(
      new CustomEvent("ui:contrast", { detail: { on: !!on } }),
    );
    try {
      window.dispatchEvent(new Event("resize"));
    } catch { }
  } catch { }
}
export function openSettings() {
  const modal = document.getElementById("settingsModal");
  const closeBtn = document.getElementById("settingsClose");
  const toggle = document.getElementById("contrastToggle");
  const legacyToggle = document.getElementById("legacyColorsToggle");
  const resetBtn = document.getElementById("settingsResetAll");
  const saveBtn = document.getElementById("settingsSaveBtn");
  if (!modal || !toggle) return;
  try {
    toggle.checked = isContrastOn();
  } catch { }
  try {
    if (legacyToggle) {
      const v = localStorage.getItem(LEGACY_COLORS_KEY);
      legacyToggle.checked = v === "1";
    }
  } catch { }

  // Initialize plot element toggles and multipliers
  try {
    initPlotSettingsUI();
  } catch { }
  try {
    initFixedPlanToggle();
  } catch { }
  try {
    initRestSettingsUI();
  } catch { }
  try {
    ensurePlotResizeHook();
  } catch { }
  modal.classList.add("flex");
  modal.classList.remove("hidden");
  const close = () => {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  };
  closeBtn?.addEventListener("click", close, { once: true });
  modal.addEventListener(
    "click",
    (e) => {
      if (e.target === modal) close();
    },
    { once: true },
  );
  if (saveBtn)
    saveBtn.onclick = () => {
      close();
    };
  toggle.onchange = () => {
    const on = !!toggle.checked;
    try {
      localStorage.setItem(CONTRAST_KEY, on ? "1" : "0");
    } catch { }
    applyContrastToDocument(on);
  };
  if (legacyToggle)
    legacyToggle.onchange = () => {
      const on = !!legacyToggle.checked;
      try {
        localStorage.setItem(LEGACY_COLORS_KEY, on ? "1" : "0");
      } catch { }
      // Notify charts to rebuild stage bands
      try {
        window.dispatchEvent(
          new CustomEvent("ui:legacyColors", { detail: { on } }),
        );
      } catch { }
    };

  if (resetBtn)
    resetBtn.onclick = () => {
      try {
        resetAllSettingsToDefaults();
      } catch { }
      // Refresh UI controls to reflect defaults
      try {
        toggle.checked = isContrastOn();
      } catch { }
      try {
        if (legacyToggle) {
          const v = localStorage.getItem(LEGACY_COLORS_KEY);
          legacyToggle.checked = v === "1";
        }
      } catch { }
      try {
        initPlotSettingsUI();
      } catch { }
      try {
        hydrateFixedPlanPreference();
        initFixedPlanToggle();
      } catch { }
      try {
        hydrateRestSettingsFromStorage();
        initRestSettingsUI();
      } catch { }
      try {
        renderHome(loadStoredPlans());
      } catch { }
    };
}

// ============= Plot Screen: Element Toggles & Multipliers ============= //
const PLOT_PREFIX = "isotrainer:plot:";
const PLOT_TOGGLES = [
  // Header elements
  {
    key: "header:session",
    sel: "#sessionMeta",
    inputId: "togglePlotHeaderSession",
  },
  {
    key: "header:athlete",
    sel: "#sessionAthlete",
    inputId: "togglePlotHeaderAthlete",
  },
  {
    key: "header:stageLabel",
    sel: "#stageLabel",
    inputId: "togglePlotHeaderStageLabel",
  },
  {
    key: "header:inTargetMobile",
    sel: "#stageInTargetPctMobileWrap",
    inputId: "togglePlotHeaderInTargetMobile",
  },
  // Left aside
  {
    key: "left:forceValue",
    sel: "#currentForceValue",
    inputId: "toggleAsideLeftForceValue",
  },
  {
    key: "left:forceUnit",
    sel: "#currentForce .force-unit",
    inputId: "toggleAsideLeftForceUnit",
  },
  {
    key: "left:stageRange",
    sel: "#stageRange",
    inputId: "toggleAsideLeftStageRange",
  },
  {
    key: "left:nextHint",
    sel: "#nextStageHint",
    inputId: "toggleAsideLeftNextHint",
  },
  // Main chart
  {
    key: "main:forceMarker",
    sel: "#forceMarker",
    inputId: "toggleForceMarker",
  },
  { key: "main:stageChart", sel: "#forceChart", inputId: "toggleStageChart" },
  // Right aside
  {
    key: "right:stageElapsed",
    sel: "#stageElapsed",
    inputId: "toggleAsideRightStageElapsed",
  },
  {
    key: "right:totalRemaining",
    sel: "#totalRemaining",
    inputId: "toggleAsideRightTotalRemaining",
  },
  {
    key: "right:inTarget",
    sel: ".target-pct-row",
    inputId: "toggleAsideRightInTarget",
  },
  // Bottom session chart
  {
    key: "bottom:sessionChart",
    sel: "#sessionCardContainer",
    inputId: "toggleSessionChart",
  },
];

const PLOT_SMOOTHING_KEY = "trendSmoothing";
let lastTrendSmoothingApplied = null;
const PLOT_SMOOTHING_ALPHA_KEY = "trendSmoothingAlpha";

function getPlotToggle(key) {
  try {
    const v = localStorage.getItem(PLOT_PREFIX + "toggle:" + key);
    return v == null ? true : v === "1";
  } catch {
    return true;
  }
}
function setPlotToggle(key, on) {
  try {
    localStorage.setItem(PLOT_PREFIX + "toggle:" + key, on ? "1" : "0");
  } catch { }
}
function getAsideMul(which) {
  try {
    return (
      parseFloat(localStorage.getItem(PLOT_PREFIX + which + ":mul") || "0") || 0
    );
  } catch {
    return 0;
  }
}
function setAsideMul(which, v) {
  try {
    localStorage.setItem(PLOT_PREFIX + which + ":mul", String(v));
  } catch { }
}

function getTrendSmoothingEnabled() {
  try {
    const v = localStorage.getItem(PLOT_PREFIX + PLOT_SMOOTHING_KEY);
    if (v == null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

function setTrendSmoothingStorage(on) {
  try {
    localStorage.setItem(PLOT_PREFIX + PLOT_SMOOTHING_KEY, on ? "1" : "0");
  } catch { }
  state.trendSmoothingEnabled = !!on;
}

function applyTrendSmoothingSetting(force = false) {
  const enabled = getTrendSmoothingEnabled();
  const input = document.getElementById("toggleTrendSmoothing");
  if (input) input.checked = enabled;
  if (!force && lastTrendSmoothingApplied === enabled) return;
  lastTrendSmoothingApplied = enabled;
  state.trendSmoothingEnabled = enabled;
  const alphaInput = document.getElementById("trendSmoothingAlpha");
  const alphaLabel = document.getElementById("trendSmoothingAlphaValue");
  if (alphaInput) alphaInput.disabled = !enabled;
  if (alphaLabel) alphaLabel.classList.toggle("opacity-50", !enabled);
  try {
    window.dispatchEvent(
      new CustomEvent("plot:trendSmoothing", {
        detail: { enabled },
      }),
    );
  } catch { }
}

function getTrendSmoothingAlpha() {
  try {
    const raw = localStorage.getItem(PLOT_PREFIX + PLOT_SMOOTHING_ALPHA_KEY);
    if (raw == null) return state.trendSmoothingAlpha || 0.25;
    const num = parseFloat(raw);
    const alpha = Number.isFinite(num) ? num : 0.02;
    return Math.min(0.95, Math.max(0.02, alpha));
  } catch {
    return state.trendSmoothingAlpha || 0.02;
  }
}

function setTrendSmoothingAlphaStorage(alpha) {
  const clamped = Math.min(0.95, Math.max(0.02, Number(alpha) || 0.02));
  try {
    localStorage.setItem(
      PLOT_PREFIX + PLOT_SMOOTHING_ALPHA_KEY,
      String(clamped),
    );
  } catch { }
  state.trendSmoothingAlpha = clamped;
}

function applyTrendSmoothingAlpha(force = false) {
  const alpha = getTrendSmoothingAlpha();
  const input = document.getElementById("trendSmoothingAlpha");
  if (input) input.value = String(alpha);
  const label = document.getElementById("trendSmoothingAlphaValue");
  if (label) label.textContent = alpha.toFixed(2);
  if (!force && Math.abs((state.trendSmoothingAlpha || 0) - alpha) < 0.0001)
    return;
  state.trendSmoothingAlpha = alpha;
  try {
    window.dispatchEvent(
      new CustomEvent("plot:trendSmoothingAlpha", {
        detail: { alpha },
      }),
    );
  } catch { }
}

export function applyPlotSettingsToDom() {
  // Visibility
  for (const { key, sel } of PLOT_TOGGLES) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const on = getPlotToggle(key); // default off
    el.classList.toggle("hidden", !on);
  }
  // Hide entire asides if all their elements are off
  const leftOn =
    getPlotToggle("left:forceValue") ||
    getPlotToggle("left:forceUnit") ||
    getPlotToggle("left:stageRange") ||
    getPlotToggle("left:nextHint");
  const rightOn =
    getPlotToggle("right:stageElapsed") ||
    getPlotToggle("right:totalRemaining") ||
    getPlotToggle("right:inTarget");
  const leftAside = document.querySelector(".aside-left");
  const rightAside = document.querySelector(".aside-right");
  if (leftAside) leftAside.classList.toggle("hidden", !leftOn);
  if (rightAside) rightAside.classList.toggle("hidden", !rightOn);

  // Adjust grid columns to fill gaps on larger/landscape layouts
  try {
    const frame = document.getElementById("frameGrid");
    const isWide =
      window.matchMedia &&
      (window.matchMedia("(min-width: 1024px)").matches ||
        window.matchMedia("(orientation: landscape)").matches);
    if (frame) {
      if (!isWide) {
        frame.style.gridTemplateColumns = "";
      } else {
        if (leftOn && rightOn)
          frame.style.gridTemplateColumns = "auto 1fr auto";
        else if (leftOn && !rightOn)
          frame.style.gridTemplateColumns = "auto 1fr";
        else if (!leftOn && rightOn)
          frame.style.gridTemplateColumns = "1fr auto";
        else frame.style.gridTemplateColumns = "1fr";
      }
    }
  } catch { }
  // Aside scaling (font-size multiplier)
  try {
    const left = document.querySelector(".aside-left");
    const right = document.querySelector(".aside-right");
    const lm = Math.max(-0.9, getAsideMul("left"));
    const rm = Math.max(-0.9, getAsideMul("right"));
    if (left) {
      if (!left.dataset.baseFontPx) {
        left.dataset.baseFontPx = String(
          parseFloat(getComputedStyle(left).fontSize) || 16,
        );
      }
      const base = parseFloat(left.dataset.baseFontPx) || 16;
      left.style.fontSize = (base * (1 + lm)).toFixed(2) + "px";
    }
    if (right) {
      if (!right.dataset.baseFontPx) {
        right.dataset.baseFontPx = String(
          parseFloat(getComputedStyle(right).fontSize) || 16,
        );
      }
      const base = parseFloat(right.dataset.baseFontPx) || 16;
      right.style.fontSize = (base * (1 + rm)).toFixed(2) + "px";
    }
  } catch { }
  applyTrendSmoothingSetting();
  applyTrendSmoothingAlpha();
  try {
    window.dispatchEvent(new Event("resize"));
  } catch { }
}

let plotResizeHooked = false;
function ensurePlotResizeHook() {
  if (plotResizeHooked) return;
  plotResizeHooked = true;
  try {
    window.addEventListener(
      "resize",
      () => {
        try {
          applyPlotSettingsToDom();
        } catch { }
      },
      { passive: true },
    );
    window.addEventListener(
      "orientationchange",
      () => {
        try {
          applyPlotSettingsToDom();
        } catch { }
      },
      { passive: true },
    );
  } catch { }
}

function initPlotSettingsUI() {
  // wire toggles
  for (const { key, inputId } of PLOT_TOGGLES) {
    const input = document.getElementById(inputId);
    if (!input) continue;
    input.checked = getPlotToggle(key);
    input.onchange = () => {
      setPlotToggle(key, !!input.checked);
      applyPlotSettingsToDom();
      try {
        window.dispatchEvent(
          new CustomEvent("ui:plotSettingsChanged", {
            detail: { key, on: !!input.checked },
          }),
        );
      } catch { }
    };
  }
  // multipliers
  const leftMul = document.getElementById("asideLeftMul");
  const rightMul = document.getElementById("asideRightMul");
  if (leftMul) {
    leftMul.value = String(getAsideMul("left") || 0);
    leftMul.onchange = () => {
      setAsideMul("left", parseFloat(leftMul.value) || 0);
      applyPlotSettingsToDom();
    };
  }
  if (rightMul) {
    rightMul.value = String(getAsideMul("right") || 0);
    rightMul.onchange = () => {
      setAsideMul("right", parseFloat(rightMul.value) || 0);
      applyPlotSettingsToDom();
    };
  }
  const smoothingInput = document.getElementById("toggleTrendSmoothing");
  if (smoothingInput) {
    smoothingInput.checked = getTrendSmoothingEnabled();
    smoothingInput.onchange = () => {
      setTrendSmoothingStorage(!!smoothingInput.checked);
      applyTrendSmoothingSetting(true);
    };
  }
  const smoothingAlphaInput = document.getElementById("trendSmoothingAlpha");
  if (smoothingAlphaInput) {
    smoothingAlphaInput.value = String(getTrendSmoothingAlpha());
    smoothingAlphaInput.onchange = () => {
      const raw = parseFloat(smoothingAlphaInput.value);
      const alpha = Math.min(0.95, Math.max(0.02, Number.isFinite(raw) ? raw : getTrendSmoothingAlpha()));
      setTrendSmoothingAlphaStorage(alpha);
      smoothingAlphaInput.value = String(alpha);
      applyTrendSmoothingAlpha(true);
    };
  }
  // Apply immediately to reflect the current values
  try {
    applyPlotSettingsToDom();
  } catch { }
  applyTrendSmoothingSetting(true);
  applyTrendSmoothingAlpha(true);
}

function resetAllSettingsToDefaults() {
  // Contrast OFF, Legacy Colors OFF
  try {
    localStorage.removeItem(CONTRAST_KEY);
  } catch { }
  try {
    localStorage.removeItem(LEGACY_COLORS_KEY);
  } catch { }
  // Plot element toggles: remove keys so they default to ON
  try {
    for (const { key } of PLOT_TOGGLES) {
      localStorage.removeItem(PLOT_PREFIX + "toggle:" + key);
    }
  } catch { }
  // Multipliers: set to 0
  try {
    localStorage.removeItem(PLOT_PREFIX + "left:mul");
  } catch { }
  try {
    localStorage.removeItem(PLOT_PREFIX + "right:mul");
  } catch { }
  try {
    localStorage.removeItem(REST_INTERVAL_KEY);
  } catch { }
  try {
    localStorage.removeItem(REST_POSITIONS_KEY);
  } catch { }
  try {
    localStorage.removeItem(REST_SKIP_KEY);
  } catch { }
  try {
    localStorage.removeItem(FLOW_STEP_ORDER_KEY);
  } catch { }
  try {
    localStorage.removeItem(FIXED_PLAN_PREF_KEY);
  } catch { }
  try {
    localStorage.removeItem(PLOT_PREFIX + PLOT_SMOOTHING_KEY);
  } catch { }
  try {
    localStorage.removeItem(PLOT_PREFIX + PLOT_SMOOTHING_ALPHA_KEY);
  } catch { }
  // Apply to document/UI
  try {
    applyContrastToDocument(false);
  } catch { }
  try {
    window.dispatchEvent(
      new CustomEvent("ui:legacyColors", { detail: { on: false } }),
    );
  } catch { }
  try {
    applyPlotSettingsToDom();
  } catch { }
  try {
    hydrateRestSettingsFromStorage();
    initRestSettingsUI();
    state.flowStepOrder = DEFAULT_FLOW_STEP_ORDER.slice();
  } catch { }
  try {
    hydrateFixedPlanPreference();
    initFixedPlanToggle();
  } catch { }
  try {
    renderHome(loadStoredPlans());
  } catch { }
  lastTrendSmoothingApplied = null;
  state.trendSmoothingEnabled = true;
  state.trendSmoothingAlpha = 0.25;
  applyTrendSmoothingSetting(true);
  applyTrendSmoothingAlpha(true);
}
