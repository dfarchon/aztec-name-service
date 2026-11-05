mod rules;
mod test;
use aztec::macros::aztec;

/// Fixed one-year launch leases with live public eligibility and registry administrator authority.
#[aztec]
pub contract NameRegistrarLaunch {
    use aztec::{
        context::{PrivateCall, PublicStaticCall},
        macros::{events::event, functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use ans_common::{
        types::RegistryConfig,
        logic::{pack_label, node_from_packed, compute_register_commitment, modular_commitment, fee_for, SECONDS_PER_YEAR, MAX_ANNUAL_PRICE},
    };
    use name_registry_v6::NameRegistryV6;
    use crate::rules::{assert_new_label, LengthPrices, LaunchPolicy, DOMAIN_ADMIN_MINT_V1};

    global TRANSFER_IN_PRIVATE_SELECTOR: FunctionSelector =
        comptime { FunctionSelector::from_signature("transfer_in_private((Field),(Field),u128,Field)") };

    #[storage]
    struct Storage<Context> {
        registry: PublicImmutable<AztecAddress, Context>,
        config: PublicImmutable<RegistryConfig, Context>,
        length_prices: PublicImmutable<LengthPrices, Context>,
        policy: PublicMutable<LaunchPolicy, Context>,
        reserved: Map<Field, PublicMutable<bool, Context>, Context>,
        max_renew_ahead: PublicImmutable<u64, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress, fee_token: AztecAddress, treasury: AztecAddress, annual_price: u128, price_three: u128, price_four: u128, price_version: u32, min_public_length: u32, paused: bool, max_renew_ahead: u64) {
        assert((min_public_length >= 3) & (min_public_length <= 31), "invalid public length");
        assert(max_renew_ahead <= 10 * SECONDS_PER_YEAR, "renewal cap too large");
        assert(!registry.is_zero(), "registry required");
        assert(price_version > 0, "price version required");
        if fee_token.is_zero() {
            assert((annual_price == 0) & (price_three == 0) & (price_four == 0), "free registry must have zero price");
        } else {
            assert(!treasury.is_zero(), "treasury required");
            assert(price_three <= MAX_ANNUAL_PRICE, "annual price too large");
            assert((price_three >= price_four) & (price_four >= annual_price), "shorter names must not cost less");
        }
        self.storage.registry.initialize(registry);
        self.storage.config.initialize(RegistryConfig { fee_token, treasury, annual_price, price_version });
        self.storage.length_prices.initialize(LengthPrices { three: price_three, four: price_four });
        self.storage.policy.write(LaunchPolicy { min_public_length, paused });
        self.storage.max_renew_ahead.initialize(max_renew_ahead);
    }

    #[external("private")]
    fn commit(c: Field) {
        self.call(NameRegistryV6::at(self.storage.registry.read()).commit(c));
    }

    #[external("private")]
    fn register(label: [u8; 31], len: u32, expected_generation: u32, duration: u64, max_fee: u128, quote_expiry: u64, fee_nonce: Field, secret: Field) {
        assert(duration == SECONDS_PER_YEAR, "lease must be one year");
        let registry = self.storage.registry.read();
        let config = self.storage.config.read();
        let owner = self.msg_sender();
        let packed = pack_label(label, len);
        assert_new_label(label, len);
        let node = node_from_packed(packed, len);
        let base = compute_register_commitment(self.context.chain_id(), registry, node, expected_generation, owner.to_field(), duration,
            config.fee_token, config.treasury, config.price_version, max_fee, quote_expiry, secret);
        let c = modular_commitment(self.context.this_address(), base);
        self.internal.charge_fee(config, len, owner, duration, max_fee, fee_nonce);
        self.enqueue_self._check_public(node, len);
        self.enqueue(NameRegistryV6::at(registry).register_from_registrar(node, expected_generation, owner.to_field(), c, duration, quote_expiry, packed, len));
    }

    /// The label proves the node and therefore the price tier; only `pack_label` rules apply, so names registered
    /// before the stricter rules stay renewable.
    #[external("private")]
    fn renew(label: [u8; 31], len: u32, generation: u32, expected_revision: u32, duration: u64, max_fee: u128, quote_expiry: u64, fee_nonce: Field) {
        assert(duration == SECONDS_PER_YEAR, "lease must be one year");
        let owner = self.msg_sender();
        let node = node_from_packed(pack_label(label, len), len);
        self.internal.charge_fee(self.storage.config.read(), len, owner, duration, max_fee, fee_nonce);
        self.enqueue_self._check_renew(node);
        self.enqueue(NameRegistryV6::at(self.storage.registry.read()).renew_from_registrar(node, generation, expected_revision, owner.to_field(), duration, quote_expiry));
    }

    #[internal("private")]
    fn charge_fee(config: RegistryConfig, len: u32, payer: AztecAddress, duration: u64, max_fee: u128, fee_nonce: Field) {
        let fee = if config.fee_token.is_zero() {
            0
        } else {
            fee_for(self.storage.length_prices.read().annual_for(len, config.annual_price), duration)
        };
        assert(fee <= max_fee, "fee exceeds max_fee");
        if fee > 0 {
            self.call(PrivateCall::<_, _, ()>::new(config.fee_token, TRANSFER_IN_PRIVATE_SELECTOR, "transfer_in_private",
                [payer.to_field(), config.treasury.to_field(), fee as Field, fee_nonce]));
        }
    }

    #[external("public")]
    #[view]
    fn get_registry() -> AztecAddress { self.storage.registry.read() }
    #[external("public")]
    #[view]
    fn get_config() -> RegistryConfig { self.storage.config.read() }
    #[external("public")]
    #[view]
    fn get_length_prices() -> LengthPrices { self.storage.length_prices.read() }

    #[external("utility")]
    unconstrained fn register_commitment(owner: AztecAddress, label: [u8; 31], len: u32, expected_generation: u32, duration: u64, max_fee: u128, quote_expiry: u64, secret: Field) -> Field {
        let config = self.storage.config.read();
        let base = compute_register_commitment(self.context.chain_id(), self.storage.registry.read(), node_from_packed(pack_label(label, len), len), expected_generation, owner.to_field(), duration,
            config.fee_token, config.treasury, config.price_version, max_fee, quote_expiry, secret);
        modular_commitment(self.context.this_address(), base)
    }
    #[event]
    struct ReservedChanged { node: Field, reserved: bool }
    #[event]
    struct PolicyChanged { min_public_length: u32, paused: bool }

    #[external("private")]
    fn admin_register(label: [u8; 31], len: u32, recipient: AztecAddress, expected_generation: u32, quote_expiry: u64, secret: Field) {
        assert(!recipient.is_zero(), "recipient required");
        let packed = pack_label(label, len);
        assert_new_label(label, len);
        let node = node_from_packed(packed, len);
        let config = self.storage.config.read();
        let registry = self.storage.registry.read();
        let base = compute_register_commitment(self.context.chain_id(), registry, node, expected_generation, recipient.to_field(), SECONDS_PER_YEAR,
            config.fee_token, config.treasury, config.price_version, 0, quote_expiry, secret);
        let c = poseidon2_hash_with_separator([self.context.this_address().to_field(), base], DOMAIN_ADMIN_MINT_V1);
        self.enqueue_self._check_admin(self.msg_sender());
        self.enqueue(NameRegistryV6::at(registry).register_from_registrar(node, expected_generation, recipient.to_field(), c, SECONDS_PER_YEAR, quote_expiry, packed, len));
    }

    #[external("public")]
    #[only_self]
    fn _check_public(node: Field, len: u32) {
        let policy = self.storage.policy.read();
        assert(!policy.paused, "registration paused");
        assert(len >= policy.min_public_length, "name not yet available");
        assert(!self.storage.reserved.at(node).read(), "name reserved");
    }

    #[internal("public")]
    fn assert_admin(caller: AztecAddress) {
        let admin = self.view(PublicStaticCall::<_, _, AztecAddress>::new(self.storage.registry.read(),
            comptime { FunctionSelector::from_signature("get_administrator()") }, "get_administrator", []));
        assert(caller == admin, "not administrator");
    }

    #[external("public")]
    #[only_self]
    fn _check_admin(caller: AztecAddress) { self.internal.assert_admin(caller); }

    #[external("public")]
    #[only_self]
    fn _check_renew(node: Field) {
        let cap = self.storage.max_renew_ahead.read();
        if cap != 0 {
            let record = self.view(NameRegistryV6::at(self.storage.registry.read()).get_name(node));
            let now = self.context.timestamp();
            // Expired names have no remaining lease; guard subtraction against underflow.
            if record.expires_at > now {
                assert(record.expires_at - now <= cap, "renewal too early");
            }
        }
    }

    #[external("public")]
    fn set_min_public_length(len: u32) {
        self.internal.assert_admin(self.msg_sender());
        assert((len >= 3) & (len <= 31), "invalid public length");
        let policy = LaunchPolicy { min_public_length: len, paused: self.storage.policy.read().paused };
        self.storage.policy.write(policy);
        self.emit(PolicyChanged { min_public_length: policy.min_public_length, paused: policy.paused });
    }

    #[external("public")]
    fn set_paused(paused: bool) {
        self.internal.assert_admin(self.msg_sender());
        let policy = LaunchPolicy { min_public_length: self.storage.policy.read().min_public_length, paused };
        self.storage.policy.write(policy);
        self.emit(PolicyChanged { min_public_length: policy.min_public_length, paused: policy.paused });
    }

    #[external("public")]
    fn set_reserved(nodes: [Field; 32], reserved: bool) {
        self.internal.assert_admin(self.msg_sender());
        for node in nodes {
            if node != 0 {
                self.storage.reserved.at(node).write(reserved);
                self.emit(ReservedChanged { node, reserved });
            }
        }
    }

    #[external("public")]
    #[view]
    fn get_policy() -> LaunchPolicy { self.storage.policy.read() }
    #[external("public")]
    #[view]
    fn is_reserved(node: Field) -> bool { self.storage.reserved.at(node).read() }
    #[external("public")]
    #[view]
    fn get_max_renew_ahead() -> u64 { self.storage.max_renew_ahead.read() }

    #[external("utility")]
    unconstrained fn admin_commitment(recipient: AztecAddress, label: [u8; 31], len: u32, expected_generation: u32, quote_expiry: u64, secret: Field) -> Field {
        let config = self.storage.config.read();
        let base = compute_register_commitment(self.context.chain_id(), self.storage.registry.read(), node_from_packed(pack_label(label, len), len), expected_generation, recipient.to_field(), SECONDS_PER_YEAR,
            config.fee_token, config.treasury, config.price_version, 0, quote_expiry, secret);
        poseidon2_hash_with_separator([self.context.this_address().to_field(), base], DOMAIN_ADMIN_MINT_V1)
    }

}
