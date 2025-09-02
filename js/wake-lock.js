// Simple Screen Wake Lock helper
// Requests 'screen' wake lock on first user interaction and keeps it across visibility changes.
// Gracefully no-ops where unsupported.

let wakeLock = null;
let triedOnce = false;

async function requestWakeLock(){
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    triedOnce = true;
    wakeLock.addEventListener?.('release', () => { /* released */ });
  } catch { /* ignore */ }
}

function handleVisibility(){
  if (document.visibilityState === 'visible' && wakeLock) {
    // Re-request if it was lost
    requestWakeLock();
  }
}

export function enableWakeLock(){
  if (triedOnce) return;
  // Try immediately; if UA requires a gesture, also hook first interaction
  requestWakeLock();
  const once = () => { requestWakeLock(); document.removeEventListener('click', once, true); };
  document.addEventListener('click', once, true);
  document.addEventListener('visibilitychange', handleVisibility);
}

