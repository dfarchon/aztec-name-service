export const dateLocale = () => "en-US";

/** Translate presentation only; never translate protocol values, wallet aliases or user records. */
export function translate(message: string | undefined, values: Record<string, string | number> = {}): string {
  if (!message) return "";
  return message.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function activityLabel(label: string) {
  for (const action of ["Submit registration", "Complete registration", "Check transaction for", "Retry commit"]) {
    if (label.startsWith(`${action} `)) return translate(`${action} {name}`, { name: label.slice(action.length + 1) });
  }
  return translate(label);
}
