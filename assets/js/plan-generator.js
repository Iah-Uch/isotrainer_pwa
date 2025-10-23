// Module: Plan Generator - Periodization planning tool
import { FIXED_PLAN_LIBRARY } from './mesocycles.js';

// Convert FIXED_PLAN_LIBRARY array to object format for compatibility
const MESOCYCLES = {};
FIXED_PLAN_LIBRARY.forEach(plan => {
  MESOCYCLES[plan.id] = {
    name: plan.name,
    weeklyFrequency: plan.weeklyFrequency,
    description: plan.summary,
    stages: plan.stages
  };
});

let selectedMesocycles = [];
let validationResult = null;

// Initialize
function init() {
  renderMesocycles();
  attachEventListeners();
  // Set today's date in custom format + ISO value
  setTodayDate();
  // Initialize button states
  updateMainActionButton();
}

function setTodayDate() {
  const today = new Date();
  const todayString = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const el = document.getElementById('startDate');
  el.value = todayString;
  updateDateMask(el);
}

// Update mask text beside the date input
function updateDateMask(inputEl) {
  const mask = document.getElementById('startDateMask');
  if (!mask) return;
  if (!inputEl.value) {
    mask.textContent = 'dd/mm/aaaa';
    return;
  }
  const d = new Date(inputEl.value + 'T00:00:00'); // Force local timezone
  if (isNaN(d)) {
    mask.textContent = 'dd/mm/aaaa';
    return;
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  mask.textContent = `${day}/${month}/${year}`;
}

function renderMesocycles() {
  const container = document.getElementById('mesocycleList');
  container.innerHTML = '';

  Object.entries(MESOCYCLES).forEach(([id, meso]) => {
    const card = document.createElement('label');
    card.className = 'flex flex-col gap-2 p-4 rounded-lg bg-[#0b0b0c] border border-[#2a2a2a] hover:border-amber-600 cursor-pointer transition';
    
    card.innerHTML = `
      <div class="flex items-center gap-2">
        <input type="checkbox" class="mesocycle-checkbox accent-amber-600" value="${id}" data-frequency="${meso.weeklyFrequency}">
        <span class="font-semibold text-slate-200">${meso.name}</span>
      </div>
      <div class="text-xs text-slate-400">${meso.description}</div>
      <div class="text-xs text-amber-500">${meso.weeklyFrequency}x/semana • ${meso.stages.length} estágios</div>
    `;
    
    container.appendChild(card);
  });
}

function attachEventListeners() {
  document.querySelectorAll('.mesocycle-checkbox').forEach(cb => {
    cb.addEventListener('change', updateSelectedMesocycles);
  });

  document.querySelectorAll('input[name="strategy"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const blockConfig = document.getElementById('blockSizeConfig');
      blockConfig.style.display = radio.value === 'block' ? 'block' : 'none';
    });
  });

  document.getElementById('mainActionBtn').addEventListener('click', handleMainAction);
  document.getElementById('loadDirectBtn').addEventListener('click', loadDirectly);
  document.getElementById('resetBtn').addEventListener('click', resetForm);
  
  // Add auto-revalidation listeners
  addAutoRevalidationListeners();

  // Keep the date mask in sync and still use native picker
  const startDateEl = document.getElementById('startDate');
  startDateEl.addEventListener('input', () => updateDateMask(startDateEl));
  startDateEl.addEventListener('change', () => updateDateMask(startDateEl));
}

function updateSelectedMesocycles() {
  selectedMesocycles = Array.from(document.querySelectorAll('.mesocycle-checkbox:checked'))
    .map(cb => cb.value);
  
  const strategySection = document.getElementById('strategySection');
  strategySection.style.display = selectedMesocycles.length > 1 ? 'block' : 'none';
  
  // Reset validation when selection changes
  validationResult = null;
  updateMainActionButton();
  document.getElementById('loadDirectBtn').disabled = true;
  document.getElementById('validationMessage').style.display = 'none';
}

function handleMainAction() {
  if (!validationResult) {
    validateConfiguration();
  } else if (validationResult.feasible) {
    generatePlan();
  }
}

function updateMainActionButton() {
  const mainBtn = document.getElementById('mainActionBtn');
  const loadBtn = document.getElementById('loadDirectBtn');
  
  if (!validationResult) {
    mainBtn.textContent = 'Validar';
    loadBtn.disabled = true;
    loadBtn.style.background = '#6b7280';
    loadBtn.style.color = '#9ca3af';
  } else if (validationResult.feasible) {
    mainBtn.textContent = 'Gerar CSV';
    loadBtn.disabled = false;
    loadBtn.style.background = '#10b981';
    loadBtn.style.color = 'white';
  } else {
    mainBtn.textContent = 'Validar';
    loadBtn.disabled = true;
    loadBtn.style.background = '#6b7280';
    loadBtn.style.color = '#9ca3af';
  }
}

function addAutoRevalidationListeners() {
  // Listen to all form inputs
  const formInputs = [
    'clientName',
    'maxForce', 
    'age',
    'startDate',
    'totalDays'
  ];
  
  formInputs.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('input', autoRevalidate);
      element.addEventListener('change', autoRevalidate);
    }
  });
  
  // Listen to training day checkboxes
  document.querySelectorAll('input[type="checkbox"][id^="day"]').forEach(checkbox => {
    checkbox.addEventListener('change', autoRevalidate);
  });
  
  // Listen to mesocycle checkboxes
  document.querySelectorAll('.mesocycle-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', autoRevalidate);
  });
  
  // Listen to strategy radio buttons
  document.querySelectorAll('input[name="strategy"]').forEach(radio => {
    radio.addEventListener('change', autoRevalidate);
  });
  
  // Listen to block size input
  const blockSizeInput = document.getElementById('blockSize');
  if (blockSizeInput) {
    blockSizeInput.addEventListener('input', autoRevalidate);
    blockSizeInput.addEventListener('change', autoRevalidate);
  }
}

function autoRevalidate() {
  // Only auto-revalidate if we already have a validation result
  if (validationResult) {
    clearTimeout(window.autoRevalidateTimeout);
    window.autoRevalidateTimeout = setTimeout(() => {
      validateConfiguration();
    }, 500);
  }
}

function ignoreValidationAndProceed() {
  if (validationResult) {
    validationResult.feasible = true;
    updateMainActionButton();
    document.getElementById('validationMessage').style.display = 'none';
    showValidation('success', `
      <strong>Configuração aceita!</strong><br>
      Você optou por prosseguir mesmo com a frequência alta.<br>
      O plano será gerado com as sessões possíveis nos dias disponíveis.
    `);
  }
}

function validateConfiguration() {
  const clientName = document.getElementById('clientName').value.trim();
  const maxForce = parseFloat(document.getElementById('maxForce').value);
  const startDateValue = document.getElementById('startDate').value;
  const totalDays = parseInt(document.getElementById('totalDays').value);
  const availableDays = Array.from(document.querySelectorAll('input[type="checkbox"][id^="day"]:checked'))
    .map(cb => parseInt(cb.value));

  if (!clientName) {
    showValidation('error', 'Por favor, preencha o nome do cliente.');
    return;
  }
  if (!maxForce || maxForce <= 0) {
    showValidation('error', 'Por favor, informe a força máxima média.');
    return;
  }
  if (!startDateValue) {
    showValidation('error', 'Por favor, selecione a data de início.');
    return;
  }

  const selectedDate = new Date(startDateValue + 'T00:00:00'); // Force local timezone
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selectedDateOnly = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  
  if (selectedDateOnly < todayOnly) {
    showValidation('error', 'Por favor, selecione uma data futura ou hoje.');
    return;
  }

  if (!totalDays || totalDays < 7) {
    showValidation('error', 'A duração total deve ser de pelo menos 7 dias.');
    return;
  }

  if (availableDays.length === 0) {
    showValidation('error', 'Por favor, selecione pelo menos um dia da semana.');
    return;
  }

  if (selectedMesocycles.length === 0) {
    showValidation('error', 'Por favor, selecione pelo menos um mesociclo.');
    return;
  }

  const strategy = document.querySelector('input[name="strategy"]:checked')?.value || 'sequential';
  const result = calculatePlanFeasibility(availableDays, totalDays, selectedMesocycles, strategy);
  
  validationResult = result;

  if (result.feasible) {
    showValidation('success', `
      <strong>Configuração válida!</strong><br>
      Total de sessões: ${result.totalSessions}<br>
      Duração estimada: ${result.estimatedWeeks} semanas<br>
      Frequência média: ${result.avgFrequency.toFixed(1)}x/semana<br>
      <br>
      <button onclick="showPreview()" class="btn-secondary px-4 py-2 rounded-lg mt-2">
        Ver Pré-visualização
      </button>
    `);
    updateMainActionButton();
  } else {
    let message = `<strong>Configuração inválida!</strong><br>${result.reason}<br><br>`;
    message += '<strong>Soluções sugeridas:</strong><ul class="list-disc list-inside mt-2">';
    
    if (result.solutions.includes('add_days')) {
      message += `<li>Adicione mais dias de treino (dias disponíveis: ${availableDays.length})</li>`;
    }
    if (result.solutions.includes('increase_duration')) {
      message += `<li>Aumente a duração total para pelo menos ${result.minDurationNeeded} dias</li>`;
    }
    if (result.solutions.includes('reduce_frequency')) {
      message += `<li>Reduza a frequência semanal ou selecione mesociclos com menor frequência</li>`;
    }
    
    message += '</ul>';
    message += '<div class="mt-4 flex gap-2">';
    message += '<button onclick="ignoreValidationAndProceed()" class="btn-primary px-4 py-2 rounded-lg text-sm">Ignorar e Prosseguir</button>';
    message += '<button onclick="document.getElementById(\'validationMessage\').style.display=\'none\'" class="btn-secondary px-4 py-2 rounded-lg text-sm">Fechar</button>';
    message += '</div>';
    showValidation('warning', message);
    updateMainActionButton();
  }
}

function calculatePlanFeasibility(availableDays, totalDays, mesocycleIds, strategy) {
  const totalWeeks = Math.floor(totalDays / 7);
  const availableDaysPerWeek = availableDays.length;
  
  let requiredFrequency = 0;
  let totalSessions = 0;

  if (strategy === 'sequential') {
    mesocycleIds.forEach(id => {
      const meso = MESOCYCLES[id];
      const sessionsPerCycle = meso.weeklyFrequency;
      const cyclesNeeded = Math.max(3, Math.floor(totalWeeks / mesocycleIds.length / 3));
      totalSessions += sessionsPerCycle * cyclesNeeded;
    });
    requiredFrequency = totalSessions / totalWeeks;
  } else if (strategy === 'alternated') {
    const avgFreq = mesocycleIds.reduce((sum, id) => sum + MESOCYCLES[id].weeklyFrequency, 0) / mesocycleIds.length;
    requiredFrequency = avgFreq;
    totalSessions = Math.floor(avgFreq * totalWeeks);
  } else if (strategy === 'block') {
    const blockSize = parseInt(document.getElementById('blockSize')?.value || 3);
    const blocksPerMeso = Math.ceil(totalWeeks / mesocycleIds.length / blockSize);
    mesocycleIds.forEach(id => {
      totalSessions += MESOCYCLES[id].weeklyFrequency * blockSize * blocksPerMeso;
    });
    requiredFrequency = totalSessions / totalWeeks;
  } else if (strategy === 'pyramidal') {
    const avgFreq = mesocycleIds.reduce((sum, id) => sum + MESOCYCLES[id].weeklyFrequency, 0) / mesocycleIds.length;
    requiredFrequency = avgFreq;
    totalSessions = Math.floor(avgFreq * totalWeeks);
  } else { // concurrent
    const maxFreq = Math.max(...mesocycleIds.map(id => MESOCYCLES[id].weeklyFrequency));
    requiredFrequency = maxFreq;
    totalSessions = maxFreq * totalWeeks;
  }

  const feasible = requiredFrequency <= availableDaysPerWeek;
  const minDurationNeeded = Math.ceil((totalSessions / availableDaysPerWeek) * 7);

  const result = {
    feasible,
    totalSessions,
    estimatedWeeks: totalWeeks,
    avgFrequency: requiredFrequency,
    availableDaysPerWeek,
    minDurationNeeded,
    reason: '',
    solutions: []
  };

  if (!feasible) {
    result.reason = `A frequência média necessária (${requiredFrequency.toFixed(1)}x/semana) excede os dias disponíveis (${availableDaysPerWeek}x/semana).`;
    
    if (availableDaysPerWeek < 3) {
      result.solutions.push('add_days');
    }
    if (minDurationNeeded > totalDays) {
      result.solutions.push('increase_duration');
    }
    result.solutions.push('reduce_frequency');
  }

  return result;
}

function showValidation(type, message) {
  const container = document.getElementById('validationMessage');
  container.style.display = 'block';
  
  let className = 'info-box';
  if (type === 'error' || type === 'warning') className = 'warning-box';
  if (type === 'success') className = 'success-box';
  
  container.className = `fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-2xl px-4 ${className} rounded-xl p-4 shadow-2xl backdrop-blur-lg`;
  container.innerHTML = message;
  
  if (type === 'success') {
    setTimeout(() => {
      container.style.display = 'none';
    }, 5000);
  }
}

function showPreview() {
  if (!validationResult || !validationResult.feasible) return;

  const preview = document.getElementById('previewSection');
  const content = document.getElementById('previewContent');
  
  const plan = generatePlanData();
  
  let html = '<div class="space-y-4">';
  html += `<div class="text-lg font-semibold">Cliente: ${plan.clientName}</div>`;
  html += `<div>Total de sessões: ${plan.sessions.length}</div>`;
  html += `<div>Período: ${plan.sessions[0].date} até ${plan.sessions[plan.sessions.length - 1].date}</div>`;
  html += '<div class="mt-4"><strong>Primeiras 10 sessões:</strong></div>';
  html += '<div class="overflow-x-auto"><table class="w-full text-sm mt-2">';
  html += '<thead class="border-b border-[#2a2a2a]"><tr><th class="text-left p-2">Data</th><th class="text-left p-2">Mesociclo</th><th class="text-left p-2">Tipo</th></tr></thead><tbody>';
  
  plan.sessions.slice(0, 10).forEach(session => {
    html += `<tr class="border-b border-[#2a2a2a]">
      <td class="p-2">${session.date}</td>
      <td class="p-2">${session.mesocycleName}</td>
      <td class="p-2 text-xs text-slate-400">${session.mesocycleId}</td>
    </tr>`;
  });
  
  html += '</tbody></table></div>';
  html += '</div>';
  
  content.innerHTML = html;
  preview.style.display = 'block';
}

function generatePlanData() {
  const clientName = document.getElementById('clientName').value.trim();
  const maxForce = parseFloat(document.getElementById('maxForce').value);
  const age = parseInt(document.getElementById('age').value) || null;
  const startDateValue = document.getElementById('startDate').value; // ISO (yyyy-mm-dd)
  const startDate = new Date(startDateValue + 'T00:00:00'); // Force local timezone
  const totalDays = parseInt(document.getElementById('totalDays').value);
  const availableDays = Array.from(document.querySelectorAll('input[type="checkbox"][id^="day"]:checked'))
    .map(cb => parseInt(cb.value));
  const strategy = document.querySelector('input[name="strategy"]:checked')?.value || 'sequential';
  const blockSize = parseInt(document.getElementById('blockSize')?.value || 3);

  const sessions = [];
  const mesocycleSequence = generateMesocycleSequence(selectedMesocycles, strategy, totalDays, blockSize);
  
  let currentDate = new Date(startDate);
  let sessionIndex = 0;
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + totalDays);

  while (currentDate < endDate && sessionIndex < mesocycleSequence.length) {
    const dayOfWeek = currentDate.getDay();
    
    if (availableDays.includes(dayOfWeek)) {
      const mesoId = mesocycleSequence[sessionIndex];
      const meso = MESOCYCLES[mesoId];
      
      let intensityMultiplier = 1.0;
      if (age) {
        if (age > 60) intensityMultiplier = 0.85;
        else if (age > 50) intensityMultiplier = 0.90;
        else if (age < 25) intensityMultiplier = 1.05;
      }

      sessions.push({
        date: formatDate(currentDate),
        mesocycleId: mesoId,
        mesocycleName: meso.name,
        maxForce: maxForce * intensityMultiplier,
        sessionNumber: sessionIndex + 1
      });
      
      sessionIndex++;
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return {
    clientName,
    maxForce,
    age,
    startDate: formatDate(startDate),
    totalDays,
    availableDays,
    strategy,
    sessions
  };
}

function generateMesocycleSequence(mesocycleIds, strategy, totalDays, blockSize) {
  const sequence = [];
  const totalWeeks = Math.floor(totalDays / 7);
  
  if (strategy === 'sequential') {
    const weeksPerMeso = Math.floor(totalWeeks / mesocycleIds.length);
    mesocycleIds.forEach(id => {
      const meso = MESOCYCLES[id];
      const sessionsNeeded = weeksPerMeso * meso.weeklyFrequency;
      for (let i = 0; i < sessionsNeeded; i++) {
        sequence.push(id);
      }
    });
  } else if (strategy === 'alternated') {
    let week = 0;
    while (week < totalWeeks) {
      mesocycleIds.forEach(id => {
        const meso = MESOCYCLES[id];
        for (let i = 0; i < meso.weeklyFrequency; i++) {
          sequence.push(id);
        }
      });
      week++;
    }
  } else if (strategy === 'block') {
    const blocksNeeded = Math.ceil(totalWeeks / blockSize);
    for (let b = 0; b < blocksNeeded; b++) {
      mesocycleIds.forEach(id => {
        const meso = MESOCYCLES[id];
        for (let w = 0; w < blockSize; w++) {
          for (let s = 0; s < meso.weeklyFrequency; s++) {
            sequence.push(id);
          }
        }
      });
    }
  } else if (strategy === 'pyramidal') {
    const sorted = [...mesocycleIds].sort((a, b) => {
      const avgA = MESOCYCLES[a].stages.reduce((s, st) => s + st.upperPct, 0) / MESOCYCLES[a].stages.length;
      const avgB = MESOCYCLES[b].stages.reduce((s, st) => s + st.upperPct, 0) / MESOCYCLES[b].stages.length;
      return avgA - avgB;
    });
    
    sorted.forEach(id => {
      const meso = MESOCYCLES[id];
      const weeks = Math.floor(totalWeeks / sorted.length);
      for (let w = 0; w < weeks; w++) {
        for (let s = 0; s < meso.weeklyFrequency; s++) {
          sequence.push(id);
        }
      }
    });
  } else { // concurrent
    for (let w = 0; w < totalWeeks; w++) {
      mesocycleIds.forEach(id => {
        const meso = MESOCYCLES[id];
        const sessions = Math.ceil(meso.weeklyFrequency / mesocycleIds.length);
        for (let s = 0; s < sessions; s++) {
          sequence.push(id);
        }
      });
    }
  }

  return sequence;
}

function generatePlan() {
  const plan = generatePlanData();
  const csv = buildCSV(plan);
  downloadCSV(csv, `periodizacao_${plan.clientName.replace(/\s+/g, '_')}_${plan.startDate.replace(/\//g, '-')}.csv`);
}

function loadDirectly() {
  const plan = generatePlanData();
  const csv = buildCSV(plan);
  
  const lines = csv.split('\n');
  const sessions = parseMesocycleReferenceCsv(lines);
  
  try {
    const STORAGE_KEY = "isotrainer:plans";
    const PROFILE_VERSION = 2;
    let planState;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        planState = JSON.parse(raw);
        if (Array.isArray(planState)) {
          const profileId = 'profile_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
          planState = {
            version: PROFILE_VERSION,
            activeProfileId: profileId,
            profiles: [{
              id: profileId,
              name: plan.clientName || 'Atleta',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              plans: planState
            }]
          };
        }
      }
    } catch {
      planState = null;
    }
    
    if (!planState || !planState.profiles) {
      const profileId = 'profile_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      planState = {
        version: PROFILE_VERSION,
        activeProfileId: profileId,
        profiles: [{
          id: profileId,
          name: plan.clientName || 'Atleta',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          plans: []
        }]
      };
    }
    
    let profile = planState.profiles.find(p => p.name === plan.clientName);
    if (!profile) {
      const profileId = 'profile_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      profile = {
        id: profileId,
        name: plan.clientName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        plans: []
      };
      planState.profiles.push(profile);
    }
    
    const updatedSessions = sessions.map((s, i) => ({
      ...s,
      id: 'plan_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36) + '_' + i,
      idx: profile.plans.length + i + 1,
      profileId: profile.id
    }));
    
    profile.plans = [...profile.plans, ...updatedSessions];
    profile.updatedAt = new Date().toISOString();
    planState.activeProfileId = profile.id;
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(planState));
    localStorage.setItem('isotrainer:home:fixedPlans', '0');
    
    showValidation('success', `
      <strong>Plano carregado com sucesso!</strong><br>
      ${sessions.length} sessões foram adicionadas ao IsoTrainer.<br>
      <br>
      <a href="/app.html" class="btn-primary px-4 py-2 rounded-lg mt-2 inline-block">
        Abrir IsoTrainer
      </a>
    `);
  } catch (error) {
    showValidation('error', `Erro ao carregar o plano: ${error.message}`);
  }
}

function parseMesocycleReferenceCsv(lines) {
  const sessions = [];
  if (lines.length < 2) return sessions;
  
  const header = lines[0].toLowerCase().split(';').map(s => s.trim());
  const dateIdx = header.findIndex(h => h.includes('date') || h.includes('data'));
  const clientIdx = header.findIndex(h => h.includes('client') || h.includes('athlete') || h.includes('atleta'));
  const planIdIdx = header.findIndex(h => h.includes('planid') || h.includes('mesociclo'));
  
  if (dateIdx === -1 || clientIdx === -1 || planIdIdx === -1) {
    throw new Error('Formato de CSV inválido');
  }
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = line.split(';');
    if (cols.length < 4) continue;
    
    const dateStr = cols[dateIdx];
    const client = cols[clientIdx];
    const fixedPlanId = cols[planIdIdx];
    
    if (!dateStr || !client || !fixedPlanId) continue;
    
    const mesocycle = MESOCYCLES[fixedPlanId];
    if (!mesocycle) {
      console.warn(`Mesocycle not found: ${fixedPlanId}`);
      continue;
    }
    
    sessions.push({
      date: dateStr,
      athlete: client,
      fixedPlanId: fixedPlanId,
      isFixedPlanReference: true,
      stages: [],
      totalDurationSec: 0
    });
  }
  
  return sessions;
}

function buildCSV(plan) {
  const rows = [];
  rows.push('date;client;planId;idx;version');
  plan.sessions.forEach((session, idx) => {
    rows.push(`${session.date};${plan.clientName};${session.mesocycleId};${idx + 1};isotrainer-v2`);
  });
  return rows.join('\n');
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showValidation('success', `Arquivo <strong>${filename}</strong> gerado com sucesso! Importe-o no IsoTrainer.`);
}

function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function resetForm() {
  document.getElementById('clientName').value = '';
  document.getElementById('maxForce').value = '';
  document.getElementById('age').value = '';
  setTodayDate();
  document.getElementById('totalDays').value = '';
  
  document.querySelectorAll('.mesocycle-checkbox').forEach(cb => cb.checked = false);
  document.querySelectorAll('input[name="strategy"]')[0].checked = true;
  
  selectedMesocycles = [];
  validationResult = null;
  
  document.getElementById('strategySection').style.display = 'none';
  document.getElementById('validationMessage').style.display = 'none';
  document.getElementById('previewSection').style.display = 'none';
  updateMainActionButton();
}

// Expose functions globally for onclick handlers in HTML
window.ignoreValidationAndProceed = ignoreValidationAndProceed;
window.showPreview = showPreview;

// Initialize on load
window.addEventListener('DOMContentLoaded', init);

