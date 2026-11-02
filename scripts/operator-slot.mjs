/** Verify precomputed Worker slots using the same 6.0.0 map derivation as the client. */
export async function operatorSlotProblems(configs) {
  const problems = [];
  for (const [name, config] of configs) {
    const operator = config.vars?.OPERATOR;
    if (!operator || operator === 'UNDECIDED') continue;
    try {
      const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
      const { Fr } = await import('@aztec-labs/aztec.js/fields');
      const { deriveStorageSlotInMap } = await import('@aztec-labs/stdlib/hash');
      const expected = await deriveStorageSlotInMap(
        new Fr(1),
        AztecAddress.fromStringUnsafe(operator),
      );
      if (config.vars.OPERATOR_BALANCE_SLOT !== expected.toString())
        problems.push(`${name} OPERATOR_BALANCE_SLOT mismatch`);
    } catch {
      problems.push(`${name} invalid operator configuration`);
    }
  }
  return problems;
}
