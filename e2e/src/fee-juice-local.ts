/** Local-only bridge/claim/deploy acceptance. Private fixtures stay outside the repository. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicClient, http } from 'viem';
import { FeeAssetHandlerAbi } from '@aztec-foundation/l1-artifacts/FeeAssetHandlerAbi';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { TokenContract } from '@aztec-labs/noir-contracts.js/Token';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import { newWallet } from './common.js';
import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { assertV6FeeJuice, assertV6Network } from './v6-network.js';
import { main } from './deploy-v6.js';
import { bridgeMain, initL1Key } from './fee-juice-bridge.js';
import { readPublicKeys } from './init-keys.js';
import { readBridgeClaim, readFeeJuiceBalance } from './fee-juice-payment.js';
async function run() {
  const nodeUrl = 'http://127.0.0.1:8080',
    l1Rpc = 'http://127.0.0.1:8545';
  const node = createAztecNodeClient(nodeUrl);
  const info = await node.getNodeInfo();
  assertV6Network('local', info, nodeUrl);
  assertV6FeeJuice('local', info);
  const stateDir = await mkdtemp(
    join(process.env.ANS_FEE_JUICE_TEST_ROOT ?? tmpdir(), 'ans-fee-juice-local-'),
  );
  await main(['--init-keys', '--network', 'local', '--state-dir', stateDir]);
  const owner = (await readPublicKeys(join(stateDir, 'keys.json'), 'local')).owner;
  const l1Address = await initL1Key(stateDir);
  const l1 = createPublicClient({ transport: http(l1Rpc) });
  assert.equal(await l1.getChainId(), 31337);
  await l1.request({
    method: 'anvil_setBalance' as never,
    params: [l1Address, '0x56bc75e2d63100000'] as never,
  });
  const a = info.l1ContractAddresses;
  const amount = await l1.readContract({
    address: a.feeAssetHandlerAddress!.toString(),
    abi: FeeAssetHandlerAbi,
    functionName: 'mintAmount',
  });
  const confirm = `bridge:local:31337:${a.feeJuicePortalAddress}:${owner}:${amount}`;
  await bridgeMain([
    '--network',
    'local',
    '--state-dir',
    stateDir,
    '--l1-rpc-url',
    l1Rpc,
    '--amount',
    String(amount),
    '--confirm',
    confirm,
  ]);
  const claim = await readBridgeClaim(stateDir, 'local', owner);
  assert(claim?.messageHash);
  // Local sequencers may idle without transactions. Use a separate genesis-funded account
  // to advance actual proven blocks; no FPC and no changes to the fresh deployer's funds.
  const messageHash = Fr.fromString(claim.messageHash);
  if (!(await isL1ToL2MessageReady(node, messageHash, 'proven'))) {
    const padding = await newWallet(node);
    try {
      const [genesis] = await getInitialTestAccountsData();
      const sender = (
        await padding.createSchnorrInitializerlessAccount(
          genesis.secret,
          genesis.salt,
          genesis.signingKey,
        )
      ).address;
      assert(
        (await readFeeJuiceBalance(node, sender)) > 0n,
        'Local genesis account must have Fee Juice',
      );
      const { contract } = await TokenContract.deploy(
        padding,
        sender,
        'Readiness',
        'READY',
        18,
      ).send({ from: sender, wait: { waitForStatus: TxStatus.PROVEN } });
      for (let i = 0; i < 12 && !(await isL1ToL2MessageReady(node, messageHash, 'proven')); i++) {
        await contract.methods
          .mint_to_public(sender, 1n)
          .send({ from: sender, wait: { waitForStatus: TxStatus.PROVEN } });
      }
    } finally {
      await padding.stop();
    }
  }
  await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 60, chainTip: 'proven' });
  await main([
    '--network',
    'local',
    '--fee-payment',
    'fee-juice',
    '--registrar',
    'tiered',
    '--price-version',
    '1',
    '--state-dir',
    stateDir,
  ]);
  const manifest = JSON.parse(await readFile(join(stateDir, 'deployment-v6.json'), 'utf8'));
  assert.equal(manifest.feePayment, 'fee-juice');
  assert.equal(manifest.sponsoredFpc, null);
  const balance = await readFeeJuiceBalance(node, AztecAddress.fromStringUnsafe(owner));
  assert(balance > 0n);
  console.log(
    `PASS local bridge, claim, fee-juice deploy and balance owner=${owner} balance=${balance}`,
  );
}
run().catch(() => {
  console.error(
    'FAIL local Fee Juice acceptance; inspect public receipts and named deployment errors',
  );
  process.exitCode = 1;
});
