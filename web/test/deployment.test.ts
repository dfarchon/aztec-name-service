import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentProtocolLabel } from '../src/deployment.ts';
import manifest from '../../deployments/testnet-v6.json' with { type: 'json' };
import { registryProtocol } from '../../sdk/src/core/registry-protocol.ts';
import { articles, articleToMarkdown } from '../src/docs-content.ts';

test('connected manifest class displays matching protocol label, preserving V2–V8 labels', () => {
  const protocol = registryProtocol(manifest.classIds.registry);
  assert.equal(protocol.version, manifest.protocol);
  assert.equal(
    deploymentProtocolLabel({
      deployment: { protocolVersion: protocol.version } as any,
      ...protocol,
    }),
    `V${manifest.protocol}`,
  );
  for (const [version, modular, extended, label] of [
    [2, false, false, 'V2'],
    [3, true, false, 'V3'],
    [3, true, true, 'V4'],
    [5, true, true, 'V5'],
    [6, true, true, 'V6'],
    [8, true, true, 'V8'],
  ] as const) {
    assert.equal(
      deploymentProtocolLabel({
        deployment: { protocolVersion: version } as any,
        modular,
        extended,
      }),
      label,
    );
  }
});
test('token website and Markdown exports explain the funding boundary in English', () => {
  const tokens = articles.find((a) => a.id === 'tokens')!;
  const markdown = articleToMarkdown(tokens);
  assert.doesNotMatch(markdown, /TODO|\p{Script=Han}/u);
  assert.ok(markdown.includes(manifest.feeToken));
  // The live test Registrar is free: the guide must not send readers looking for a token or faucet.
  assert.equal(manifest.feeTokenSource, 'none');
  assert.match(markdown, /You need no token to register/);
  assert.match(markdown, /needs no faucet, balance or request channel/);
});
