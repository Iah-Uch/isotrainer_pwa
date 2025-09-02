// Handle PWA install UI + auto-update client helpers
let deferredPrompt = null;

const installBtn = document.getElementById('installBtn');

function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function hideInstall(){ if (installBtn) installBtn.classList.add('hidden'); }
function showInstall(){ if (installBtn) installBtn.classList.remove('hidden'); }

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone()) showInstall();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  hideInstall();
});

installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  hideInstall();
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch {}
  deferredPrompt = null;
});

if (isStandalone()) hideInstall();

// Auto-reload once when the new SW takes control
let reloadedForUpdate = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (reloadedForUpdate) return;
  reloadedForUpdate = true;
  window.location.reload();
});

// In-app update prompt
function showUpdatePrompt(reg) {
  // If there is no waiting worker, nothing to do
  const waiting = reg.waiting;
  if (!waiting) return;

  // Create a simple banner
  const banner = document.createElement('div');
  banner.setAttribute('role', 'status');
  banner.className = 'fixed inset-x-0 bottom-0 z-50 mx-auto mb-3 w-fit max-w-full rounded-xl bg-slate-900 text-slate-100 border border-white/10 shadow-2xl px-4 py-2 flex items-center gap-3';
  banner.innerHTML = '<span class="text-sm">Uma atualização está disponível.</span>';

  const updateBtn = document.createElement('button');
  updateBtn.className = 'px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm';
  updateBtn.textContent = 'Atualizar agora';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm';
  dismissBtn.textContent = 'Depois';

  banner.appendChild(updateBtn);
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);

  const cleanup = () => { banner.remove(); };

  // If the waiting worker changes state (e.g., becomes redundant), remove banner
  waiting.addEventListener('statechange', () => {
    if (waiting.state === 'redundant') cleanup();
  });

  updateBtn.addEventListener('click', () => {
    try { waiting.postMessage('skipWaiting'); } catch {}
    // Banner will be removed after controllerchange reload
  });
  dismissBtn.addEventListener('click', cleanup);
}

// Proactively check for updates and activate them
if ('serviceWorker' in navigator) {
  // Ensure there is a registration and force an update on open
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
  const withReg = async (cb) => {
    try {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) reg = await navigator.serviceWorker.ready;
      if (reg) cb(reg);
    } catch {}
  };

  withReg((reg) => {
    // Try to fetch the latest SW
    reg.update().catch(()=>{});

    // If an update is already waiting, prompt the user
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdatePrompt(reg);
    }

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          // New update installed, prompt to activate
          showUpdatePrompt(reg);
        }
      });
    });

    // Periodically check for updates when visible
    const tryUpdate = () => { if (document.visibilityState === 'visible') reg.update().catch(()=>{}); };
    const int = setInterval(tryUpdate, 60 * 1000 * 10); // every 10 min
    document.addEventListener('visibilitychange', tryUpdate);
    window.addEventListener('beforeunload', () => clearInterval(int));
  });
}
