import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentProtocolLabel } from '../src/deployment.ts';
import manifest from '../../deployments/testnet-v6.json' with { type: 'json' };
import { registryProtocol } from '../../sdk/src/core/registry-protocol.ts';
import { articles, articleToMarkdown } from '../src/docs-content.ts';

test('connected manifest class displays V6, preserving V2/V3/V4/V5 labels', () => {
  const protocol = registryProtocol(manifest.classIds.registry);
  assert.equal(protocol.version, manifest.protocol);
  assert.equal(
    deploymentProtocolLabel({
      deployment: { protocolVersion: protocol.version } as any,
      ...protocol,
    }),
    'V6',
  );
  for (const [version, modular, extended, label] of [
    [2, false, false, 'V2'],
    [3, true, false, 'V3'],
    [3, true, true, 'V4'],
    [5, true, true, 'V5'],
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
test('token website and Markdown exports use factual bilingual content without TODO', () => {
  const tokens = articles.find((a) => a.id === 'tokens')!;
  for (const lang of [0, 1] as const) {
    const markdown = articleToMarkdown(tokens, lang);
    assert.doesNotMatch(markdown, /TODO|待补充/);
    assert.match(markdown, /mint_to_private/);
    assert.ok(markdown.includes(manifest.feeToken));
    assert.match(markdown, lang ? /没有公开自助水龙头/ : /no public self-serve faucet/);
    assert.match(
      markdown,
      lang
        ? /没有已公布的公开申请渠道/
        : /no public self-serve faucet or published public request channel/,
    );
  }
});
