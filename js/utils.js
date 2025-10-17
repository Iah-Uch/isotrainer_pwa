// Module: Small helpers for time and formatting.
export const now = () => Date.now();

export function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

export function fmtMMSS(sec) {
  const clamped = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function parseTimeToSeconds(hms) {
  const parts = (hms || '').split(':').map((s) => s.trim());
  if (parts.length !== 3) throw new Error(`Duração inválida: "${hms}"`);
  const [h, m, s] = parts.map(Number);
  if ([h, m, s].some(Number.isNaN))
    throw new Error(`Números de duração inválidos: "${hms}"`);
  return h * 3600 + m * 60 + s;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
