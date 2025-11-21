/**
 * PWA Installation Handler
 * Chromium-focused implementation
 */

class PWAInstallManager {
  constructor() {
    this.deferredPrompt = null;
    this.installButton = null;
    this.installedMessage = null;
    this.openAppButton = null;
    
    // Bind methods
    this.handleBeforeInstallPrompt = this.handleBeforeInstallPrompt.bind(this);
    this.handleAppInstalled = this.handleAppInstalled.bind(this);
    this.handleInstallClick = this.handleInstallClick.bind(this);
    
    this.init();
  }

  init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setup());
    } else {
      this.setup();
    }
  }

  setup() {
    // Check if running in standalone mode on landing page - redirect immediately
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                        window.navigator.standalone === true;
    const isLandingPage = window.location.pathname === '/' || 
                         window.location.pathname.endsWith('index.html');
    
    if (isStandalone && isLandingPage) {
      // PWA opened in standalone mode on landing page - redirect to app
      window.location.replace('/app.html');
      return;
    }

    // Get UI elements
    this.installButton = document.getElementById('installBtn');
    this.installedMessage = document.getElementById('installedMessage');
    this.openAppButton = document.getElementById('openAppBtn');

    // Set up event listeners immediately (only once)
    if (!window.__pwaListenersAttached) {
      window.addEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
      window.addEventListener('appinstalled', this.handleAppInstalled);
      window.__pwaListenersAttached = true;
    }

    // Check initial state
    this.updateUI();
  }

  updateUI() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                        window.navigator.standalone === true;
    
    // If in standalone mode, definitely installed
    if (isStandalone) {
      try {
        localStorage.setItem('pwa-installed', 'true');
      } catch {}
      this.showInstalledState();
      return;
    }

    // Not in standalone mode
    // If install prompt is available → NOT installed → show install button
    if (this.deferredPrompt) {
      this.showInstallButton();
      if (this.installButton) {
        this.installButton.disabled = false;
        this.installButton.textContent = 'Instalar';
      }
      return;
    }

    // No prompt available - check if we have install flag
    try {
      const hasInstallFlag = localStorage.getItem('pwa-installed') === 'true';
      if (hasInstallFlag) {
        // Have flag, no prompt → installed, viewing in browser → show message
        this.showInstalledState();
      } else {
        // No flag, no prompt → wait for prompt → hide button
        this.hideInstallButton();
      }
    } catch {
      // Error accessing localStorage → hide button
      this.hideInstallButton();
    }
  }

  handleBeforeInstallPrompt(e) {
    console.log('[PWA] beforeinstallprompt event fired');
    
    // Prevent the mini-infobar from appearing
    e.preventDefault();
    
    // Stash the event so it can be triggered later
    this.deferredPrompt = e;
    
    // Install prompt available = app is NOT installed
    // Clear any stale install flag
    try {
      localStorage.removeItem('pwa-installed');
    } catch {}
    
    // Show install button
    this.showInstallButton();
    
    // Update button state
    if (this.installButton) {
      this.installButton.disabled = false;
      this.installButton.textContent = 'Instalar';
    }
  }

  async handleInstallClick() {
    if (!this.deferredPrompt) {
      console.warn('[PWA] Install prompt not available');
      return;
    }

    try {
      // Show the install prompt
      this.deferredPrompt.prompt();

      // Wait for the user to respond to the prompt
      const { outcome } = await this.deferredPrompt.userChoice;
      
      console.log(`[PWA] User response to install prompt: ${outcome}`);
      
      // Clear the deferredPrompt
      this.deferredPrompt = null;
      
      // Hide the install button
      this.hideInstallButton();

      if (outcome === 'accepted') {
        // Mark as installed
        try {
          localStorage.setItem('pwa-installed', 'true');
        } catch {}
        
        // Update UI to show installed message
        this.updateUI();
        
        // Redirect to app on desktop only (mobile should not redirect)
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                        (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
        const isLandingPage = window.location.pathname === '/' || 
                             window.location.pathname.endsWith('index.html');
        
        if (isLandingPage && !isMobile) {
          // Desktop: redirect to app after installation
          setTimeout(() => {
            window.location.href = '/app.html';
          }, 500);
        }
      }
    } catch (error) {
      console.error('[PWA] Error showing install prompt:', error);
      this.deferredPrompt = null;
      this.hideInstallButton();
    }
  }

  handleAppInstalled() {
    // Prevent double handling
    if (this._appInstalledHandled) {
      return;
    }
    this._appInstalledHandled = true;
    
    console.log('[PWA] App installed');
    
    // Clear deferred prompt
    this.deferredPrompt = null;
    
    // Mark as installed
    try {
      localStorage.setItem('pwa-installed', 'true');
    } catch {}
    
    // Update UI
    this.updateUI();
    
    // Redirect to app on desktop only (mobile should not redirect)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                    (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const isLandingPage = window.location.pathname === '/' || 
                         window.location.pathname.endsWith('index.html');
    
    if (isLandingPage && !isMobile) {
      // Desktop: redirect to app after installation
      setTimeout(() => {
        window.location.href = '/app.html';
      }, 500);
    }
  }

  showInstallButton() {
    if (this.installButton) {
      this.installButton.classList.remove('hidden');
      // Set up click handler if not already set
      if (!this.installButton.hasAttribute('data-handler-attached')) {
        this.installButton.addEventListener('click', this.handleInstallClick);
        this.installButton.setAttribute('data-handler-attached', 'true');
      }
    }
    if (this.installedMessage) {
      this.installedMessage.classList.add('hidden');
    }
    if (this.openAppButton) {
      this.openAppButton.classList.add('hidden');
    }
  }

  hideInstallButton() {
    if (this.installButton) {
      this.installButton.classList.add('hidden');
    }
  }

  showInstalledState() {
    if (this.installButton) {
      this.installButton.classList.add('hidden');
    }
    if (this.openAppButton) {
      this.openAppButton.classList.add('hidden');
    }
    if (this.installedMessage) {
      this.installedMessage.classList.remove('hidden');
    }
  }
}

// Initialize PWA install manager immediately (only once)
if (typeof window !== 'undefined' && !window.pwaInstallManager) {
  window.pwaInstallManager = new PWAInstallManager();
}
