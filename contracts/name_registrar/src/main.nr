mod test;
use aztec::macros::aztec;

#[aztec]
pub contract NameRegistrar {
    use aztec::{
        context::PrivateCall,
        macros::{functions::{external, initializer, internal, view}, storage::storage},
        protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, traits::ToField},
        state_vars::PublicImmutable,
    };
    use ans_common::{
        types::RegistryConfig,
        logic::{pack_label, node_from_packed, compute_register_commitment, modular_commitment, fee_for, assert_duration, MAX_ANNUAL_PRICE},
    };
    use name_registry_v3::NameRegistryV3;

    global TRANSFER_IN_PRIVATE_SELECTOR: FunctionSelector =
        comptime { FunctionSelector::from_signature("transfer_in_private((Field),(Field),u128,Field)") };

    #[storage]
    struct Storage<Context> {
        registry: PublicImmutable<AztecAddress, Context>,
        config: PublicImmutable<RegistryConfig, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress, fee_token: AztecAddress, treasury: AztecAddress, annual_price: u128, price_version: u32) {
        assert(!registry.is_zero(), "registry required");
        assert(price_version > 0, "price version required");
        if fee_token.is_zero() {
            assert(annual_price == 0, "free registry must have zero price");
        } else {
            assert(!treasury.is_zero(), "treasury required");
            assert(annual_price <= MAX_ANNUAL_PRICE, "annual price too large");
        }
        self.storage.registry.initialize(registry);
        self.storage.config.initialize(RegistryConfig { fee_token, treasury, annual_price, price_version });
    }

    #[external("private")]
    fn commit(c: Field) {
        self.call(NameRegistryV3::at(self.storage.registry.read()).commit(c));
    }

    #[external("private")]
    fn register(label: [u8; 31], len: u32, expected_generation: u32, duration: u64, max_fee: u128, quote_expiry: u64, fee_nonce: Field, secret: Field) {
        assert_duration(duration);
        let registry = self.storage.registry.read();
        let config = self.storage.config.read();
        let owner = self.msg_sender();
        let packed = pack_label(label, len);
        let node = node_from_packed(packed, len);
        let base = compute_register_commitment(self.context.chain_id(), registry, node, expected_generation, owner.to_field(), duration,
            config.fee_token, config.treasury, config.price_version, max_fee, quote_expiry, secret);
        let c = modular_commitment(self.context.this_address(), base);
        self.internal.charge_fee(config, owner, duration, max_fee, fee_nonce);
        self.enqueue(NameRegistryV3::at(registry).register_from_registrar(node, expected_generation, owner.to_field(), c, duration, quote_expiry, packed, len));
    }

    #[external("private")]
    fn renew(node: Field, generation: u32, expected_revision: u32, duration: u64, max_fee: u128, quote_expiry: u64, fee_nonce: Field) {
        assert_duration(duration);
        let owner = self.msg_sender();
        self.internal.charge_fee(self.storage.config.read(), owner, duration, max_fee, fee_nonce);
        self.enqueue(NameRegistryV3::at(self.storage.registry.read()).renew_from_registrar(node, generation, expected_revision, owner.to_field(), duration, quote_expiry));
    }

    #[internal("private")]
    fn charge_fee(config: RegistryConfig, payer: AztecAddress, duration: u64, max_fee: u128, fee_nonce: Field) {
        let fee = if config.fee_token.is_zero() { 0 } else { fee_for(config.annual_price, duration) };
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

    #[external("utility")]
    unconstrained fn register_commitment(owner: AztecAddress, label: [u8; 31], len: u32, expected_generation: u32, duration: u64, max_fee: u128, quote_expiry: u64, secret: Field) -> Field {
        let config = self.storage.config.read();
        let base = compute_register_commitment(self.context.chain_id(), self.storage.registry.read(), node_from_packed(pack_label(label, len), len), expected_generation, owner.to_field(), duration,
            config.fee_token, config.treasury, config.price_version, max_fee, quote_expiry, secret);
        modular_commitment(self.context.this_address(), base)
    }
}
