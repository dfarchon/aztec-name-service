import { zhCN } from "./locales/zh-CN.js";

export type Locale = "en" | "zh-CN";
const preference = "ans:locale";
const listeners = new Set<() => void>();
const readLocale = (): Locale => {
  try { return localStorage.getItem(preference) === "zh-CN" ? "zh-CN" : "en"; }
  catch { return "en"; }
};
let locale = readLocale();
export const getLocale = () => locale;
export const dateLocale = () => locale === "zh-CN" ? "zh-CN" : "en-US";
export const subscribeLocale = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setLocale(next: Locale) {
  if (next !== "en" && next !== "zh-CN") return;
  locale = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  try { localStorage.setItem(preference, next); } catch { /* The current page remains usable without storage. */ }
  listeners.forEach(listener => listener());
}

/** Translate presentation only; never translate protocol values, wallet aliases or user records. */
export function translate(message: string | undefined, values: Record<string, string | number> = {}): string {
  if (!message) return "";
  const text = locale === "zh-CN" ? (zhCN[message] ?? message) : message;
  return text.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function activityLabel(label: string) {
  for (const action of ["Submit registration", "Complete registration", "Check transaction for", "Retry commit"]) {
    if (label.startsWith(`${action} `)) return translate(`${action} {name}`, { name: label.slice(action.length + 1) });
  }
  return translate(label);
}
