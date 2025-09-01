// Simple controller for the floating action button and menu.
const qs = (s) => document.querySelector(s);
const menu = qs('#fabMenu');
const toggle = qs('#fabToggle');

function openMenu(){ if (!menu) return; menu.classList.remove('hidden'); toggle?.setAttribute('aria-expanded','true'); }
function closeMenu(){ if (!menu) return; menu.classList.add('hidden'); toggle?.setAttribute('aria-expanded','false'); }
function toggleMenu(){ if (!menu) return; menu.classList.toggle('hidden'); toggle?.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true'); }

// MINIMAL FIX: call modal directly instead of clicking hidden button
const forward = {
  'play-pause': () => qs('#playPauseBtn')?.click(),
  'controls':   () => { const m = qs('#controlsModal'); if (m) m.classList.remove('hidden'); },
  'back':       () => qs('#backButton')?.click(),
};

function onMenuClick(e){
  const btn = e.target.closest('.fab-item');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  closeMenu();
  if (act && forward[act]) forward[act]();
}

function onDocClick(e){
  if (!menu || !toggle) return;
  if (e.target === toggle || toggle.contains(e.target)) return;
  if (e.target === menu || menu.contains(e.target)) return;
  closeMenu();
}

toggle?.addEventListener('click', (e)=>{ e.preventDefault(); toggleMenu(); });
menu?.addEventListener('click', onMenuClick);
document.addEventListener('click', onDocClick);
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeMenu(); });
