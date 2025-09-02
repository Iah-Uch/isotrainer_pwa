// Minimal QR scanning that feeds the plan textarea (#csvInput)
// Requires the global QrScanner from https://unpkg.com/qr-scanner
// Ensure worker path is explicitly set to avoid cross-origin base URL issues
try{
  // eslint-disable-next-line no-undef
  if (typeof QrScanner !== 'undefined' && QrScanner.WORKER_PATH) {
    // Point to the CDN worker explicitly (served with CORS)
    // If you later self-host it, change to '/js/qr-scanner-worker.min.js'
    // eslint-disable-next-line no-undef
    QrScanner.WORKER_PATH = 'https://unpkg.com/qr-scanner@1.4.2/qr-scanner-worker.min.js';
  }
}catch{}
import { startTrainingFromCsvText } from './main.js';

let qrScanner = null;
let lastText = '';

const el = (id) => document.getElementById(id);

function openQr(){
  const modal = el('qrModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const video = el('qrVideo');
  const hint = el('qrHint');
  const err  = el('qrError');
  const use  = el('qrUseResult');
  const retry= el('qrRetry');

  lastText = '';
  if (use) use.disabled = true; if (retry) retry.disabled = true; if (err) err.classList.add('hidden');

  // Ensure worker path is set before constructing scanner
  try{ /* eslint-disable no-undef */ QrScanner.WORKER_PATH = QrScanner.WORKER_PATH || 'https://unpkg.com/qr-scanner@1.4.2/qr-scanner-worker.min.js'; /* eslint-enable */ }catch{}
  // eslint-disable-next-line no-undef
  qrScanner = new QrScanner(video, (result) => {
    if (!result) return;
    lastText = String(result.data || result).trim();
    // Put the scanned text directly into the textarea and close the modal
    const textarea = el('csvInput');
    if (textarea) textarea.value = lastText;
    // Stop and close immediately after successful scan
    qrScanner?.stop();
    closeQr();
  }, {
    preferredCamera: 'environment',
    highlightScanRegion: true,
    highlightCodeOutline: true,
    maxScansPerSecond: 10
  });

  qrScanner.start().catch(e=>{
    if (err){ err.textContent = 'Erro da câmera: ' + (e?.message || e); err.classList.remove('hidden'); }
  });
}

function closeQr(){
  const modal = el('qrModal');
  if (modal){ modal.classList.add('hidden'); modal.classList.remove('flex'); }
  qrScanner?.stop();
  qrScanner?.destroy();
  qrScanner = null;
}

function retryQr(){
  lastText = '';
  const use = el('qrUseResult');
  const retry = el('qrRetry');
  const hint = el('qrHint');
  const err  = el('qrError');
  if (use) use.disabled = true;
  if (retry) retry.disabled = true;
  if (hint) hint.textContent = 'Aponte a câmera para o QR code';
  if (err) err.classList.add('hidden');
  qrScanner?.start().catch(()=>{});
}

function useResult(){
  if (!lastText) return;
  const textarea = el('csvInput');
  if (textarea) textarea.value = lastText;
  closeQr();
  // Use the same flow as "Load Plan & Start"
  startTrainingFromCsvText(lastText);
}

document.getElementById('scanQrBtn')?.addEventListener('click', openQr);
document.getElementById('closeQr')?.addEventListener('click', closeQr);
document.getElementById('qrRetry')?.addEventListener('click', retryQr);
document.getElementById('qrUseResult')?.addEventListener('click', useResult);
