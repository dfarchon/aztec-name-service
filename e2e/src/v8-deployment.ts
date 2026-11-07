import assert from 'node:assert/strict';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';

/** Bind the public initializer's sender into the instance preimage. Never use universal deployment. */
export function v8BoundDeployment(owner: AztecAddress): { deployer: AztecAddress } {
  assert(!owner.isZero(), 'V8 initializer requires a nonzero bound deployer/owner');
  return { deployer: owner };
}

/** Required after tracking deployment, before bootstrap or any further operator transaction. */
export function assertV8DeploymentOwner(owner: AztecAddress, instanceDeployer: AztecAddress, administrator: AztecAddress | undefined) {
  assert(!owner.isZero() && instanceDeployer.equals(owner), 'V8 instance deployer differs from nonzero owner');
  assert(administrator?.equals(owner), 'V8 initialized administrator differs from bound owner');
}
