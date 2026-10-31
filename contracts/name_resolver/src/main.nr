use aztec::macros::aztec;

#[aztec]
pub contract NameResolver {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::ToField},
        state_vars::PublicImmutable,
    };
    use ans_common::logic::assert_cleared_record;
    use name_registry_v3::NameRegistryV3;

    #[storage]
    struct Storage<Context> { registry: PublicImmutable<AztecAddress, Context> }

    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress) {
        assert(!registry.is_zero(), "registry required");
        self.storage.registry.initialize(registry);
    }

    #[external("private")]
    fn set_address(node: Field, generation: u32, expected_revision: u32, present: bool, addr: AztecAddress) {
        assert_cleared_record(present, addr);
        self.enqueue(NameRegistryV3::at(self.storage.registry.read()).address_from_resolver(
            node, generation, expected_revision, self.msg_sender().to_field(), present, addr));
    }

    #[external("public")]
    #[view]
    fn get_registry() -> AztecAddress { self.storage.registry.read() }
}
