use aztec::macros::aztec;
// TXE-only binding fixture. Actual fee and resolver calls are tested on the local chain.
#[aztec]
pub contract V4TestModule {
    use aztec::{macros::{functions::{external, initializer, view}, storage::storage}, protocol::address::AztecAddress, state_vars::PublicImmutable};
    #[storage]
    struct Storage<Context> { registry: PublicImmutable<AztecAddress, Context> }
    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress) { self.storage.registry.initialize(registry); }
    #[external("public")]
    #[view]
    fn get_registry() -> AztecAddress { self.storage.registry.read() }
}
