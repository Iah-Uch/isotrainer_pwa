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

// Auto-update: when a new SW takes control, reload once.
let reloadedForUpdate = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (reloadedForUpdate) return;
  reloadedForUpdate = true;
  window.location.reload();
});

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
    // Immediately try to update on open
    reg.update().catch(()=>{});
    // If there's an updated worker waiting, activate it now
    reg.waiting?.postMessage('skipWaiting');

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          reg.waiting?.postMessage('skipWaiting');
        }
      });
    });

    // Periodically call update when page is visible
    const tryUpdate = () => { if (document.visibilityState === 'visible') reg.update().catch(()=>{}); };
    const int = setInterval(tryUpdate, 60 * 1000 * 10); // every 10 min
    document.addEventListener('visibilitychange', tryUpdate);
    window.addEventListener('beforeunload', () => clearInterval(int));
  });
}
