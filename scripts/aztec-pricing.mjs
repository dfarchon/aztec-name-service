// Product denomination is separate from the active Registrar's on-chain payment asset.
export const AZTEC_L1_TOKEN = '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2';

export function validateAztecPricing(policy) {
  if (policy.currency !== 'AZTEC' || policy.decimals !== 18 ||
      policy.referenceAsset?.chainId !== '1' ||
      policy.referenceAsset?.address?.toLowerCase() !== AZTEC_L1_TOKEN)
    throw new Error('Pricing must identify the official Ethereum AZTEC token with 18 decimals');
  if (typeof policy.annualPrice !== 'string' || !/^[1-9][0-9]*$/.test(policy.annualPrice) || BigInt(policy.annualPrice) > 2n ** 96n)
    throw new Error('Annual price must be a positive decimal string within the Registrar 2^96 limit');
  const tier = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= 2n ** 96n;
  if (!tier(policy.lengthPrices?.['3']) || !tier(policy.lengthPrices?.['4']) ||
      BigInt(policy.lengthPrices['3']) < BigInt(policy.lengthPrices['4']) ||
      BigInt(policy.lengthPrices['4']) < BigInt(policy.annualPrice))
    throw new Error('3- and 4-character prices must be decimal strings within 2^96, priced at or above longer names');
  if (!['provisional', 'confirmed'].includes(policy.annualPriceStatus))
    throw new Error('Annual price must state whether its amount is provisional or confirmed');
  if (policy.operations?.length !== 2 || !policy.operations.includes('register') || !policy.operations.includes('renew'))
    throw new Error('AZTEC pricing applies to both registration and renewal');
  // A ticker, a padded L1 address or the protocol Fee Juice address is not proof of a transferable L2 asset.
  // Until a bridge/payment integration is independently verified, this policy cannot supply deployable args.
  if (policy.settlement?.status !== 'unconfigured' || policy.settlement?.l2Token !== null)
    throw new Error('AZTEC settlement is not implemented; do not configure an unverified L2 token');
  return policy;
}

/** `length` is the label length; 3 and 4 characters use their own tier, longer names the base price. */
export function aztecPriceForYears(policy, years, length = 5) {
  validateAztecPricing(policy);
  if (!Number.isInteger(years) || years < 1 || years > 5) throw new Error('Choose one to five whole years');
  if (!Number.isInteger(length) || length < 3 || length > 31) throw new Error('Names have 3 to 31 characters');
  const annual = length === 3 ? policy.lengthPrices['3'] : length === 4 ? policy.lengthPrices['4'] : policy.annualPrice;
  return BigInt(annual) * BigInt(years);
}

export function createAztecPricingPlan(policy, active) {
  validateAztecPricing(policy);
  if (!Number.isInteger(active.priceVersion) || active.priceVersion < 1 || active.priceVersion >= 2 ** 32 - 1)
    throw new Error('Cannot prepare a replacement price version');
  return {
    status: 'awaiting_aztec_settlement',
    readyForDeployment: false,
    targetPricing: policy,
    currentOnChain: active,
    replacementRegistrar: {
      registry: active.registry,
      feeToken: null,
      treasury: active.treasury,
      annualPrice: policy.annualPrice,
      lengthPrices: policy.lengthPrices,
      priceVersion: active.priceVersion + 1,
    },
    blockers: [
      ...(policy.annualPriceStatus === 'provisional' ? ['Annual amount is provisional; currency has been selected by the user.'] : []),
      'A transferable AZTEC payment asset and its backing/bridge must be verified on the target network.',
      'Deploy a tiered Registrar (NameRegistrarTiered) bound to the current registry, configure it as administrator and verify exact debit/credit.',
    ],
    broadcastTransactions: 0,
  };
}

/** Display metadata only. A free launch still obtains its executable quote from the active Registrar. */
export function launchDisplayPrice(policy) {
  if(policy.launchDisplay?.mode!=='free'||policy.launchDisplay?.annualPrice!=='0') throw new Error('Invalid free launch display mode');
  return {label:'Free',annualPrice:0n,leaseSeconds:31536000n};
}
