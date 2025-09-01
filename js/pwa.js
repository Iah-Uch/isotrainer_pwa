// Handle PWA install prompt and button visibility
let deferredPrompt = null;

const installBtn = document.getElementById('installBtn');

function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function hideInstall(){ if (installBtn) installBtn.classList.add('hidden'); }
function showInstall(){ if (installBtn) installBtn.classList.remove('hidden'); }

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent mini-infobar on mobile and store the event
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

// On load, hide if already installed
if (isStandalone()) hideInstall();

