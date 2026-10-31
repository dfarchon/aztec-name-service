import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
let source = await readFile(new URL('contracts/name_registry_v3/src/main.nr', root), 'utf8');
const replace = (from, to) => { if (!source.includes(from)) throw new Error(`Missing V4 patch anchor: ${from}`); source = source.replace(from, to); };
replace('pub contract NameRegistryV3 {', `pub contract NameRegistryV4 {
    use crate::types::{ParentLink, TransferOffer, TextValue};
    use aztec::protocol::hash::poseidon2_hash_with_separator;
    use ans_common::logic::{DOMAIN_LABEL_V1, DOMAIN_NODE_V1};`);
replace('protocol_upgrade: PublicMutable<Upgrade, Context>,', `protocol_upgrade: PublicMutable<Upgrade, Context>,
        parents: Map<Field, PublicMutable<ParentLink, Context>, Context>,
        managers: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        transfers: Map<Field, PublicMutable<TransferOffer, Context>, Context>,
        text_values: Map<Field, PublicMutable<TextValue, Context>, Context>,
        text_count: Map<Field, PublicMutable<u32, Context>, Context>,
        text_keys: Map<Field, PublicMutable<Field, Context>, Context>,
        text_seen: Map<Field, PublicMutable<bool, Context>, Context>,`);
replace('assert_holder_active(meta, stored, self.context.timestamp(), generation, expected_revision, owner);', 'self.internal.assert_editor(AztecAddress::from_field(owner), node, generation, expected_revision);');
replace('        let stored = self.storage.owners.at(node).read();\n', '');
replace('assert(now < meta.expires_at + GRACE_PERIOD, "name not renewable");', `assert(now < meta.expires_at + GRACE_PERIOD, "name not renewable");
        assert(self.storage.parents.at(node).read().parent == 0, "subname lease is controlled by parent");`);
replace('assert(is_active(meta, self.context.timestamp()), "name not active");', 'assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");');
replace('expires_at: meta.expires_at,\n        }\n    }', 'expires_at: self.internal.live_expiry(node),\n        }\n    }');
replace('assert(self.storage.allowed_resolvers.at(resolver).read(), "resolver not approved");', `assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        assert(self.storage.allowed_resolvers.at(resolver).read(), "resolver not approved");`);
replace('fn implementation_version() -> u32 { 1 }', 'fn implementation_version() -> u32 { 4 }');
const extensions = await readFile(new URL('contracts/name_registry_v4/src/extensions.nr.inc', root), 'utf8');
source = 'mod types;\nmod test;\n// Generated from V3 by scripts/sync-v4.mjs. Edit the extension source or generator.\n' + source.trimEnd().slice(0,-1) + extensions + '}\n';
await writeFile(new URL('contracts/name_registry_v4/src/main.nr', root), source);
