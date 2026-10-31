import { translate } from "./i18n.js";
type Incident = { name: string; kind: string; at: number };
const preference = 'ans:monitor-notifications';
const cursor = 'ans:monitor-notified-at';
export function notificationsEnabled() {
  try { return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(preference) === 'true'; }
  catch { return false; }
}
export async function enableNotifications() {
  if (typeof Notification === 'undefined' || await Notification.requestPermission() !== 'granted') return false;
  localStorage.setItem(cursor, String(Date.now()));
  localStorage.setItem(preference, 'true');
  return true;
}
export function disableNotifications() { localStorage.removeItem(preference); }
export function notifyIncidents(events: Incident[], labels: Record<string, string>) {
  if (!notificationsEnabled()) return;
  const since = Number(localStorage.getItem(cursor) ?? Date.now());
  const fresh = events.filter(e => e.at > since);
  if (!fresh.length) return;
  // Advance before delivery so a refresh or duplicate status response never repeats an alert.
  localStorage.setItem(cursor, String(Math.max(...fresh.map(e => e.at))));
  for (const e of fresh) {
    new Notification(translate(e.kind === 'changed' ? 'ANS · {name} changed' : e.kind === 'recovered' ? 'ANS · {name} recovered' : 'ANS · {name} ongoing issue', { name: translate(labels[e.name] ?? e.name) }), {
      tag: `${e.name}:${e.kind}:${e.at}`, body: translate('View service status'),
    });
  }
}
