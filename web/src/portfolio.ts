import { normalizeName } from '@ans/sdk/read';
export function favoriteKey(chain: bigint, registry: string) { return `ans:favorites:v1:${chain}:${registry}`; }
export function readFavorites(key: string): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string').slice(0, 200).filter(v => { try { return normalizeName(v, { allowSubnames: true }).label === v; } catch { return false; } }))] : [];
  } catch { return []; }
}
export function toggleFavorite(key: string, name: string) {
  const valid = normalizeName(name, { allowSubnames: true }).label, old = readFavorites(key);
  const next = old.includes(valid) ? old.filter(n => n !== valid) : [...old.slice(-199), valid];
  localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new Event('ans:favorites')); return next;
}
const escapeIcs = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const timestamp = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/** Stable UID updates an imported reminder when the lease changes. All times are UTC. */
export function expiryCalendar(names: { name: string; expiresAt: bigint }[], scope: string, now = BigInt(Math.floor(Date.now() / 1000))) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ANS//Name expiry//EN', 'CALSCALE:GREGORIAN'];
  for (const item of names) {
    const name = normalizeName(item.name, { allowSubnames: true }).label;
    if (item.expiresAt <= 0n) continue;
    lines.push('BEGIN:VEVENT', `UID:${encodeURIComponent(scope)}-${name}@ans`, `DTSTAMP:${timestamp(now)}`, `DTSTART:${timestamp(item.expiresAt)}`, `DTEND:${timestamp(item.expiresAt + 3600n)}`, `SUMMARY:${escapeIcs(`Renew ${name}`)}`, 'DESCRIPTION:Open ANS to verify the current lease before renewal. Subnames are renewed by their parent owner.', 'BEGIN:VALARM', 'TRIGGER:-P30D', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcs(`Review ${name} expiry`)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 folds at 75 octets. Generated fields are ASCII after normalization/encoding.
  return lines.map(line => line.match(/.{1,74}/g)?.join('\r\n ') ?? '').join('\r\n') + '\r\n';
}
export function downloadCalendar(names: { name: string; expiresAt: bigint }[], scope: string) {
  const url = URL.createObjectURL(new Blob([expiryCalendar(names, scope)], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'ans-renewals.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
