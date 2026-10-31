use aztec::{protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField}, test::helpers::test_environment::TestEnvironment};
use ans_common::logic::{pack_label, node_from_packed, DOMAIN_LABEL_V1, DOMAIN_NODE_V1};
use crate::NameRegistryV4;
use v4_test_module::V4TestModule;
global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
struct Setup { env: TestEnvironment, owner: AztecAddress, other: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress, node: Field }
unconstrained fn label<let N: u32>(s: str<N>) -> [u8;31] { let mut out=[0 as u8;31]; for i in 0..N {out[i]=s.as_bytes()[i];} out }
unconstrained fn setup() -> Setup {
    let mut env=TestEnvironment::new(); let owner=env.create_light_account(); let other=env.create_light_account();
    let registry=env.deploy("NameRegistryV4").with_public_initializer(owner,NameRegistryV4::interface().constructor(owner,86400,AztecAddress::zero()));
    // Isolated core policy tests use a binding fixture for the authorized module.
    // Actual registrar/resolver cross-contract authorization is exercised by test:extensions.
    let registrar=env.deploy("@v4_test_module/V4TestModule").with_public_initializer(owner,V4TestModule::interface().constructor(registry)); let resolver=registrar;
    env.call_public(owner,NameRegistryV4::at(registry).bootstrap(registrar,resolver));
    env.call_private(owner,NameRegistryV4::at(registry).commit(123)); env.advance_next_block_timestamp_by(61);
    let packed=pack_label(label("alice"),5);let node=node_from_packed(packed,5);
    env.call_public(registrar,NameRegistryV4::at(registry).register_from_registrar(node,0,owner.to_field(),123,YEAR,FUTURE,packed,5));
    Setup {env,owner,other,registry,registrar,resolver,node:node_from_packed(pack_label(label("alice"),5),5)}
}
unconstrained fn issue(s: Setup) -> Field {
    let rec=s.env.view_public(NameRegistryV4::at(s.registry).get_name(s.node));
    s.env.call_private(s.owner,NameRegistryV4::at(s.registry).issue_subname(s.node,1,0,label("team"),4,0,s.other,rec.expires_at));
    let hash=poseidon2_hash_with_separator([4,pack_label(label("team"),4)],DOMAIN_LABEL_V1);
    poseidon2_hash_with_separator([s.node,hash],DOMAIN_NODE_V1)
}
#[test(should_fail_with="not record editor")]
unconstrained fn unauthorized_text_write() { let s=setup();s.env.call_private(s.other,NameRegistryV4::at(s.registry).set_text(s.node,1,0,1,[0;248],0)); }
#[test(should_fail_with="nonzero record padding")]
unconstrained fn malformed_text_padding() { let s=setup();let mut value=[0 as u8;248];value[247]=1;s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_text(s.node,1,0,1,value,1)); }
#[test(should_fail_with="record too long")]
unconstrained fn oversized_text() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_text(s.node,1,0,1,[0;248],249)); }
#[test(should_fail_with="record key limit reached")]
unconstrained fn text_key_limit() { let s=setup();for i in 0..65 {s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_text(s.node,1,i,i as Field+1,[0;248],0));} }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_issue_subname() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_manager(s.node,1,0,s.other));let r=s.env.view_public(NameRegistryV4::at(s.registry).get_name(s.node));s.env.call_private(s.other,NameRegistryV4::at(s.registry).issue_subname(s.node,1,1,label("team"),4,0,s.other,r.expires_at)); }
#[test(should_fail_with="not the holder")]
unconstrained fn editor_cannot_assign_editor() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.other,NameRegistryV4::at(s.registry).set_manager(s.node,1,1,s.owner)); }
#[test(should_fail_with="subname lease is controlled by parent")]
unconstrained fn child_cannot_use_paid_renewal() { let s=setup();let child=issue(s);s.env.call_public(s.registrar,NameRegistryV4::at(s.registry).renew_from_registrar(child,1,0,s.other.to_field(),YEAR,FUTURE)); }
#[test(should_fail_with="not record editor")]
unconstrained fn removed_editor_cannot_write() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_manager(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_manager(s.node,1,1,AztecAddress::zero()));s.env.call_public(s.resolver,NameRegistryV4::at(s.registry).address_from_resolver(s.node,1,2,s.other.to_field(),true,s.other)); }
#[test(should_fail_with="not transfer recipient")]
unconstrained fn wrong_recipient_cannot_accept() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV4::at(s.registry).accept_transfer(s.node,1,1)); }
#[test(should_fail_with="generation or revision mismatch")]
unconstrained fn changed_revision_blocks_acceptance() { let s=setup();s.env.call_private(s.owner,NameRegistryV4::at(s.registry).offer_transfer(s.node,1,0,s.other));s.env.call_private(s.owner,NameRegistryV4::at(s.registry).set_manager(s.node,1,1,s.other));s.env.call_private(s.other,NameRegistryV4::at(s.registry).accept_transfer(s.node,1,1)); }
#[test]
unconstrained fn parent_expiry_limits_child_and_cannot_revive() { let s=setup();let child=issue(s);s.env.advance_next_block_timestamp_by(YEAR+1);let rec=s.env.view_public(NameRegistryV4::at(s.registry).get_name(child));let old=rec.expires_at;s.env.call_public(s.registrar,NameRegistryV4::at(s.registry).renew_from_registrar(s.node,1,0,s.owner.to_field(),YEAR,FUTURE));assert_eq(s.env.view_public(NameRegistryV4::at(s.registry).get_name(child)).expires_at,old); }
