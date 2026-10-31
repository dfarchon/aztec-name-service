use aztec::{protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField}, test::helpers::test_environment::TestEnvironment};
use ans_common::logic::{pack_label, node_from_packed, DOMAIN_LABEL_V1, DOMAIN_NODE_V1};
use crate::NameRegistryV6;
use v4_test_module::V4TestModule;
global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
struct Setup { env: TestEnvironment, owner: AztecAddress, other: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress, node: Field }
unconstrained fn label<let N: u32>(s: str<N>) -> [u8;31] { let mut out=[0 as u8;31]; for i in 0..N {out[i]=s.as_bytes()[i];} out }
unconstrained fn setup() -> Setup {
    let mut env=TestEnvironment::new(); let owner=env.create_light_account(); let other=env.create_light_account();
    let registry=env.deploy("NameRegistryV6").with_public_initializer(owner,NameRegistryV6::interface().constructor(AztecAddress::zero()));
    // Isolated core policy tests use a binding fixture for the authorized module.
    // Actual registrar/resolver cross-contract authorization is exercised by test:extensions.
    let registrar=env.deploy("@v4_test_module/V4TestModule").with_public_initializer(owner,V4TestModule::interface().constructor(registry)); let resolver=registrar;
    env.call_public(owner,NameRegistryV6::at(registry).bootstrap(registrar,resolver));
    env.call_private(owner,NameRegistryV6::at(registry).commit(123)); env.advance_next_block_timestamp_by(61);
    let packed=pack_label(label("alice"),5);let node=node_from_packed(packed,5);
    env.call_public(registrar,NameRegistryV6::at(registry).register_from_registrar(node,0,owner.to_field(),123,YEAR,FUTURE,packed,5));
    Setup {env,owner,other,registry,registrar,resolver,node:node_from_packed(pack_label(label("alice"),5),5)}
}
unconstrained fn issue(s: Setup) -> Field {
    let rec=s.env.view_public(NameRegistryV6::at(s.registry).get_name(s.node));
    s.env.call_private(s.owner,NameRegistryV6::at(s.registry).issue_subname(s.node,1,0,label("team"),4,0,s.other,rec.expires_at));
    let hash=poseidon2_hash_with_separator([4,pack_label(label("team"),4)],DOMAIN_LABEL_V1);
    poseidon2_hash_with_separator([s.node,hash],DOMAIN_NODE_V1)
}
#[test(should_fail_with="not record editor")]
unconstrained fn unauthorized_text_write() { let s=setup();s.env.call_private(s.other,NameRegistryV6::at(s.registry).set_text(s.node,1,0,1,[0;248],0)); }
#[test(should_fail_with="nonzero record padding")]
unconstrained fn malformed_text_padding() { let s=setup();let mut value=[0 as u8;248];value[247]=1;s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_text(s.node,1,0,1,value,1)); }
#[test(should_fail_with="record too long")]
unconstrained fn oversized_text() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_text(s.node,1,0,1,[0;248],249)); }
#[test(should_fail_with="record key limit reached")]
unconstrained fn text_key_limit() { let s=setup();for i in 0..65 {s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_text(s.node,1,i,i as Field+1,[0;248],0));} }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_issue_subname() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_manager(s.node,1,0,s.other));let r=s.env.view_public(NameRegistryV6::at(s.registry).get_name(s.node));s.env.call_private(s.other,NameRegistryV6::at(s.registry).issue_subname(s.node,1,1,label("team"),4,0,s.other,r.expires_at)); }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_assign_editor() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.other,NameRegistryV6::at(s.registry).set_manager(s.node,1,1,s.owner)); }
#[test(should_fail_with="subname lease is controlled by parent")]
unconstrained fn child_cannot_use_paid_renewal() { let s=setup();let child=issue(s);s.env.call_public(s.registrar,NameRegistryV6::at(s.registry).renew_from_registrar(child,1,0,s.other.to_field(),YEAR,FUTURE)); }
#[test(should_fail_with="not record editor")]
unconstrained fn removed_editor_cannot_write() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_manager(s.node,1,1,AztecAddress::zero()));s.env.call_public(s.resolver,NameRegistryV6::at(s.registry).address_from_resolver(s.node,1,2,s.other.to_field(),true,s.other)); }
#[test(should_fail_with="not transfer recipient")]
unconstrained fn wrong_recipient_cannot_accept() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV6::at(s.registry).accept_transfer(s.node,1,1)); }
#[test(should_fail_with="generation or revision mismatch")]
unconstrained fn changed_revision_blocks_acceptance() { let s=setup();s.env.call_private(s.owner,NameRegistryV6::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV6::at(s.registry).set_manager(s.node,1,1,s.other));s.env.call_private(s.other,NameRegistryV6::at(s.registry).accept_transfer(s.node,1,1)); }
#[test]
unconstrained fn parent_expiry_limits_child_and_cannot_revive() { let s=setup();let child=issue(s);s.env.advance_next_block_timestamp_by(YEAR+1);let rec=s.env.view_public(NameRegistryV6::at(s.registry).get_name(child));let old=rec.expires_at;s.env.call_public(s.registrar,NameRegistryV6::at(s.registry).renew_from_registrar(s.node,1,0,s.owner.to_field(),YEAR,FUTURE));assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_name(child)).expires_at,old); }

#[test(should_fail_with="already initialized")]
unconstrained fn modules_cannot_be_reinitialized() { let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).bootstrap(s.registrar,s.resolver)); }
#[test(should_fail_with="not administrator")]
unconstrained fn another_account_cannot_initialize_modules() { let s=setup();s.env.call_public(s.other,NameRegistryV6::at(s.registry).bootstrap(s.registrar,s.resolver)); }

#[test]
unconstrained fn administrator_configures_modules_immediately() {
    let mut s=setup();let next=s.env.deploy("@v4_test_module/V4TestModule").with_public_initializer(s.owner,V4TestModule::interface().constructor(s.registry));
    s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,next,next));
    let modules=s.env.view_public(NameRegistryV6::at(s.registry).get_modules());
    assert_eq(modules.registrar,next);assert_eq(modules.resolver,next);assert_eq(modules.revision,2);
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_name(s.node)).owner,s.owner);
}
#[test(should_fail_with="not administrator")]
unconstrained fn other_account_cannot_configure_modules() { let s=setup();s.env.call_public(s.other,NameRegistryV6::at(s.registry).configure_modules(1,s.registrar,s.resolver)); }
#[test(should_fail_with="module belongs to another registry")]
unconstrained fn administrator_cannot_bind_foreign_module() {
    let mut s=setup();let foreign=s.env.deploy("@v4_test_module/V4TestModule").with_public_initializer(s.owner,V4TestModule::interface().constructor(s.other));
    s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,foreign,s.resolver));
}
#[test(should_fail_with="not administrator")]
unconstrained fn previous_administrator_loses_configuration_authority() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).nominate_administrator(s.other));
    s.env.call_public(s.other,NameRegistryV6::at(s.registry).accept_administrator());
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_administrator()),s.other);
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_pending_administrator()),AztecAddress::zero());
    s.env.call_public(s.other,NameRegistryV6::at(s.registry).configure_modules(1,s.registrar,s.resolver));
    s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(2,s.registrar,s.resolver));
}
#[test]
unconstrained fn nomination_alone_does_not_transfer_authority() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).nominate_administrator(s.other));
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_administrator()),s.owner);
    s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,s.registrar,s.resolver));
}
#[test(should_fail_with="not pending administrator")]
unconstrained fn only_nominee_can_accept() { let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).nominate_administrator(s.other));s.env.call_public(s.owner,NameRegistryV6::at(s.registry).accept_administrator()); }
#[test(should_fail_with="not pending administrator")]
unconstrained fn cancelled_nomination_cannot_be_accepted() { let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).nominate_administrator(s.other));s.env.call_public(s.owner,NameRegistryV6::at(s.registry).nominate_administrator(AztecAddress::zero()));s.env.call_public(s.other,NameRegistryV6::at(s.registry).accept_administrator()); }
#[test(should_fail_with="not administrator")]
unconstrained fn other_account_cannot_nominate() { let s=setup();s.env.call_public(s.other,NameRegistryV6::at(s.registry).nominate_administrator(s.other)); }
#[test]
unconstrained fn expired_unused_commit_can_be_refreshed() {
    let s=setup();s.env.call_private(s.other,NameRegistryV6::at(s.registry).commit(456));
    let first=s.env.view_public(NameRegistryV6::at(s.registry).get_commit(456)).committed_at;
    s.env.advance_next_block_timestamp_by(86400);s.env.call_private(s.other,NameRegistryV6::at(s.registry).commit(456));
    let refreshed=s.env.view_public(NameRegistryV6::at(s.registry).get_commit(456));
    assert(refreshed.committed_at>first);assert(!refreshed.consumed);
}
#[test]
unconstrained fn live_commit_is_not_refreshed() {
    let s=setup();s.env.call_private(s.other,NameRegistryV6::at(s.registry).commit(456));
    let first=s.env.view_public(NameRegistryV6::at(s.registry).get_commit(456)).committed_at;
    s.env.advance_next_block_timestamp_by(100);s.env.call_private(s.other,NameRegistryV6::at(s.registry).commit(456));
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_commit(456)).committed_at,first);
}
#[test]
unconstrained fn consumed_commit_is_never_refreshed() {
    let s=setup();s.env.advance_next_block_timestamp_by(86400);s.env.call_private(s.other,NameRegistryV6::at(s.registry).commit(123));
    let rec=s.env.view_public(NameRegistryV6::at(s.registry).get_commit(123));assert(rec.consumed);
}

#[test(should_fail_with="revision mismatch")]
unconstrained fn stale_module_configuration_cannot_overwrite() {
    let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,s.registrar,s.resolver));
    s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,s.registrar,s.resolver));
}
#[test(should_fail_with="module required")]
unconstrained fn module_configuration_cannot_use_zero_address() { let s=setup();s.env.call_public(s.owner,NameRegistryV6::at(s.registry).configure_modules(1,AztecAddress::zero(),s.resolver)); }
