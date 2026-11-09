// Local-only protocol-policy fixtures. Never SDK artifacts or public deployment targets.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
const root = resolve(new URL('../', import.meta.url).pathname);
const output = process.argv[2];
assert(output && isAbsolute(output) && relative(root, output).startsWith('..'), 'fixture directory must be outside repository');
const source = readFileSync(`${root}/contracts/name_registry_v8/src/main.nr`, 'utf8');
const variants = [
  ['next', 'NameRegistryV8NextFixture', source.replace('RELEASE_SEQ: u32 = 1', 'RELEASE_SEQ: u32 = 3').replace('implementation_version() -> u32 { 8 }', 'implementation_version() -> u32 { 8002 }')],
  ['delay', 'NameRegistryV8DelayFixture', source.replace('    #[external("public")]\n    fn settle_upgrade()', `    // Deliberately unsafe local fixture only: actual V8 exposes no delay setter.\n    #[external("public")]\n    fn fixture_set_protocol_delay(delay: u64) {\n        assert(self.msg_sender() == self.storage.administrator.read(), "not administrator");\n        self.call(ContractInstanceRegistry::at(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS).set_update_delay(delay));\n    }\n    #[external("public")]\n    fn settle_upgrade()`)],
];
mkdirSync(output, { recursive: true, mode: 0o700 });
writeFileSync(`${output}/Nargo.toml`, '[workspace]\nmembers = ["next", "delay"]\n');
for (const [pkg, name, code] of variants) {
  mkdirSync(`${output}/${pkg}/src`, { recursive: true, mode: 0o700 });
  writeFileSync(`${output}/${pkg}/src/main.nr`, code.replace('pub contract NameRegistryV8 {', `pub contract ${name} {`));
  for (const file of ['types.nr', 'upgrade_types.nr', 'governance_storage.nr']) writeFileSync(`${output}/${pkg}/src/${file}`, readFileSync(`${root}/contracts/name_registry_v8/src/${file}`));
  writeFileSync(`${output}/${pkg}/Nargo.toml`, `[package]\nname = "v8_${pkg}_fixture"\ntype = "contract"\nauthors = [""]\n[dependencies]\naztec = { git = "https://github.com/aztec-labs-eng/aztec-nr", tag = "v6.0.0", directory = "aztec" }\ncontract_instance_registry = { git = "https://github.com/aztec-labs-eng/aztec-nr", tag = "v6.0.0", directory = "contract-instance-registry-interface" }\nans_common = { path = "${root}/contracts/ans_common" }\nlegacy_registry = { path = "${root}/contracts/name_registry" }\n`);
}
console.log('Prepared local C and protocol-delay-mismatch fixtures outside repository; not deployment profiles');
