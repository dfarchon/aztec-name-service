// Governance is public-only. Retain only slot descriptors in generic Storage, rather than
// duplicating PrivateContext in each appended field. Reads/writes require an explicit PublicContext
// and delegate to the pinned PublicMutable implementation. No raw storage or initialization bypass.
use aztec::{context::PublicContext, state_vars::{PublicMutable, StateVariable}, protocol::{traits::Packable, storage::map::derive_storage_slot_in_map}};

pub struct GovernanceValue<T> { slot: Field }
impl<T, Context, let N: u32> StateVariable<N, Context> for GovernanceValue<T>
where T: Packable<N = N> {
    fn new(_context: Context, slot: Field) -> Self {
        assert(slot != 0, "Storage slot 0 not allowed");
        GovernanceValue { slot }
    }
    fn get_storage_slot(self) -> Field { self.slot }
}
impl<T> GovernanceValue<T> {
    pub unconstrained fn read(self, context: PublicContext) -> T where T: Packable {
        PublicMutable::<T, PublicContext>::new(context, self.slot).read()
    }
    pub unconstrained fn write(self, context: PublicContext, value: T) where T: Packable {
        PublicMutable::<T, PublicContext>::new(context, self.slot).write(value);
    }
}
pub struct GovernanceMap<T> { slot: Field }
impl<T, Context> StateVariable<1, Context> for GovernanceMap<T> {
    fn new(_context: Context, slot: Field) -> Self {
        assert(slot != 0, "Storage slot 0 not allowed");
        GovernanceMap { slot }
    }
    fn get_storage_slot(self) -> Field { self.slot }
}
impl<T> GovernanceMap<T> {
    pub fn at<let N: u32>(self, key: Field) -> GovernanceValue<T> where T: Packable<N = N> {
        GovernanceValue { slot: derive_storage_slot_in_map(self.slot, key) }
    }
}
