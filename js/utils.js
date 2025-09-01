
export const now = () => Date.now();
export function pad2(n){ return n < 10 ? '0'+n : ''+n; }
export function fmtMMSS(sec){ sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec/60), s = sec % 60; return `${pad2(m)}:${pad2(s)}`; }
export function parseTimeToSeconds(hms){
  const p = (hms || '').split(':').map(s => s.trim());
  if (p.length !== 3) throw new Error(`Duração inválida: "${hms}"`);
  const [h,m,s] = p.map(Number);
  if ([h,m,s].some(Number.isNaN)) throw new Error(`Números de duração inválidos: "${hms}"`);
  return h*3600 + m*60 + s;
}
