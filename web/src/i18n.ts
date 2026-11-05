/** Chinese entries are available to bilingual consumers; the website defaults to English. */
export const zh: Record<string, string> = {
  'Use "Use default resolver" first, then set your address and primary name again.': '请先点击“使用默认解析器”，然后重新设置地址和主名称。',
  'Go to resolver controls': '前往解析器设置',
};

export const dateLocale = () => "en-US";

/** Translate presentation only; never translate protocol values, wallet aliases or user records. */
export function translate(message: string | undefined, values: Record<string, string | number> = {}, language: 'en' | 'zh' = 'en'): string {
  if (!message) return "";
  return (language === 'zh' ? zh[message] ?? message : message).replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function activityLabel(label: string) {
  for (const action of ["Submit registration", "Complete registration", "Check transaction for", "Retry commit"]) {
    if (label.startsWith(`${action} `)) return translate(`${action} {name}`, { name: label.slice(action.length + 1) });
  }
  return translate(label);
}

/** Chain-second renewal horizon, with aligned English/Chinese copy; zero has no horizon restriction. */
export function renewalWindowHint(seconds: bigint, language: 'en' | 'zh' = 'en'): string {
  if (seconds <= 0n) return '';
  const [unit, size, chinese] = seconds % 31536000n === 0n ? ['year', 31536000n, '年'] as const
    : seconds % 86400n === 0n ? ['day', 86400n, '天'] as const : ['second', 1n, '秒'] as const;
  const count = seconds / size;
  return language === 'zh' ? `到期前 ${count} ${chinese}内可续期`
    : `Renewal opens ${count} ${unit}${count === 1n ? '' : 's'} before expiry`;
}
