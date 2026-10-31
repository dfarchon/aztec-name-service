use aztec::macros::aztec;

#[aztec]
pub contract NameRegistryV3 {
    use aztec::{
        context::{PublicCall, PublicStaticCall},
        macros::{events::event, functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, traits::{FromField, ToField}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    use ans_common::logic::{
        assert_cleared_record, assert_duration, assert_holder, assert_holder_active,
        GRACE_PERIOD, is_active, is_available,
        MAX_COMMIT_AGE, MIN_COMMIT_AGE, node_from_packed,
        pack_label, primary_key, record_key,
    };
    use ans_common::types::{
        AddressRecord, CommitRecord, NameMeta, NameRecord, PrimaryRecord, PublishedLabel, Modules, Proposal, Upgrade,
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
    struct PrimaryChangedV3 {
        address: AztecAddress,
        present: bool,
        node: Field,
        generation: u32,
        binding_version: u32,
    }

    #[storage]
    struct Storage<Context> {
        // Slot order is part of the V3 protocol. Append fields; never reorder existing ones.
        governance: PublicMutable<AztecAddress, Context>,
        governance_delay: PublicImmutable<u64, Context>,
        legacy: PublicImmutable<AztecAddress, Context>,
        modules: PublicMutable<Modules, Context>,
        proposal: PublicMutable<Proposal, Context>,
        upgrade: PublicMutable<Upgrade, Context>,
        allowed_resolvers: Map<AztecAddress, PublicMutable<bool, Context>, Context>,
        resolvers: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        names: Map<Field, PublicMutable<NameMeta, Context>, Context>,
        owners: Map<Field, PublicMutable<Field, Context>, Context>,
        commits: Map<Field, PublicMutable<CommitRecord, Context>, Context>,
        records: Map<Field, PublicMutable<AddressRecord, Context>, Context>,
        primary: Map<Field, PublicMutable<PrimaryRecord, Context>, Context>,
        published_labels: Map<Field, PublicMutable<PublishedLabel, Context>, Context>,
        protocol_upgrade: PublicMutable<Upgrade, Context>,
    }



    #[external("private")]
    fn commit(c: Field) {
        self.enqueue_self._commit(c);
    }

    #[external("public")]
    #[only_self]
    fn _commit(c: Field) {
        let existing = self.storage.commits.at(c).read();
        if existing.committed_at == 0 {
            self.storage.commits.at(c).write(CommitRecord { committed_at: self.context.timestamp(), consumed: false });
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
        let stored = self.storage.owners.at(node).read();
        assert_holder_active(meta, stored, self.context.timestamp(), generation, expected_revision, owner);
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
        assert(is_active(meta, self.context.timestamp()), "name not active");

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
            expires_at: meta.expires_at,
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
    struct ModuleScheduled { kind: u8, target: AztecAddress, execute_after: u64, nonce: u32 }
    #[event]
    struct ModuleActivated { kind: u8, target: AztecAddress, nonce: u32 }
    #[event]
    struct ProposalCancelled { nonce: u32 }
    #[event]
    struct ResolverChanged { node: Field, generation: u32, resolver: AztecAddress }
    #[event]
    struct UpgradeScheduled { class_id: Field, execute_after: u64 }
    #[event]
    struct UpgradeSubmitted { class_id: Field, execute_after: u64 }
    #[event]
    struct NameMigrated { node: Field, legacy: AztecAddress, generation: u32 }

    #[external("public")]
    #[initializer]
    fn constructor(governance: AztecAddress, governance_delay: u64, legacy: AztecAddress) {
        assert(!governance.is_zero(), "governance required");
        assert(governance_delay >= 86400, "governance delay must be at least one day");
        self.storage.governance.write(governance);
        self.storage.governance_delay.initialize(governance_delay);
        self.storage.legacy.initialize(legacy);
    }

    #[external("public")]
    fn bootstrap(registrar: AztecAddress, resolver: AztecAddress) {
        assert(self.msg_sender() == self.storage.governance.read(), "unauthorized governance");
        assert(self.storage.modules.read().revision == 0, "already bootstrapped");
        assert(!registrar.is_zero() & !resolver.is_zero(), "module required");
        self.internal.assert_module(registrar);
        self.internal.assert_module(resolver);
        self.storage.modules.write(Modules { registrar, resolver, revision: 1 });
        self.storage.allowed_resolvers.at(resolver).write(true);
        self.emit(ModuleActivated { kind: 1, target: registrar, nonce: 0 });
        self.emit(ModuleActivated { kind: 2, target: resolver, nonce: 0 });
    }

    /// 1: registrar, 2: approve resolver and make it the default for future registrations, 3: governance handover.
    #[external("public")]
    fn schedule_module(kind: u8, target: AztecAddress) {
        assert(self.msg_sender() == self.storage.governance.read(), "unauthorized governance");
        assert(self.storage.modules.read().revision > 0, "modules not initialized");
        assert((kind >= 1) & (kind <= 3) & !target.is_zero(), "invalid proposal");
        let previous = self.storage.proposal.read();
        assert(previous.execute_after == 0, "cancel existing proposal first");
        let nonce = previous.nonce + 1;
        let execute_after = self.context.timestamp() + self.storage.governance_delay.read();
        self.storage.proposal.write(Proposal { kind, target, execute_after, nonce });
        self.emit(ModuleScheduled { kind, target, execute_after, nonce });
    }

    #[external("public")]
    fn cancel_proposal(nonce: u32) {
        assert(self.msg_sender() == self.storage.governance.read(), "unauthorized governance");
        let p = self.storage.proposal.read();
        assert((p.nonce == nonce) & (p.execute_after != 0), "proposal mismatch");
        self.storage.proposal.write(Proposal { kind: 0, target: AztecAddress::zero(), execute_after: 0, nonce });
        self.emit(ProposalCancelled { nonce });
    }

    #[external("public")]
    fn execute_proposal(nonce: u32) {
        let p = self.storage.proposal.read();
        assert((p.nonce == nonce) & (p.execute_after != 0), "proposal mismatch");
        assert(self.context.timestamp() >= p.execute_after, "governance delay active");
        let m = self.storage.modules.read();
        if p.kind != 3 { self.internal.assert_module(p.target); }
        if p.kind == 1 {
            self.storage.modules.write(Modules { registrar: p.target, resolver: m.resolver, revision: m.revision + 1 });
        } else if p.kind == 2 {
            self.storage.allowed_resolvers.at(p.target).write(true);
            self.storage.modules.write(Modules { registrar: m.registrar, resolver: p.target, revision: m.revision + 1 });
        } else {
            assert(p.kind == 3, "invalid proposal");
            self.storage.governance.write(p.target);
        }
        self.storage.proposal.write(Proposal { kind: 0, target: AztecAddress::zero(), execute_after: 0, nonce });
        self.emit(ModuleActivated { kind: p.kind, target: p.target, nonce });
    }

    #[external("private")]
    fn set_resolver(node: Field, generation: u32, expected_revision: u32, resolver: AztecAddress) {
        self.enqueue_self._set_resolver(self.msg_sender(), node, generation, expected_revision, resolver);
    }

    #[external("public")]
    #[only_self]
    fn _set_resolver(owner: AztecAddress, node: Field, generation: u32, expected_revision: u32, resolver: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, expected_revision, owner.to_field());
        assert(self.storage.allowed_resolvers.at(resolver).read(), "resolver not approved");
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

    /// Two-stage code upgrade: cancellable governance proposal, then the protocol's own one-day delay.
    #[external("public")]
    fn schedule_upgrade(class_id: Field) {
        assert(self.msg_sender() == self.storage.governance.read(), "unauthorized governance");
        assert(class_id != 0, "class required");
        assert(self.context.timestamp() >= self.storage.protocol_upgrade.read().execute_after, "protocol upgrade pending");
        let u = self.storage.upgrade.read();
        assert(u.execute_after == 0, "upgrade already pending");
        let execute_after = self.context.timestamp() + self.storage.governance_delay.read();
        self.storage.upgrade.write(Upgrade { class_id, execute_after });
        self.emit(UpgradeScheduled { class_id, execute_after });
    }

    #[external("public")]
    fn cancel_upgrade(class_id: Field) {
        assert(self.msg_sender() == self.storage.governance.read(), "unauthorized governance");
        let u = self.storage.upgrade.read();
        assert((u.class_id == class_id) & (u.execute_after != 0), "upgrade mismatch");
        self.storage.upgrade.write(Upgrade { class_id: 0, execute_after: 0 });
    }

    #[external("public")]
    fn execute_upgrade(class_id: Field) {
        let u = self.storage.upgrade.read();
        assert((u.class_id == class_id) & (u.execute_after != 0), "upgrade mismatch");
        assert(self.context.timestamp() >= u.execute_after, "governance delay active");
        let delay = self.view(PublicStaticCall::<_, _, u64>::new(
            aztec::protocol::constants::CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS,
            comptime { FunctionSelector::from_signature("get_update_delay()") }, "get_update_delay", []));
        self.call(PublicCall::<_, _, ()>::new(
            aztec::protocol::constants::CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS,
            comptime { FunctionSelector::from_signature("update((Field))") }, "update", [class_id]));
        let execute_after = self.context.timestamp() + delay;
        self.storage.protocol_upgrade.write(Upgrade { class_id, execute_after });
        self.emit(UpgradeSubmitted { class_id, execute_after });
        self.storage.upgrade.write(Upgrade { class_id: 0, execute_after: 0 });
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
    fn get_proposal() -> Proposal { self.storage.proposal.read() }
    #[external("public")]
    #[view]
    fn implementation_version() -> u32 { 1 }

    #[internal("public")]
    fn assert_module(module: AztecAddress) {
        let registry = self.view(PublicStaticCall::<_, _, AztecAddress>::new(module,
            comptime { FunctionSelector::from_signature("get_registry()") }, "get_registry", []));
        assert(registry == self.context.this_address(), "module belongs to another registry");
    }
}
