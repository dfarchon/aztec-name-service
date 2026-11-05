import { Fr } from '@aztec-labs/aztec.js/fields';
import legacy from '../artifacts/read-metadata.json' with { type: 'json' };
import modular from '../artifacts/modular-metadata.json' with { type: 'json' };
import { PROTOCOL_VERSION } from './constants.js';
import { AnsError } from './errors.js';

// Class identity, capabilities and storage layout travel together. No contract artifacts in public reads.
function protocol(
  metadata: { classId: string; storage: Record<string, string> },
  version: number,
  extended = false,
) {
  return {
    classId: metadata.classId,
    version,
    modular: version >= 3,
    extended,
    slots: Object.fromEntries(
      Object.entries(metadata.storage).map(([key, slot]) => [key, { slot: Fr.fromString(slot) }]),
    ),
  };
}

export const registryProtocols = {
  legacy: protocol(legacy, PROTOCOL_VERSION),
  modular: protocol(modular.registry, 3),
  upgraded: protocol(modular.upgradeTest, 3),
  extended: protocol(modular.extended, 3, true),
  current: protocol(modular.current, 5, true),
  v6: protocol(modular.v6, 6, true),
  v7: protocol(modular.v7, 7, true),
};

const byClass = new Map(Object.values(registryProtocols).map((p) => [p.classId, p]));
export function registryProtocol(classId: string) {
  const result = byClass.get(classId);
  if (!result)
    throw new AnsError('wrong_deployment', 'contract class does not match this SDK version');
  return result;
}
