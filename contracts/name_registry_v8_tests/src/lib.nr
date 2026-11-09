use aztec::{protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField}, test::helpers::test_environment::TestEnvironment};
use ans_common::logic::{pack_label, node_from_packed, DOMAIN_LABEL_V1, DOMAIN_NODE_V1};
use name_registry_v8::NameRegistryV8;
mod class_ids;
use class_ids::V8_CLASS;
use v4_test_module::V4TestModule;
global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
struct Setup { env: TestEnvironment, owner: AztecAddress, other: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress, node: Field }
unconstrained fn label<let N: u32>(s: str<N>) -> [u8;31] { let mut out=[0 as u8;31]; for i in 0..N {out[i]=s.as_bytes()[i];} out }
unconstrained fn setup() -> Setup {
    let mut env=TestEnvironment::new(); let owner=env.create_light_account(); let other=env.create_light_account();
    let registry=env.deploy("@name_registry_v8/NameRegistryV8").with_public_initializer(owner,NameRegistryV8::interface().constructor(AztecAddress::zero(), V8_CLASS));
    // Isolated core policy tests use a binding fixture for the authorized module.
    // Actual registrar/resolver cross-contract authorization is exercised by test:extensions.
    let registrar=env.deploy("@v4_test_module/V4TestModule").with_public_initializer(owner,V4TestModule::interface().constructor(registry)); let resolver=registrar;
    env.call_public(owner,NameRegistryV8::at(registry).bootstrap(registrar,resolver));
    env.call_private(owner,NameRegistryV8::at(registry).commit(123)); env.advance_next_block_timestamp_by(61);
    let packed=pack_label(label("alice"),5);let node=node_from_packed(packed,5);
    env.call_public(registrar,NameRegistryV8::at(registry).register_from_registrar(node,0,owner.to_field(),123,YEAR,FUTURE,packed,5));
    Setup {env,owner,other,registry,registrar,resolver,node:node_from_packed(pack_label(label("alice"),5),5)}
}
unconstrained fn issue(s: Setup) -> Field {
    let rec=s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node));
    s.env.call_private(s.owner,NameRegistryV8::at(s.registry).issue_subname(s.node,1,0,label("team"),4,0,s.other,rec.expires_at));
    let hash=poseidon2_hash_with_separator([4,pack_label(label("team"),4)],DOMAIN_LABEL_V1);
    poseidon2_hash_with_separator([s.node,hash],DOMAIN_NODE_V1)
}
#[test(should_fail_with="not record editor")]
unconstrained fn unauthorized_text_write() { let s=setup();s.env.call_private(s.other,NameRegistryV8::at(s.registry).set_text(s.node,1,0,1,[0;248],0)); }
#[test(should_fail_with="nonzero record padding")]
unconstrained fn malformed_text_padding() { let s=setup();let mut value=[0 as u8;248];value[247]=1;s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_text(s.node,1,0,1,value,1)); }
#[test(should_fail_with="record too long")]
unconstrained fn oversized_text() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_text(s.node,1,0,1,[0;248],249)); }
#[test(should_fail_with="record key limit reached")]
unconstrained fn text_key_limit() { let s=setup();for i in 0..65 {s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_text(s.node,1,i,i as Field+1,[0;248],0));} }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_issue_subname() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_manager(s.node,1,0,s.other));let r=s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node));s.env.call_private(s.other,NameRegistryV8::at(s.registry).issue_subname(s.node,1,1,label("team"),4,0,s.other,r.expires_at)); }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_assign_editor() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.other,NameRegistryV8::at(s.registry).set_manager(s.node,1,1,s.owner)); }
#[test(should_fail_with="subname lease is controlled by parent")]
unconstrained fn child_cannot_use_paid_renewal() { let s=setup();let child=issue(s);s.env.call_public(s.registrar,NameRegistryV8::at(s.registry).renew_from_registrar(child,1,0,s.other.to_field(),YEAR,FUTURE)); }
#[test(should_fail_with="not record editor")]
unconstrained fn removed_editor_cannot_write() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_manager(s.node,1,1,AztecAddress::zero()));s.env.call_public(s.resolver,NameRegistryV8::at(s.registry).address_from_resolver(s.node,1,0,s.other.to_field(),true,s.other)); }
#[test(should_fail_with="not transfer recipient")]
unconstrained fn wrong_recipient_cannot_accept() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV8::at(s.registry).accept_transfer(s.node,1,1)); }
#[test(should_fail_with="generation or revision mismatch")]
unconstrained fn changed_revision_blocks_acceptance() { let s=setup();s.env.call_private(s.owner,NameRegistryV8::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV8::at(s.registry).set_manager(s.node,1,1,s.other));s.env.call_private(s.other,NameRegistryV8::at(s.registry).accept_transfer(s.node,1,1)); }
#[test]
unconstrained fn parent_expiry_limits_child_and_cannot_revive() { let s=setup();let child=issue(s);s.env.advance_next_block_timestamp_by(YEAR+1);let rec=s.env.view_public(NameRegistryV8::at(s.registry).get_name(child));let old=rec.expires_at;s.env.call_public(s.registrar,NameRegistryV8::at(s.registry).renew_from_registrar(s.node,1,1,s.owner.to_field(),YEAR,FUTURE));assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(child)).expires_at,old); }

#[test(should_fail_with="already initialized")]
unconstrained fn modules_cannot_be_reinitialized() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).bootstrap(s.registrar,s.resolver)); }
#[test(should_fail_with="not administrator")]
unconstrained fn another_account_cannot_initialize_modules() { let s=setup();s.env.call_public(s.other,NameRegistryV8::at(s.registry).bootstrap(s.registrar,s.resolver)); }

#[test]
unconstrained fn administrator_configures_modules_immediately() {
    let mut s=setup();let next=s.env.deploy("@v4_test_module/V4TestModule").with_public_initializer(s.owner,V4TestModule::interface().constructor(s.registry));
    s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,next,next));
    let modules=s.env.view_public(NameRegistryV8::at(s.registry).get_modules());
    assert_eq(modules.registrar,next);assert_eq(modules.resolver,next);assert_eq(modules.revision,2);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).owner,s.owner);
}
#[test(should_fail_with="not administrator")]
unconstrained fn other_account_cannot_configure_modules() { let s=setup();s.env.call_public(s.other,NameRegistryV8::at(s.registry).configure_modules(1,s.registrar,s.resolver)); }
#[test(should_fail_with="module belongs to another registry")]
unconstrained fn administrator_cannot_bind_foreign_module() {
    let mut s=setup();let foreign=s.env.deploy("@v4_test_module/V4TestModule").with_public_initializer(s.owner,V4TestModule::interface().constructor(s.other));
    s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,foreign,s.resolver));
}
#[test(should_fail_with="not administrator")]
unconstrained fn previous_administrator_loses_configuration_authority() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).nominate_administrator(0, s.other));
    s.env.call_public(s.other,NameRegistryV8::at(s.registry).accept_administrator(1));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_administrator()),s.other);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_pending_administrator()),AztecAddress::zero());
    s.env.call_public(s.other,NameRegistryV8::at(s.registry).configure_modules(1,s.registrar,s.resolver));
    s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(2,s.registrar,s.resolver));
}
#[test]
unconstrained fn nomination_alone_does_not_transfer_authority() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).nominate_administrator(0, s.other));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_administrator()),s.owner);
    s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,s.registrar,s.resolver));
}
#[test(should_fail_with="not pending administrator")]
unconstrained fn only_nominee_can_accept() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).nominate_administrator(0, s.other));s.env.call_public(s.owner,NameRegistryV8::at(s.registry).accept_administrator(1)); }
#[test(should_fail_with="not pending administrator")]
unconstrained fn cancelled_nomination_cannot_be_accepted() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).nominate_administrator(0, s.other));s.env.call_public(s.owner,NameRegistryV8::at(s.registry).nominate_administrator(1, AztecAddress::zero()));s.env.call_public(s.other,NameRegistryV8::at(s.registry).accept_administrator(2)); }
#[test(should_fail_with="not administrator")]
unconstrained fn other_account_cannot_nominate() { let s=setup();s.env.call_public(s.other,NameRegistryV8::at(s.registry).nominate_administrator(0, s.other)); }
#[test]
unconstrained fn expired_unused_commit_can_be_refreshed() {
    let s=setup();s.env.call_private(s.other,NameRegistryV8::at(s.registry).commit(456));
    let first=s.env.view_public(NameRegistryV8::at(s.registry).get_commit(456)).committed_at;
    s.env.advance_next_block_timestamp_by(86400);s.env.call_private(s.other,NameRegistryV8::at(s.registry).commit(456));
    let refreshed=s.env.view_public(NameRegistryV8::at(s.registry).get_commit(456));
    assert(refreshed.committed_at>first);assert(!refreshed.consumed);
}
#[test]
unconstrained fn live_commit_is_not_refreshed() {
    let s=setup();s.env.call_private(s.other,NameRegistryV8::at(s.registry).commit(456));
    let first=s.env.view_public(NameRegistryV8::at(s.registry).get_commit(456)).committed_at;
    s.env.advance_next_block_timestamp_by(100);s.env.call_private(s.other,NameRegistryV8::at(s.registry).commit(456));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_commit(456)).committed_at,first);
}
#[test]
unconstrained fn consumed_commit_is_never_refreshed() {
    let s=setup();s.env.advance_next_block_timestamp_by(86400);s.env.call_private(s.other,NameRegistryV8::at(s.registry).commit(123));
    let rec=s.env.view_public(NameRegistryV8::at(s.registry).get_commit(123));assert(rec.consumed);
}

#[test(should_fail_with="revision mismatch")]
unconstrained fn stale_module_configuration_cannot_overwrite() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,s.registrar,s.resolver));
    s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,s.registrar,s.resolver));
}
#[test(should_fail_with="module required")]
unconstrained fn module_configuration_cannot_use_zero_address() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).configure_modules(1,AztecAddress::zero(),s.resolver)); }

use evil_resolver_test::EvilResolverTest;
use aztec::{context::{PrivateCall, PublicCall, UtilityCall}, protocol::abis::function_selector::FunctionSelector};

// Raw calls intentionally avoid importing the legacy registry crates embedded in the frozen modules.
unconstrained fn real_resolver(s: Setup) -> AztecAddress {
    let mut env = s.env;
    env.deploy("@name_resolver/NameResolver").with_public_initializer(s.owner,
        PublicCall::<_, _, ()>::new(AztecAddress::zero(), comptime { FunctionSelector::from_signature("constructor((Field))") }, "constructor", [s.registry.to_field()]))
}
unconstrained fn evil(s: Setup) -> AztecAddress {
    let mut env = s.env;
    env.deploy("@evil_resolver_test/EvilResolverTest").with_public_initializer(s.owner, EvilResolverTest::interface().constructor(s.registry))
}
unconstrained fn evil_transfer(s: Setup) -> AztecAddress {
    let attacker = evil(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, attacker));
    // The seller explicitly chose this resolver, so it may write in the seller's generation.
    s.env.call_public(s.other, EvilResolverTest::at(attacker).write(s.node, 1, 1, s.owner.to_field(), true, s.other));
    assert(s.env.view_public(NameRegistryV8::at(s.registry).get_address(s.node, 1)).present);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).offer_transfer(s.node, 1, 1, s.other));
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).accept_transfer(s.node, 1, 2));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_resolver(s.node, 2)), s.resolver);
    assert(!s.env.view_public(NameRegistryV8::at(s.registry).get_address(s.node, 2)).present);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 2)), 0);
    attacker
}
#[test(should_fail_with = "unauthorized resolver")]
unconstrained fn h01_malicious_resolver_cannot_write_after_transfer() {
    let s = setup(); let attacker = evil_transfer(s);
    s.env.call_public(s.other, EvilResolverTest::at(attacker).write(s.node, 2, 0, s.other.to_field(), true, s.owner));
}
#[test(should_fail_with = "forward record does not point to caller")]
unconstrained fn h01_attacker_cannot_forge_primary_after_transfer() {
    let s = setup(); let _ = evil_transfer(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_primary(s.node, 2, 0));
}
#[test]
unconstrained fn buyer_can_write_through_frozen_default_resolver() {
    let mut s = setup(); let default = real_resolver(s);
    s.env.call_public(s.owner, NameRegistryV8::at(s.registry).configure_modules(1, s.registrar, default));
    s.resolver = default; let _ = evil_transfer(s);
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_manager(s.node, 2, 0, s.owner));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, 1);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 2)), 0);
    s.env.call_private(s.other, PrivateCall::<_, _, ()>::new(default,
        comptime { FunctionSelector::from_signature("set_address(Field,u32,u32,bool,(Field))") }, "set_address", [s.node, 2, 0, 1, s.other.to_field()]));
    let forward = s.env.view_public(NameRegistryV8::at(s.registry).get_address(s.node, 2));
    assert(forward.present); assert_eq(forward.addr, s.other);
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_primary(s.node, 2, forward.binding_version));
    assert(s.env.view_public(NameRegistryV8::at(s.registry).get_primary(s.other)).present);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, 1);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 2)), 1);
}
#[test(should_fail_with = "not record editor")]
unconstrained fn resolver_cannot_pass_a_non_editor_owner() {
    let s = setup(); let attacker = evil(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, attacker));
    s.env.call_public(s.other, EvilResolverTest::at(attacker).write(s.node, 1, 1, s.other.to_field(), true, s.other));
}
#[test]
unconstrained fn editor_writes_do_not_invalidate_holder_actions() {
    let mut s = setup(); let next = real_resolver(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_manager(s.node, 1, 0, s.other));
    let revision = s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision;
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 1, [0; 248], 0));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, revision);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 1)), 1);
    s.env.call_public(s.registrar, NameRegistryV8::at(s.registry).renew_from_registrar(s.node, 1, revision, s.owner.to_field(), YEAR, FUTURE));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_manager(s.node, 1, revision + 1, AztecAddress::zero()));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, revision + 2, next));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, revision + 3);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 1)), 2);
}
#[test(should_fail_with = "generation or revision mismatch")]
unconstrained fn stale_record_revision_cannot_overwrite_editor_records() {
    let s = setup();
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 1, [0;248], 0));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 2, [0;248], 0));
}
#[test(should_fail_with = "name not active")]
unconstrained fn editor_cannot_write_in_grace() {
    let s = setup();
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_manager(s.node, 1, 0, s.other));
    s.env.advance_next_block_timestamp_by(YEAR + 1);
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 1, [0;248], 0));
}
#[test]
unconstrained fn holder_can_renew_in_grace_after_editor_write() {
    let s = setup();
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_manager(s.node, 1, 0, s.other));
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 1, [0;248], 0));
    s.env.advance_next_block_timestamp_by(YEAR + 1);
    s.env.call_public(s.registrar, NameRegistryV8::at(s.registry).renew_from_registrar(s.node, 1, 1, s.owner.to_field(), YEAR, FUTURE));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, 2);
}
#[test]
unconstrained fn manager_write_cannot_invalidate_accept_transfer() {
    let s = setup();
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_manager(s.node, 1, 0, s.other));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).offer_transfer(s.node, 1, 1, s.other));
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_text(s.node, 1, 0, 1, [0;248], 0));
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).accept_transfer(s.node, 1, 2));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).owner, s.other);
}
#[test]
unconstrained fn malicious_record_revision_pumping_cannot_block_resolver_reset() {
    let s = setup(); let attacker = evil(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, attacker));
    for revision in 1..6 {
        s.env.call_public(s.other, EvilResolverTest::at(attacker).write(s.node, 1, revision, s.owner.to_field(), true, s.other));
    }
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 1, s.resolver));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_resolver(s.node, 1)), s.resolver);
    assert(!s.env.view_public(NameRegistryV8::at(s.registry).get_address(s.node, 1)).present);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).revision, 2);
}
#[test(should_fail_with = "module required")]
unconstrained fn resolver_cannot_be_zero() { let s = setup(); s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, AztecAddress::zero())); }
#[test(should_fail_with = "registry is not a module")]
unconstrained fn resolver_cannot_be_the_registry() { let s = setup(); s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, s.registry)); }
#[test]
unconstrained fn implementation_and_new_record_revision_view() { let s = setup(); assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).implementation_version()), 8); assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_record_revision(s.node, 1)), 0); }

unconstrained fn launch_setup() -> Setup {
    let mut s = setup();
    let r = s.env.deploy("@name_registrar_launch/NameRegistrarLaunch").with_public_initializer(s.owner,
        PublicCall::<_, _, ()>::new(AztecAddress::zero(), comptime { FunctionSelector::from_signature("constructor((Field),(Field),(Field),u128,u128,u128,u32,u32,bool,u64)") }, "constructor", [s.registry.to_field(), 0, s.owner.to_field(), 0, 0, 0, 1, 7, 0, YEAR as Field]));
    s.env.call_public(s.owner, NameRegistryV8::at(s.registry).configure_modules(1, r, s.resolver));
    s.registrar = r; s
}
unconstrained fn launch_register(s: Setup, admin: bool) -> Field {
    let bytes = label("seventh"); let mut args = [0; 38];
    for i in 0..31 { args[i] = bytes[i] as Field; }
    args[31] = 7; args[33] = YEAR as Field; args[35] = FUTURE as Field; args[36] = 1; args[37] = 123;
    let mut quote_args = [0; 38]; quote_args[0] = s.other.to_field();
    for i in 0..31 { quote_args[i + 1] = bytes[i] as Field; }
    quote_args[32] = 7; quote_args[34] = YEAR as Field; quote_args[36] = FUTURE as Field; quote_args[37] = 123;
    let c = if admin {
        let mut mint = [0; 36]; mint[0] = s.other.to_field();
        for i in 0..31 { mint[i + 1] = bytes[i] as Field; }
        mint[32] = 7; mint[34] = FUTURE as Field; mint[35] = 123;
        s.env.execute_utility(UtilityCall::<_, _, Field>::new(s.registrar, comptime { FunctionSelector::from_signature("admin_commitment((Field),[u8;31],u32,u32,u64,Field)") }, "admin_commitment", mint))
    } else {
        s.env.execute_utility(UtilityCall::<_, _, Field>::new(s.registrar, comptime { FunctionSelector::from_signature("register_commitment((Field),[u8;31],u32,u32,u64,u128,u64,Field)") }, "register_commitment", quote_args))
    };
    s.env.call_private(if admin { s.owner } else { s.other }, PrivateCall::<_, _, ()>::new(s.registrar, comptime { FunctionSelector::from_signature("commit(Field)") }, "commit", [c]));
    s.env.advance_next_block_timestamp_by(61);
    if admin {
        let mut mint = [0; 36]; for i in 0..31 { mint[i] = bytes[i] as Field; }
        mint[31] = 7; mint[32] = s.other.to_field(); mint[34] = FUTURE as Field; mint[35] = 123;
        s.env.call_private(s.owner, PrivateCall::<_, _, ()>::new(s.registrar, comptime { FunctionSelector::from_signature("admin_register([u8;31],u32,(Field),u32,u64,Field)") }, "admin_register", mint));
    } else {
        s.env.call_private(s.other, PrivateCall::<_, _, ()>::new(s.registrar, comptime { FunctionSelector::from_signature("register([u8;31],u32,u32,u64,u128,u64,Field,Field)") }, "register", args));
    }
    node_from_packed(pack_label(bytes, 7), 7)
}
unconstrained fn launch_renew(s: Setup, node: Field, revision: u32) {
    let bytes = label("seventh"); let mut args = [0; 38]; for i in 0..31 { args[i] = bytes[i] as Field; }
    args[31] = 7; args[32] = 1; args[33] = revision as Field; args[34] = YEAR as Field; args[36] = FUTURE as Field; args[37] = 2;
    s.env.call_private(s.other, PrivateCall::<_, _, ()>::new(s.registrar, comptime { FunctionSelector::from_signature("renew([u8;31],u32,u32,u32,u64,u128,u64,Field)") }, "renew", args));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(node)).revision, revision + 1);
}
#[test]
unconstrained fn frozen_launch_register_renew_uses_holder_revision() {
    let s = launch_setup(); let n = launch_register(s, false);
    let before = s.env.view_public(NameRegistryV8::at(s.registry).get_name(n));
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_text(n, 1, 0, 1, [0;248], 0));
    launch_renew(s, n, before.revision);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(n)).expires_at, before.expires_at + YEAR);
}
#[test]
unconstrained fn frozen_launch_admin_mint_uses_v7_live_administrator() {
    let s = launch_setup(); let n = launch_register(s, true);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(n)).owner, s.other);
}
#[test(should_fail_with = "renewal too early")]
unconstrained fn frozen_launch_one_year_cap_still_applies_on_v7() {
    let s = launch_setup(); let n = launch_register(s, false); launch_renew(s, n, 0); launch_renew(s, n, 1);
}

#[test(should_fail_with = "unauthorized resolver")]
unconstrained fn old_resolver_cannot_write_after_expiry_grace_and_reregistration() {
    let s = setup(); let attacker = evil(s);
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).set_resolver(s.node, 1, 0, attacker));
    s.env.advance_next_block_timestamp_by(YEAR + 30 * 86400 + 1);
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).commit(456));
    s.env.advance_next_block_timestamp_by(61);
    let packed = pack_label(label("alice"), 5);
    s.env.call_public(s.registrar, NameRegistryV8::at(s.registry).register_from_registrar(s.node, 1, s.other.to_field(), 456, YEAR, FUTURE, packed, 5));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node)).generation, 2);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_resolver(s.node, 2)), s.resolver);
    assert(!s.env.view_public(NameRegistryV8::at(s.registry).get_address(s.node, 2)).present);
    s.env.call_public(s.owner, EvilResolverTest::at(attacker).write(s.node, 2, 0, s.other.to_field(), true, s.owner));
}
#[test(should_fail_with = "unauthorized resolver")]
unconstrained fn old_resolver_cannot_write_after_subname_revocation_and_reissue() {
    let s = setup(); let child = issue(s); let attacker = evil(s);
    s.env.call_private(s.other, NameRegistryV8::at(s.registry).set_resolver(child, 1, 0, attacker));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).revoke_subname(child, 1, 1, 1));
    let parent = s.env.view_public(NameRegistryV8::at(s.registry).get_name(s.node));
    s.env.call_private(s.owner, NameRegistryV8::at(s.registry).issue_subname(s.node, 1, parent.revision, label("team"), 4, 2, s.owner, parent.expires_at));
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_name(child)).generation, 3);
    assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_resolver(child, 3)), s.resolver);
    assert(!s.env.view_public(NameRegistryV8::at(s.registry).get_address(child, 3)).present);
    s.env.call_public(s.other, EvilResolverTest::at(attacker).write(child, 3, 0, s.owner.to_field(), true, s.other));
}

#[test(should_fail_with="not administrator")]
unconstrained fn other_cannot_approve_release() { let s=setup();s.env.call_public(s.other,NameRegistryV8::at(s.registry).approve_release(0,123,0x414e535f434f5245,2)); }
#[test(should_fail_with="upgrade nonce mismatch")]
unconstrained fn stale_upgrade_nonce() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).approve_release(1,123,0x414e535f434f5245,2)); }
#[test(should_fail_with="wrong core family")]
unconstrained fn wrong_release_family() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).approve_release(0,123,0,2)); }
#[test(should_fail_with="class not registered")]
unconstrained fn unregistered_release() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).approve_release(0,123,0x414e535f434f5245,2)); }
#[test(should_fail_with="release not approved")]
unconstrained fn unapproved_target() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).propose_upgrade(0,V8_CLASS,123)); }
#[test(should_fail_with="wrong source class")]
unconstrained fn wrong_upgrade_source() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).propose_upgrade(0,123,456)); }
#[test(should_fail_with="same target class")]
unconstrained fn cannot_propose_current_class() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).propose_upgrade(0,V8_CLASS,V8_CLASS)); }
#[test]
unconstrained fn permissionless_settle_preserves_nonce() { let s=setup();s.env.call_public(s.other,NameRegistryV8::at(s.registry).settle_upgrade());assert_eq(s.env.view_public(NameRegistryV8::at(s.registry).get_upgrade_nonce()),0); }
#[test(should_fail_with="no pending proposal")]
unconstrained fn execute_without_proposal() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).execute_upgrade(0,V8_CLASS,123)); }
#[test(should_fail_with="no scheduled upgrade")]
unconstrained fn cancel_without_schedule() { let s=setup();s.env.call_public(s.owner,NameRegistryV8::at(s.registry).cancel_scheduled_upgrade(0)); }
