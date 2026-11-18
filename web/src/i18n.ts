export const dateLocale = () => "en-US";

/** Interpolate presentation placeholders only; never alter protocol values, wallet aliases or user records. */
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

/** Chain-second renewal horizon in English; zero has no horizon restriction. */
export function renewalWindowHint(seconds: bigint): string {
  if (seconds <= 0n) return '';
  const [unit, size] = seconds % 31536000n === 0n ? ['year', 31536000n] as const
    : seconds % 86400n === 0n ? ['day', 86400n] as const : ['second', 1n] as const;
  const count = seconds / size;
  return `Renewal opens ${count} ${unit}${count === 1n ? '' : 's'} before expiry`;
}
