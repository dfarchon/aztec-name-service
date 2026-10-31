/** Reject a typo before loading a runner, since loading it can initialize wallets and broadcast transactions. */
export function selectTestnetProtocol(value: string | undefined, args: string[]): '2' | '4' | '5' {
  if (value !== undefined && value !== '2' && value !== '4' && value !== '5') throw new Error('ANS_TESTNET_PROTOCOL must be 2, 4 or 5');
  if (args.some(arg => arg !== '--v4' && arg !== '--v5')) throw new Error('Only --v4 or --v5 is supported by the testnet runner');
  const flags = new Set(args);
  if (flags.size > 1) throw new Error('Protocol flags conflict');
  const selected = flags.has('--v5') ? '5' : flags.has('--v4') ? '4' : undefined;
  if (selected && value !== undefined && value !== selected) throw new Error('Protocol flag conflicts with ANS_TESTNET_PROTOCOL');
  return selected ?? value ?? '5';
}

/** New registration acceptance uses the configured deployment, never a replacement deployment. */
export function selectTestnetScenario(value: string | undefined, protocol: '2' | '4' | '5'): 'deployment' | 'registration' {
  if (value === undefined || value === 'deployment') return 'deployment';
  if (value !== 'registration') throw new Error('ANS_TESTNET_SCENARIO must be deployment or registration');
  if (protocol !== '4' && protocol !== '5') throw new Error('Registration acceptance requires ANS_TESTNET_PROTOCOL=4 or 5');
  return 'registration';
}
