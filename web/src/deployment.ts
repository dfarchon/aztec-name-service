import type { RegistryReader } from '@ans/sdk/read';

/** SDK retains V4 as extended V3 for legacy layout selection; V5/V6 have distinct protocols. */
export function deploymentProtocolLabel(
  reader: Pick<RegistryReader, 'deployment' | 'extended' | 'modular'>,
): string {
  return `V${reader.deployment.protocolVersion >= 5 ? reader.deployment.protocolVersion : reader.extended ? 4 : reader.modular ? 3 : 2}`;
}
