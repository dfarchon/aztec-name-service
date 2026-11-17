/** Chinese entries are available to bilingual consumers; the website defaults to English. */
export const zh: Record<string, string> = {
  'Core upgrade status unavailable. Refresh before signing.': '核心升级状态不可用，请刷新后再签名。',
  "Core upgrade": "核心升级",
  "Trusted single administrator. Core changes wait 24 hours plus 24 protocol hours. Module changes remain immediate. Rollback preserves writes.": "信任单一管理员。核心变更需等待应用层 24 小时及协议层 24 小时。模块变更仍立即生效。回滚保留已写入的业务状态。",
  "Current class": "当前合约类",
  "Snapshot block": "快照区块",
  "Upgrade nonce": "升级操作序号",
  "Proposal ready": "提案可执行时间",
  "Protocol activation": "协议激活时间",
  "Exact reviewed target class": "已审核的精确目标类 ID",
  "Release sequence": "发布序号",
  "Approve reviewed release": "批准已审核发布",
  "Approve directed edge pair": "批准双向升级边",
  "Revoke release": "撤销发布批准",
  "Revoke directed edge": "撤销有向升级边",
  "Propose upgrade or rollback": "提议升级或回滚",
  "Execute stored proposal": "执行已保存提案",
  "Cancel proposal": "取消提案",
  "Cancel before activation": "激活前取消",
  "Next administrator": "下一任管理员",
  "Nominate administrator": "提名管理员",
  "Accept administrator nomination": "接受管理员提名",

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
