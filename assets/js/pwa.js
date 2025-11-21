// Module: PWA install UI and update helpers.
let deferredPrompt = null;

const installBtn = document.getElementById("installBtn");
const openAppBtn = document.getElementById("openAppBtn");
const installedMessage = document.getElementById("installedMessage");

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function hideInstall() {
  if (installBtn) installBtn.classList.add("hidden");
}
function showInstall() {
  if (installBtn) installBtn.classList.remove("hidden");
}
function hideOpen() {
  if (openAppBtn) openAppBtn.classList.add("hidden");
}
function showOpen() {
  if (openAppBtn) openAppBtn.classList.remove("hidden");
}
function hideInstalledMessage() {
  if (installedMessage) installedMessage.classList.add("hidden");
}
function showInstalledMessage() {
  if (installedMessage) installedMessage.classList.remove("hidden");
}

function isLikelyInstalled() {
  // Heuristic: remember install event; some platforms don’t expose a direct API.
  const flag = localStorage.getItem("pwaInstalled") === "1";
  return flag;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('beforeinstallprompt event fired - install is available');
  if (!isStandalone() && !isLikelyInstalled()) {
    showInstall();
    hideInstalledMessage();
    // Enable the button if it was disabled
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.textContent = 'Instalar';
    }
  }
});

// Log if beforeinstallprompt never fires (for debugging)
// Also ensure button is enabled when it does fire
setTimeout(() => {
  if (!deferredPrompt && !isStandalone() && !isLikelyInstalled()) {
    console.log('beforeinstallprompt event did not fire after 2 seconds - install may not be available yet');
    console.log('This can happen with ngrok or if PWA criteria are not fully met');
    console.log('Checking service worker status...');
    // Check service worker status
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) {
          console.log('Service worker registered:', reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'unknown');
        } else {
          console.log('Service worker not registered yet');
        }
      }).catch(err => console.error('Error checking service worker:', err));
    }
    // Button is already visible, user can try clicking it
  }
}, 2000);

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  hideInstall();
  try {
    localStorage.setItem("pwaInstalled", "1");
  } catch { }
  hideOpen();
  showInstalledMessage();
  // Automatically redirect to app after installation
  // Only redirect if we're on the landing page (index.html)
  if (window.location.pathname === '/' || window.location.pathname.endsWith('index.html')) {
    setTimeout(() => {
      window.location.href = '/app.html';
    }, 500); // Small delay to show the message briefly
  }
});

installBtn?.addEventListener("click", async () => {
  const isLandingPage = window.location.pathname === '/' || window.location.pathname.endsWith('index.html');
  
  if (!deferredPrompt) {
    console.warn('Install prompt not available yet. Waiting for beforeinstallprompt event...');
    // Show a message to the user
    const originalText = installBtn?.textContent || 'Instalar';
    if (installBtn) {
      installBtn.textContent = 'Aguardando...';
      installBtn.disabled = true;
    }
    // Wait a bit and check again
    setTimeout(() => {
      if (!deferredPrompt) {
        if (installBtn) {
          installBtn.textContent = originalText;
          installBtn.disabled = false;
        }
        alert('A instalação pode não estar disponível ainda. Tente recarregar a página ou use o menu do navegador para instalar.');
      }
    }, 2000);
    return;
  }
  
  try {
    hideInstall();
    await deferredPrompt.prompt();
    const choiceResult = await deferredPrompt.userChoice;
    console.log('User choice:', choiceResult.outcome);
    
    // If user accepted installation, redirect to app
    // The appinstalled event will also fire, but this handles the redirect immediately
    if (choiceResult.outcome === 'accepted') {
      if (isLandingPage) {
        setTimeout(() => {
          window.location.href = '/app.html';
        }, 500);
      }
    } else {
      // User dismissed, show install button again
      showInstall();
    }
  } catch (error) {
    console.error('Error showing install prompt:', error);
    // Show button again on error
    showInstall();
  } finally {
    deferredPrompt = null;
  }
});

// Initial UI state
// Show install button by default if not installed, hide it if installed
if (isStandalone()) {
  hideInstall();
  hideOpen();
  showInstalledMessage();
} else if (isLikelyInstalled()) {
  hideInstall();
  hideOpen();
  showInstalledMessage();
} else {
  // Not installed - show install button by default
  // It will be enabled when beforeinstallprompt fires
  showInstall();
  hideOpen();
  hideInstalledMessage();
}

// Auto-reload once when the new SW takes control.
let reloadedForUpdate = false;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (reloadedForUpdate) return;
  reloadedForUpdate = true;
  window.location.reload();
});

// In-app update prompt
function showUpdatePrompt(reg) {
  // If there is no waiting worker, nothing to do
  const waiting = reg.waiting;
  if (!waiting) return;

  // Create a simple banner.
  const banner = document.createElement("div");
  banner.setAttribute("role", "status");
  banner.className =
    "fixed inset-x-0 bottom-0 z-50 mx-auto mb-3 w-fit max-w-full rounded-xl bg-slate-900 text-slate-100 border border-white/10 shadow-2xl px-4 py-2 flex items-center gap-3";
  banner.innerHTML =
    '<span class="text-sm">Uma atualização está disponível.</span>';

  const updateBtn = document.createElement("button");
  updateBtn.className =
    "px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm";
  updateBtn.textContent = "Atualizar agora";

  const dismissBtn = document.createElement("button");
  dismissBtn.className =
    "px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm";
  dismissBtn.textContent = "Depois";

  banner.appendChild(updateBtn);
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);

  const cleanup = () => {
    banner.remove();
  };

  // If the waiting worker changes state (e.g., becomes redundant), remove banner.
  waiting.addEventListener("statechange", () => {
    if (waiting.state === "redundant") cleanup();
  });

  updateBtn.addEventListener("click", () => {
    try {
      waiting.postMessage("skipWaiting");
    } catch { }
    // Banner will be removed after controllerchange reload
  });
  dismissBtn.addEventListener("click", cleanup);
}

// Proactively check for updates and activate them.
if ("serviceWorker" in navigator) {
  // Ensure there is a registration and force an update on open
  navigator.serviceWorker.register("/sw.js").catch(() => { });
  const withReg = async (cb) => {
    try {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) reg = await navigator.serviceWorker.ready;
      if (reg) cb(reg);
    } catch { }
  };

  withReg((reg) => {
    // Try to fetch the latest SW.
    reg.update().catch(() => { });

    // If an update is already waiting, prompt the user
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdatePrompt(reg);
    }

    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          // New update installed, prompt to activate
          showUpdatePrompt(reg);
        }
      });
    });

    // Periodically check for updates when visible.
    const tryUpdate = () => {
      if (document.visibilityState === "visible") reg.update().catch(() => { });
    };
    const int = setInterval(tryUpdate, 60 * 1000 * 10); // every 10 min
    document.addEventListener("visibilitychange", tryUpdate);
    window.addEventListener("beforeunload", () => clearInterval(int));
  });
}

// Opening behavior: rely on link capturing to route to installed PWA.
openAppBtn?.addEventListener("click", (e) => {
  // Ensure a direct top-level navigation; link capturing opens PWA window
  // if supported and the app is installed. No special handling; let the anchor work.
});
