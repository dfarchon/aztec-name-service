use aztec::macros::aztec;
// TXE-only malicious resolver: callers can forge the owner argument. Never ship in the SDK.
#[aztec]
pub contract EvilResolverTest {
    use aztec::{context::PublicCall, macros::{functions::{external, initializer, view}, storage::storage}, protocol::{address::AztecAddress, abis::function_selector::FunctionSelector, traits::ToField}, state_vars::PublicImmutable};
    #[storage]
    struct Storage<Context> { registry: PublicImmutable<AztecAddress, Context> }
    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress) { self.storage.registry.initialize(registry); }
    #[external("public")]
    #[view]
    fn get_registry() -> AztecAddress { self.storage.registry.read() }
    #[external("public")]
    fn write(node: Field, generation: u32, revision: u32, owner: Field, present: bool, addr: AztecAddress) {
        self.call(PublicCall::<_, _, ()>::new(self.storage.registry.read(),
            comptime { FunctionSelector::from_signature("address_from_resolver(Field,u32,u32,Field,bool,(Field))") },
            "address_from_resolver", [node, generation as Field, revision as Field, owner, present as Field, addr.to_field()]));
    }
}
