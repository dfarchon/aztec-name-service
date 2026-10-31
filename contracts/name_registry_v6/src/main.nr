mod types;
mod test;
// Fixed deployment with holder-controlled name operations.
use aztec::macros::aztec;

#[aztec]
pub contract NameRegistryV6 {
    use crate::types::{ParentLink, TransferOffer, TextValue};
    use aztec::protocol::hash::poseidon2_hash_with_separator;
    use ans_common::logic::{DOMAIN_LABEL_V1, DOMAIN_NODE_V1};
    use aztec::{
        context::PublicStaticCall,
        macros::{events::event, functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, traits::{FromField, ToField}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    use ans_common::logic::{
        assert_cleared_record, assert_duration, assert_holder, assert_holder_active,
        GRACE_PERIOD, is_available,
        MAX_COMMIT_AGE, MIN_COMMIT_AGE, node_from_packed,
        pack_label, primary_key, record_key,
    };
    use ans_common::types::{
        AddressRecord, CommitRecord, NameMeta, NameRecord, PrimaryRecord, PublishedLabel, Modules,
    };

    #[event]
    struct NameRegisteredV3 {
        node: Field,
        generation: u32,
        expires_at: u64,
        owner: AztecAddress,
        packed_label: Field,
        label_len: u32,
    }

    #[event]
    struct AddressChangedV3 {
        node: Field,
        generation: u32,
        present: bool,
        addr: AztecAddress,
        binding_version: u32,
        revision: u32,
    }

    #[event]
    struct NameRenewedV3 {
        node: Field,
        generation: u32,
        expires_at: u64,
        revision: u32,
    }

    #[event]
    struct ModulesConfigured { registrar: AztecAddress, resolver: AztecAddress, revision: u32 }

    #[event]
    struct PrimaryChangedV3 {
        address: AztecAddress,
        present: bool,
        node: Field,
        generation: u32,
        binding_version: u32,
    }

    #[storage]
    struct Storage<Context> {
        // Operational configuration authority; no proposal or deferred execution state.
        administrator: PublicMutable<AztecAddress, Context>,
        legacy: PublicImmutable<AztecAddress, Context>,
        modules: PublicMutable<Modules, Context>,
        resolvers: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        names: Map<Field, PublicMutable<NameMeta, Context>, Context>,
        owners: Map<Field, PublicMutable<Field, Context>, Context>,
        commits: Map<Field, PublicMutable<CommitRecord, Context>, Context>,
        records: Map<Field, PublicMutable<AddressRecord, Context>, Context>,
        primary: Map<Field, PublicMutable<PrimaryRecord, Context>, Context>,
        published_labels: Map<Field, PublicMutable<PublishedLabel, Context>, Context>,
        parents: Map<Field, PublicMutable<ParentLink, Context>, Context>,
        managers: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        transfers: Map<Field, PublicMutable<TransferOffer, Context>, Context>,
        text_values: Map<Field, PublicMutable<TextValue, Context>, Context>,
        text_count: Map<Field, PublicMutable<u32, Context>, Context>,
        text_keys: Map<Field, PublicMutable<Field, Context>, Context>,
        text_seen: Map<Field, PublicMutable<bool, Context>, Context>,
        // Two-step administrator transfer: the nominee must accept before authority moves.
        pending_administrator: PublicMutable<AztecAddress, Context>,
    }



    #[external("private")]
    fn commit(c: Field) {
        self.enqueue_self._commit(c);
    }

    #[external("public")]
    #[only_self]
    fn _commit(c: Field) {
        let existing = self.storage.commits.at(c).read();
        // Unknown commitments are recorded; an expired, never-consumed commitment may be refreshed so stale entries are reusable.
        let now = self.context.timestamp();
        let expired_unused = (existing.committed_at != 0) & !existing.consumed & (now - existing.committed_at >= MAX_COMMIT_AGE);
        if (existing.committed_at == 0) | expired_unused {
            self.storage.commits.at(c).write(CommitRecord { committed_at: now, consumed: false });
        }
    }



    #[external("public")]
    fn register_from_registrar(
        node: Field,
        expected_generation: u32,
        owner: Field,
        c: Field,
        duration: u64,
        quote_expiry: u64,
        packed_label: Field,
        label_len: u32,
    ) {
        assert(self.msg_sender() == self.storage.modules.read().registrar, "unauthorized registrar");
        let now = self.context.timestamp();
        assert(now <= quote_expiry, "fee quote expired");
        let bytes = packed_label.to_be_bytes::<32>();
        let mut label = [0 as u8; 31];
        for i in 0..31 { label[i] = bytes[i + 1]; }
        assert(pack_label(label, label_len) == packed_label, "invalid packed label");
        assert(node == node_from_packed(packed_label, label_len), "label node mismatch");
        assert((label_len >= 3) & (label_len <= 31), "invalid label length");

        let commit = self.storage.commits.at(c).read();
        assert(commit.committed_at != 0, "unknown commitment");
        assert(!commit.consumed, "commitment already consumed");
        let age = now - commit.committed_at;
        assert(age >= MIN_COMMIT_AGE, "commitment too young");
        assert(age < MAX_COMMIT_AGE, "commitment expired");

        let meta = self.storage.names.at(node).read();
        assert(meta.generation == expected_generation, "generation mismatch");
        assert(is_available(meta, now), "name not available");
        let legacy = self.storage.legacy.read();
        if (meta.generation == 0) & !legacy.is_zero() {
            let old = self.view(legacy_registry::NameRegistry::at(legacy).get_name(node));
            assert((old.generation == 0) | (now >= old.expires_at + GRACE_PERIOD), "legacy name reserved; migrate first");
        }
        assert_duration(duration);

        let generation = expected_generation + 1;
        let expires_at = now + duration;
        self.storage.names.at(node).write(NameMeta { generation, revision: 0, expires_at });
        assert(owner != 0, "owner required");
        let resolver = self.storage.modules.read().resolver;
        assert(!resolver.is_zero(), "modules not initialized");
        self.storage.resolvers.at(record_key(node, generation, 0)).write(resolver);
        self.storage.owners.at(node).write(owner);
        self.storage.commits.at(c).write(CommitRecord { committed_at: commit.committed_at, consumed: true });
        self.storage.published_labels.at(node).write(PublishedLabel { present: true, packed_label, label_len });
        self.emit(NameRegisteredV3 { node, generation, expires_at, owner: AztecAddress::from_field(owner), packed_label, label_len });
    }



    #[external("public")]
    fn address_from_resolver(
        node: Field,
        generation: u32,
        expected_revision: u32,
        owner: Field,
        present: bool,
        addr: AztecAddress,
    ) {
        assert(self.msg_sender() == self.storage.resolvers.at(record_key(node, generation, 0)).read(), "unauthorized resolver");
        assert_cleared_record(present, addr);
        let meta = self.storage.names.at(node).read();
        self.internal.assert_editor(AztecAddress::from_field(owner), node, generation, expected_revision);
        self.internal.apply_address(node, meta, present, addr);
    }



    #[external("public")]
    fn renew_from_registrar(
        node: Field,
        generation: u32,
        expected_revision: u32,
        owner: Field,
        duration: u64,
        quote_expiry: u64,
    ) {
        assert(self.msg_sender() == self.storage.modules.read().registrar, "unauthorized registrar");
        let now = self.context.timestamp();
        assert(now <= quote_expiry, "fee quote expired");
        let meta = self.storage.names.at(node).read();
        assert_holder(meta, self.storage.owners.at(node).read(), generation, expected_revision, owner);
        assert(now < meta.expires_at + GRACE_PERIOD, "name not renewable");
        assert(self.storage.parents.at(node).read().parent == 0, "subname lease is controlled by parent");
        assert_duration(duration);

        let base = if meta.expires_at > now { meta.expires_at } else { now };
        let expires_at = base + duration;
        let revision = meta.revision + 1;
        self.storage.names.at(node).write(NameMeta { generation, revision, expires_at });
        self.emit(NameRenewedV3 { node, generation, expires_at, revision });
    }

    #[external("private")]
    fn set_primary(node: Field, generation: u32, binding_version: u32) {
        self.enqueue_self._set_primary(self.msg_sender(), node, generation, binding_version);
    }

    #[external("public")]
    #[only_self]
    fn _set_primary(address: AztecAddress, node: Field, generation: u32, binding_version: u32) {
        let meta = self.storage.names.at(node).read();
        assert(meta.generation == generation, "generation mismatch");
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");

        let forward = self.storage.records.at(record_key(node, generation, 0)).read();
        assert(forward.present & (forward.addr == address), "forward record does not point to caller");
        assert(forward.binding_version == binding_version, "binding version mismatch");

        self.storage.primary.at(primary_key(0, address)).write(PrimaryRecord {
            present: true,
            node,
            generation,
            binding_version,
        });
        self.emit(PrimaryChangedV3 { address, present: true, node, generation, binding_version });
    }

    #[external("private")]
    fn clear_primary() {
        self.enqueue_self._clear_primary(self.msg_sender());
    }

    #[external("public")]
    #[only_self]
    fn _clear_primary(address: AztecAddress) {
        self.storage.primary.at(primary_key(0, address)).write(PrimaryRecord {
            present: false,
            node: 0,
            generation: 0,
            binding_version: 0,
        });
        self.emit(PrimaryChangedV3 { address, present: false, node: 0, generation: 0, binding_version: 0 });
    }



    #[external("public")]
    #[view]
    fn get_name(node: Field) -> NameRecord {
        let meta = self.storage.names.at(node).read();
        NameRecord {
            generation: meta.generation,
            owner: AztecAddress::from_field(self.storage.owners.at(node).read()),
            revision: meta.revision,
            expires_at: self.internal.live_expiry(node),
        }
    }

    #[external("public")]
    #[view]
    fn get_address(node: Field, generation: u32) -> AddressRecord {
        self.storage.records.at(record_key(node, generation, 0)).read()
    }

    #[external("public")]
    #[view]
    fn get_primary(address: AztecAddress) -> PrimaryRecord {
        self.storage.primary.at(primary_key(0, address)).read()
    }

    #[external("public")]
    #[view]
    fn get_published_label(node: Field) -> PublishedLabel {
        self.storage.published_labels.at(node).read()
    }

    #[external("public")]
    #[view]
    fn get_commit(c: Field) -> CommitRecord {
        self.storage.commits.at(c).read()
    }

    #[external("public")]
    #[view]
    fn now() -> u64 {
        self.context.timestamp()
    }

    #[external("utility")]
    unconstrained fn node_of(label: [u8; 31], len: u32) -> Field {
        node_from_packed(pack_label(label, len), len)
    }





    #[internal("public")]
    fn apply_address(node: Field, meta: NameMeta, present: bool, addr: AztecAddress) {
        let generation = meta.generation;
        let key = record_key(node, generation, 0);
        let binding_version = self.storage.records.at(key).read().binding_version + 1;
        self.storage.records.at(key).write(AddressRecord { present, addr, binding_version });

        let revision = meta.revision + 1;
        self.storage.names.at(node).write(
            NameMeta { generation, revision, expires_at: meta.expires_at },
        );
        self.emit(AddressChangedV3 { node, generation, present, addr, binding_version, revision });
    }


    #[event]
    struct ModulesInitialized { registrar: AztecAddress, resolver: AztecAddress }
    #[event]
    struct ResolverChanged { node: Field, generation: u32, resolver: AztecAddress }
    #[event]
    struct AdministratorNominated { administrator: AztecAddress }

    #[event]
    struct AdministratorTransferred { previous: AztecAddress, administrator: AztecAddress }

    #[event]
    struct NameMigrated { node: Field, legacy: AztecAddress, generation: u32 }

    #[external("public")]
    #[initializer]
    fn constructor(legacy: AztecAddress) {
        self.storage.administrator.write(self.msg_sender());
        self.storage.legacy.initialize(legacy);
    }

    #[external("public")]
    fn bootstrap(registrar: AztecAddress, resolver: AztecAddress) {
        assert(self.msg_sender() == self.storage.administrator.read(), "not administrator");
        assert(self.storage.modules.read().revision == 0, "already initialized");
        assert(!registrar.is_zero() & !resolver.is_zero(), "module required");
        self.internal.assert_module(registrar);
        self.internal.assert_module(resolver);
        self.storage.modules.write(Modules { registrar, resolver, revision: 1 });
        self.emit(ModulesInitialized { registrar, resolver });
    }

    #[external("public")]
    fn configure_modules(expected_revision: u32, registrar: AztecAddress, resolver: AztecAddress) {
        assert(self.msg_sender() == self.storage.administrator.read(), "not administrator");
        let modules = self.storage.modules.read();
        assert(modules.revision > 0, "modules not initialized");
        assert(modules.revision == expected_revision, "revision mismatch");
        assert(!registrar.is_zero() & !resolver.is_zero(), "module required");
        self.internal.assert_module(registrar);
        self.internal.assert_module(resolver);
        self.storage.modules.write(Modules { registrar, resolver, revision: modules.revision + 1 });
        self.emit(ModulesConfigured { registrar, resolver, revision: modules.revision + 1 });
    }

    #[external("public")]
    fn nominate_administrator(administrator: AztecAddress) {
        assert(self.msg_sender() == self.storage.administrator.read(), "not administrator");
        // Zero cancels a pending nomination.
        assert(administrator != self.storage.administrator.read(), "already administrator");
        self.storage.pending_administrator.write(administrator);
        self.emit(AdministratorNominated { administrator });
    }

    #[external("public")]
    fn accept_administrator() {
        let pending = self.storage.pending_administrator.read();
        assert(!pending.is_zero() & (self.msg_sender() == pending), "not pending administrator");
        let previous = self.storage.administrator.read();
        self.storage.administrator.write(pending);
        self.storage.pending_administrator.write(AztecAddress::zero());
        self.emit(AdministratorTransferred { previous, administrator: pending });
    }

    #[external("public")]
    #[view]
    fn get_administrator() -> AztecAddress { self.storage.administrator.read() }

    #[external("public")]
    #[view]
    fn get_pending_administrator() -> AztecAddress { self.storage.pending_administrator.read() }

    #[external("private")]
    fn set_resolver(node: Field, generation: u32, expected_revision: u32, resolver: AztecAddress) {
        self.enqueue_self._set_resolver(self.msg_sender(), node, generation, expected_revision, resolver);
    }

    #[external("public")]
    #[only_self]
    fn _set_resolver(owner: AztecAddress, node: Field, generation: u32, expected_revision: u32, resolver: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, expected_revision, owner.to_field());
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        self.internal.assert_module(resolver);
        let key = record_key(node, generation, 0);
        assert(self.storage.resolvers.at(key).read() != resolver, "resolver unchanged");
        self.storage.resolvers.at(key).write(resolver);
        // A resolver switch must not revive an old primary confirmation, even if switched back later.
        self.internal.apply_address(node, meta, false, AztecAddress::zero());
        self.emit(ResolverChanged { node, generation, resolver });
    }

    #[external("private")]
    fn migrate(label: [u8; 31], len: u32) {
        let packed = pack_label(label, len);
        self.enqueue_self._migrate(self.msg_sender(), node_from_packed(packed, len), packed, len);
    }

    #[external("public")]
    #[only_self]
    fn _migrate(owner: AztecAddress, node: Field, packed_label: Field, label_len: u32) {
        let legacy = self.storage.legacy.read();
        assert(!legacy.is_zero(), "migration not configured");
        assert(self.storage.names.at(node).read().generation == 0, "name already initialized");
        let old = self.view(legacy_registry::NameRegistry::at(legacy).get_name(node));
        assert((old.generation > 0) & (old.owner == owner), "not legacy holder");
        assert(self.context.timestamp() < old.expires_at + GRACE_PERIOD, "legacy name not renewable");
        let published = self.view(legacy_registry::NameRegistry::at(legacy).get_published_label(node));
        assert(published.present & (published.packed_label == packed_label) & (published.label_len == label_len), "legacy label mismatch");
        let resolver = self.storage.modules.read().resolver;
        assert(!resolver.is_zero(), "modules not initialized");
        self.storage.names.at(node).write(NameMeta { generation: old.generation, revision: 0, expires_at: old.expires_at });
        self.storage.owners.at(node).write(owner.to_field());
        self.storage.published_labels.at(node).write(PublishedLabel { present: true, packed_label, label_len });
        self.storage.resolvers.at(record_key(node, old.generation, 0)).write(resolver);
        let addr = self.view(legacy_registry::NameRegistry::at(legacy).get_address(node, old.generation));
        self.storage.records.at(record_key(node, old.generation, 0)).write(AddressRecord { present: addr.present, addr: addr.addr, binding_version: 1 });
        // Reverse records are deliberately not imported: the target account confirms again on this registry.
        self.emit(NameRegisteredV3 { node, generation: old.generation, expires_at: old.expires_at, owner, packed_label, label_len });
        self.emit(NameMigrated { node, legacy, generation: old.generation });
    }

    #[external("public")]
    #[view]
    fn get_modules() -> Modules { self.storage.modules.read() }
    #[external("public")]
    #[view]
    fn get_resolver(node: Field, generation: u32) -> AztecAddress {
        self.storage.resolvers.at(record_key(node, generation, 0)).read()
    }
    #[external("public")]
    #[view]
    fn implementation_version() -> u32 { 6 }

    #[internal("public")]
    fn assert_module(module: AztecAddress) {
        let registry = self.view(PublicStaticCall::<_, _, AztecAddress>::new(module,
            comptime { FunctionSelector::from_signature("get_registry()") }, "get_registry", []));
        assert(registry == self.context.this_address(), "module belongs to another registry");
    }
    #[event]
    struct NameTransferred { node: Field, generation: u32, previous_owner: AztecAddress, owner: AztecAddress }
    #[event]
    struct ManagerChanged { node: Field, generation: u32, manager: AztecAddress }
    #[event]
    struct TransferOffered { node: Field, generation: u32, recipient: AztecAddress, expires_at: u64 }
    #[event]
    struct SubnameIssued { parent: Field, node: Field, generation: u32, owner: AztecAddress }
    #[event]
    struct RecordChanged { node: Field, generation: u32, key: Field }

    // A child inherits the lifetime and generation of every ancestor. No descendant walk or mass deletion is needed.
    #[internal("public")]
    fn live_expiry(node: Field) -> u64 {
        let mut current = node;
        let mut expiry = self.storage.names.at(node).read().expires_at;
        let mut valid = true;
        for _ in 0..5 {
            if current != 0 {
                let link = self.storage.parents.at(current).read();
                if link.parent != 0 {
                    let parent = self.storage.names.at(link.parent).read();
                    valid = valid & (parent.generation == link.parent_generation) & (parent.generation > 0);
                    if parent.expires_at < expiry { expiry = parent.expires_at; }
                }
                current = link.parent;
            }
        }
        assert(current == 0, "subname depth exceeded");
        if valid { expiry } else { 0 }
    }

    #[internal("public")]
    fn assert_editor(actor: AztecAddress, node: Field, generation: u32, revision: u32) {
        let meta = self.storage.names.at(node).read();
        assert((meta.generation == generation) & (generation > 0) & (meta.revision == revision), "generation or revision mismatch");
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");
        let manager = self.storage.managers.at(record_key(node, generation, 0)).read();
        assert((actor.to_field() == self.storage.owners.at(node).read()) | (!manager.is_zero() & (manager == actor)), "not record editor");
    }

    #[external("private")]
    fn set_manager(node: Field, generation: u32, revision: u32, manager: AztecAddress) {
        self.enqueue_self._set_manager(self.msg_sender(), node, generation, revision, manager);
    }
    #[external("public")]
    #[only_self]
    fn _set_manager(owner: AztecAddress, node: Field, generation: u32, revision: u32, manager: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, revision, owner.to_field());
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        self.storage.managers.at(record_key(node, generation, 0)).write(manager);
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(ManagerChanged { node, generation, manager });
    }

    // Zero recipient cancels an existing offer. Recipient acceptance prevents accidental unilateral delivery.
    #[external("private")]
    fn offer_transfer(node: Field, generation: u32, revision: u32, recipient: AztecAddress) {
        self.enqueue_self._offer_transfer(self.msg_sender(), node, generation, revision, recipient);
    }
    #[external("public")]
    #[only_self]
    fn _offer_transfer(owner: AztecAddress, node: Field, generation: u32, revision: u32, recipient: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, revision, owner.to_field());
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        assert(recipient != owner, "recipient is current owner");
        let expires_at = if recipient.is_zero() { 0 } else { self.context.timestamp() + 604800 };
        self.storage.transfers.at(record_key(node, generation, 0)).write(TransferOffer { recipient, expires_at });
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(TransferOffered { node, generation, recipient, expires_at });
    }
    #[external("private")]
    fn accept_transfer(node: Field, generation: u32, revision: u32) {
        self.enqueue_self._accept_transfer(self.msg_sender(), node, generation, revision);
    }
    #[external("public")]
    #[only_self]
    fn _accept_transfer(recipient: AztecAddress, node: Field, generation: u32, revision: u32) {
        let meta = self.storage.names.at(node).read();
        assert((meta.generation == generation) & (meta.revision == revision) & (generation > 0), "generation or revision mismatch");
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");
        let key = record_key(node, generation, 0);
        let offer = self.storage.transfers.at(key).read();
        assert(!recipient.is_zero() & (offer.recipient == recipient), "not transfer recipient");
        assert(self.context.timestamp() < offer.expires_at, "transfer offer expired");
        let previous_owner = AztecAddress::from_field(self.storage.owners.at(node).read());
        let next = generation + 1;
        self.storage.names.at(node).write(NameMeta { generation: next, revision: 0, expires_at: meta.expires_at });
        self.storage.owners.at(node).write(recipient.to_field());
        self.storage.resolvers.at(record_key(node, next, 0)).write(self.storage.resolvers.at(key).read());
        // Manager, text, forward and primary bindings remain scoped to the old generation.
        let published = self.storage.published_labels.at(node).read();
        self.emit(NameRegisteredV3 { node, generation: next, expires_at: meta.expires_at, owner: recipient, packed_label: published.packed_label, label_len: published.label_len });
        self.emit(NameTransferred { node, generation: next, previous_owner, owner: recipient });
    }

    #[external("private")]
    fn issue_subname(parent: Field, parent_generation: u32, parent_revision: u32, label: [u8; 31], len: u32, expected_generation: u32, owner: AztecAddress, expires_at: u64) {
        let packed = pack_label(label, len);
        self.enqueue_self._issue_subname(self.msg_sender(), parent, parent_generation, parent_revision, packed, len, expected_generation, owner, expires_at);
    }
    #[external("public")]
    #[only_self]
    fn _issue_subname(actor: AztecAddress, parent: Field, parent_generation: u32, parent_revision: u32, packed_label: Field, label_len: u32, expected_generation: u32, owner: AztecAddress, expires_at: u64) {
        let meta = self.storage.names.at(parent).read();
        assert_holder_active(meta, self.storage.owners.at(parent).read(), self.context.timestamp(), parent_generation, parent_revision, actor.to_field());
        let limit = self.internal.live_expiry(parent);
        assert((expires_at > self.context.timestamp()) & (expires_at <= limit), "invalid subname expiry");
        assert(!owner.is_zero(), "owner required");
        let depth = self.storage.parents.at(parent).read().depth + 1;
        assert(depth <= 4, "subname depth exceeded");
        let label_hash = poseidon2_hash_with_separator([label_len as Field, packed_label], DOMAIN_LABEL_V1);
        let node = poseidon2_hash_with_separator([parent, label_hash], DOMAIN_NODE_V1);
        let old = self.storage.names.at(node).read();
        assert(old.generation == expected_generation, "generation mismatch");
        let generation = expected_generation + 1;
        self.storage.parents.at(node).write(ParentLink { parent, parent_generation, depth });
        self.storage.names.at(node).write(NameMeta { generation, revision: 0, expires_at });
        self.storage.owners.at(node).write(owner.to_field());
        self.storage.resolvers.at(record_key(node, generation, 0)).write(self.storage.modules.read().resolver);
        self.storage.published_labels.at(node).write(PublishedLabel { present: true, packed_label, label_len });
        self.emit(NameRegisteredV3 { node, generation, expires_at, owner, packed_label, label_len });
        self.emit(SubnameIssued { parent, node, generation, owner });
    }

    #[external("private")]
    fn revoke_subname(node: Field, generation: u32, parent_generation: u32, parent_revision: u32) {
        self.enqueue_self._revoke_subname(self.msg_sender(), node, generation, parent_generation, parent_revision);
    }
    #[external("public")]
    #[only_self]
    fn _revoke_subname(actor: AztecAddress, node: Field, generation: u32, parent_generation: u32, parent_revision: u32) {
        let link = self.storage.parents.at(node).read();
        assert(link.parent != 0, "not a subname");
        let parent = self.storage.names.at(link.parent).read();
        assert_holder_active(parent, self.storage.owners.at(link.parent).read(), self.context.timestamp(), parent_generation, parent_revision, actor.to_field());
        assert(self.internal.live_expiry(link.parent) > self.context.timestamp(), "parent not active");
        let meta = self.storage.names.at(node).read();
        assert(meta.generation == generation, "generation mismatch");
        self.storage.names.at(node).write(NameMeta { generation: generation + 1, revision: 0, expires_at: 0 });
        self.storage.owners.at(node).write(0);
        self.emit(SubnameIssued { parent: link.parent, node, generation: generation + 1, owner: AztecAddress::zero() });
    }

    #[external("private")]
    fn set_text(node: Field, generation: u32, revision: u32, key: Field, value: [u8; 248], length: u32) {
        assert(length <= 248, "record too long");
        assert(key != 0, "record key required");
        let mut words = [0; 8];
        for i in 0..248 {
            if i >= length { assert(value[i] == 0, "nonzero record padding"); }
            words[i / 31] = words[i / 31] * 256 + value[i] as Field;
        }
        self.enqueue_self._set_text(self.msg_sender(), node, generation, revision, key, words, length);
    }
    #[external("public")]
    #[only_self]
    fn _set_text(actor: AztecAddress, node: Field, generation: u32, revision: u32, key: Field, words: [Field; 8], length: u32) {
        self.internal.assert_editor(actor, node, generation, revision);
        let scope = record_key(node, generation, 0);
        let value_key = poseidon2_hash_with_separator([scope, key], 0x414e535f544558545f5634);
        if !self.storage.text_seen.at(value_key).read() {
            let count = self.storage.text_count.at(scope).read();
            assert(count < 64, "record key limit reached");
            let index = poseidon2_hash_with_separator([scope, count as Field], 0x414e535f494e4445585f5634);
            self.storage.text_keys.at(index).write(key);
            self.storage.text_count.at(scope).write(count + 1);
            self.storage.text_seen.at(value_key).write(true);
        }
        self.storage.text_values.at(value_key).write(TextValue { words, length });
        let meta = self.storage.names.at(node).read();
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(RecordChanged { node, generation, key });
    }
}
