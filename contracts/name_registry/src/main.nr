mod types;
mod logic;
mod test;
mod vectors;

use aztec::macros::aztec;

#[aztec]
pub contract NameRegistry {
    use aztec::{
        context::PrivateCall,
        macros::{events::event, functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, traits::{FromField, ToField}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    use crate::logic::{
        assert_cleared_record, assert_duration, assert_holder, assert_holder_active,
        compute_register_commitment, fee_for, GRACE_PERIOD, is_active, is_available,
        MAX_ANNUAL_PRICE, MAX_COMMIT_AGE, MIN_COMMIT_AGE, node_from_packed,
        pack_label, primary_key, record_key,
    };
    use crate::types::{
        AddressRecord, CommitRecord, NameMeta, NameRecord, PrimaryRecord, PublishedLabel, RegistryConfig,
    };

    global TRANSFER_IN_PRIVATE_SELECTOR: FunctionSelector =
        comptime { FunctionSelector::from_signature("transfer_in_private((Field),(Field),u128,Field)") };

    #[event]
    struct NameRegistered {
        node: Field,
        generation: u32,
        expires_at: u64,
        owner: AztecAddress,
        packed_label: Field,
        label_len: u32,
    }

    #[event]
    struct AddressChanged {
        node: Field,
        generation: u32,
        present: bool,
        addr: AztecAddress,
        binding_version: u32,
        revision: u32,
    }

    #[event]
    struct NameRenewed {
        node: Field,
        generation: u32,
        expires_at: u64,
        revision: u32,
    }

    #[event]
    struct PrimaryChanged {
        address: AztecAddress,
        present: bool,
        node: Field,
        generation: u32,
        binding_version: u32,
    }

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<RegistryConfig, Context>,
        names: Map<Field, PublicMutable<NameMeta, Context>, Context>,
        owners: Map<Field, PublicMutable<Field, Context>, Context>,
        commits: Map<Field, PublicMutable<CommitRecord, Context>, Context>,
        records: Map<Field, PublicMutable<AddressRecord, Context>, Context>,
        primary: Map<Field, PublicMutable<PrimaryRecord, Context>, Context>,
        published_labels: Map<Field, PublicMutable<PublishedLabel, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(fee_token: AztecAddress, treasury: AztecAddress, annual_price: u128, price_version: u32) {
        if fee_token.is_zero() {
            assert(annual_price == 0, "free registry must have zero price");
        } else {
            assert(!treasury.is_zero(), "treasury required");
            assert(annual_price <= MAX_ANNUAL_PRICE, "annual price too large");
        }
        self.storage.config.initialize(RegistryConfig { fee_token, treasury, annual_price, price_version });
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

    #[external("private")]
    fn register(
        label: [u8; 31],
        len: u32,
        expected_generation: u32,
        duration: u64,
        max_fee: u128,
        quote_expiry: u64,
        fee_nonce: Field,
        secret: Field,
    ) {
        let packed = pack_label(label, len);
        let node = node_from_packed(packed, len);
        let owner = self.msg_sender();
        let config = self.storage.config.read();
        let c = compute_register_commitment(
            self.context.chain_id(),
            self.context.this_address(),
            node,
            expected_generation,
            owner.to_field(),
            duration,
            config.fee_token,
            config.treasury,
            config.price_version,
            max_fee,
            quote_expiry,
            secret,
        );

        self.internal.charge_fee(config, owner, duration, max_fee, fee_nonce);
        self.enqueue_self._register(node, expected_generation, owner.to_field(), c, duration, quote_expiry, packed, len);
    }

    #[external("public")]
    #[only_self]
    fn _register(
        node: Field,
        expected_generation: u32,
        owner: Field,
        c: Field,
        duration: u64,
        quote_expiry: u64,
        packed_label: Field,
        label_len: u32,
    ) {
        let now = self.context.timestamp();
        assert(now <= quote_expiry, "fee quote expired");

        let commit = self.storage.commits.at(c).read();
        assert(commit.committed_at != 0, "unknown commitment");
        assert(!commit.consumed, "commitment already consumed");
        let age = now - commit.committed_at;
        assert(age >= MIN_COMMIT_AGE, "commitment too young");
        assert(age < MAX_COMMIT_AGE, "commitment expired");

        let meta = self.storage.names.at(node).read();
        assert(meta.generation == expected_generation, "generation mismatch");
        assert(is_available(meta, now), "name not available");
        assert_duration(duration);

        let generation = expected_generation + 1;
        let expires_at = now + duration;
        self.storage.names.at(node).write(NameMeta { generation, revision: 0, expires_at });
        self.storage.owners.at(node).write(owner);
        self.storage.commits.at(c).write(CommitRecord { committed_at: commit.committed_at, consumed: true });
        self.storage.published_labels.at(node).write(PublishedLabel { present: true, packed_label, label_len });
        self.emit(NameRegistered { node, generation, expires_at, owner: AztecAddress::from_field(owner), packed_label, label_len });
    }

    #[external("private")]
    fn set_address(
        node: Field,
        generation: u32,
        expected_revision: u32,
        present: bool,
        addr: AztecAddress,
    ) {
        assert_cleared_record(present, addr);
        let oc = self.msg_sender().to_field();
        self.enqueue_self._set_address(node, generation, expected_revision, oc, present, addr);
    }

    #[external("public")]
    #[only_self]
    fn _set_address(
        node: Field,
        generation: u32,
        expected_revision: u32,
        owner: Field,
        present: bool,
        addr: AztecAddress,
    ) {
        let meta = self.storage.names.at(node).read();
        let stored = self.storage.owners.at(node).read();
        assert_holder_active(meta, stored, self.context.timestamp(), generation, expected_revision, owner);
        self.internal.apply_address(node, meta, present, addr);
    }

    #[external("private")]
    fn renew(
        node: Field,
        generation: u32,
        expected_revision: u32,
        duration: u64,
        max_fee: u128,
        quote_expiry: u64,
        fee_nonce: Field,
    ) {
        let owner = self.msg_sender();
        let oc = owner.to_field();
        let config = self.storage.config.read();
        self.internal.charge_fee(config, owner, duration, max_fee, fee_nonce);
        self.enqueue_self._renew(node, generation, expected_revision, oc, duration, quote_expiry);
    }

    #[external("public")]
    #[only_self]
    fn _renew(
        node: Field,
        generation: u32,
        expected_revision: u32,
        owner: Field,
        duration: u64,
        quote_expiry: u64,
    ) {
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
        self.emit(NameRenewed { node, generation, expires_at, revision });
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
        self.emit(PrimaryChanged { address, present: true, node, generation, binding_version });
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
        self.emit(PrimaryChanged { address, present: false, node: 0, generation: 0, binding_version: 0 });
    }

    #[external("public")]
    #[view]
    fn get_config() -> RegistryConfig {
        self.storage.config.read()
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

    #[external("utility")]
    unconstrained fn fee_quote(duration: u64) -> u128 {
        let config = self.storage.config.read();
        if config.fee_token.is_zero() {
            0
        } else {
            fee_for(config.annual_price, duration)
        }
    }

    #[external("utility")]
    unconstrained fn register_commitment(
        owner: AztecAddress,
        label: [u8; 31],
        len: u32,
        expected_generation: u32,
        duration: u64,
        max_fee: u128,
        quote_expiry: u64,
        secret: Field,
    ) -> Field {
        let node = node_from_packed(pack_label(label, len), len);
        let oc = owner.to_field();
        let config = self.storage.config.read();
        compute_register_commitment(
            self.context.chain_id(),
            self.context.this_address(),
            node,
            expected_generation,
            oc,
            duration,
            config.fee_token,
            config.treasury,
            config.price_version,
            max_fee,
            quote_expiry,
            secret,
        )
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
        self.emit(AddressChanged { node, generation, present, addr, binding_version, revision });
    }

    #[internal("private")]
    fn charge_fee(config: RegistryConfig, payer: AztecAddress, duration: u64, max_fee: u128, fee_nonce: Field) {
        let fee = if config.fee_token.is_zero() {
            0
        } else {
            fee_for(config.annual_price, duration)
        };
        assert(fee <= max_fee, "fee exceeds max_fee");
        if fee > 0 {
            self.call(
                PrivateCall::<_, _, ()>::new(
                    config.fee_token,
                    TRANSFER_IN_PRIVATE_SELECTOR,
                    "transfer_in_private",
                    [payer.to_field(), config.treasury.to_field(), fee as Field, fee_nonce],
                ),
            );
        }
    }

}
