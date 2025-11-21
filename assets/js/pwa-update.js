/**
 * PWA Update Handler
 * Handles service worker updates and prompts user to update
 */

class PWAUpdateManager {
  constructor() {
    this.reloadedForUpdate = false;
    this.init();
  }

  init() {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    // Handle controller change (new service worker activated)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this.reloadedForUpdate) return;
      this.reloadedForUpdate = true;
      window.location.reload();
    });

    // Check for updates
    this.checkForUpdates();
    
    // Check periodically when page is visible
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.checkForUpdates();
      }
    });
  }

  async checkForUpdates() {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;

      // Check for updates
      await registration.update();

      // If there's a waiting worker, show update prompt
      if (registration.waiting && navigator.serviceWorker.controller) {
        this.showUpdatePrompt(registration);
      }

      // Listen for new service worker installing
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            this.showUpdatePrompt(registration);
          }
        });
      });
    } catch (error) {
      console.error('[PWA Update] Error checking for updates:', error);
    }
  }

  showUpdatePrompt(registration) {
    const waiting = registration.waiting;
    if (!waiting) return;

    // Remove existing banner if any
    const existingBanner = document.getElementById('pwa-update-banner');
    if (existingBanner) {
      existingBanner.remove();
    }

    // Create update banner
    const banner = document.createElement('div');
    banner.id = 'pwa-update-banner';
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

    const cleanup = () => {
      banner.remove();
    };

    // Remove banner if worker becomes redundant
    waiting.addEventListener('statechange', () => {
      if (waiting.state === 'redundant') {
        cleanup();
      }
    });

    updateBtn.addEventListener('click', () => {
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        console.error('[PWA Update] Error skipping waiting:', error);
      }
      cleanup();
    });

    dismissBtn.addEventListener('click', cleanup);
  }
}

// Initialize update manager
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.pwaUpdateManager = new PWAUpdateManager();
}

