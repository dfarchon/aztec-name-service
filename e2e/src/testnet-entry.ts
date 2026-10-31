// Keep the established npm entrypoint while selecting an explicit protocol acceptance flow.
import deployment from '../../deployments/testnet.json' with {type:'json'};
import { selectTestnetProtocol, selectTestnetScenario } from './testnet-protocol.js';
const protocol = selectTestnetProtocol(process.env.ANS_TESTNET_PROTOCOL, process.argv.slice(2));
const scenario = selectTestnetScenario(process.env.ANS_TESTNET_SCENARIO, protocol);
if (scenario === 'registration') {
  if (String(deployment.protocol) !== protocol) throw new Error('Registration scenario must match the published deployment protocol');
  await import('./testnet-registration-flow.js');
}
else if (protocol === '5') await import('./testnet-v5.js');
else if (protocol === '4') await import('./testnet-v4.js');
else await import('./testnet.js');
export {};
