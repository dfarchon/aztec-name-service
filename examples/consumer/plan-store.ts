import {
  seal,
  unseal,
  registrationPlanKey,
  type RegistrationPlan,
  type RegistrationPlanStore,
  type Sealed,
} from '@ans/sdk';

/** Encryption and storage errors propagate; never replace an unreadable plan. */
export function encryptedPlanStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'length' | 'key'>,
  passphrase: string,
  scope: string,
): RegistrationPlanStore & { list: () => Promise<RegistrationPlan[]> } {
  if (passphrase.length < 8) throw new Error('Use a recovery passphrase of at least 8 characters');
  const prefix = `ans-consumer:v1:${scope}:`;
  async function load(key: string) {
    const value = storage.getItem(prefix + key);
    if (value === null) return undefined;
    const plan = await unseal<RegistrationPlan>(JSON.parse(value) as Sealed, passphrase);
    if (registrationPlanKey(plan) !== key) throw new Error('Stored plan key mismatch');
    return plan;
  }
  return {
    load,
    async save(key, plan) {
      if (storage.getItem(prefix + key) !== null) await load(key);
      storage.setItem(prefix + key, JSON.stringify(await seal(plan, passphrase)));
    },
    async list() {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
        (key): key is string => key !== null && key.startsWith(prefix),
      );
      return Promise.all(keys.map(async (key) => (await load(key.slice(prefix.length)))!));
    },
  };
}
