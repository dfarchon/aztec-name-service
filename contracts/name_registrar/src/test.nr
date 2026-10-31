use aztec::{protocol::{address::AztecAddress, traits::ToField}, test::helpers::{test_environment::TestEnvironment, authwit::add_private_authwit_from_call}};
use name_registry_v3::NameRegistryV3;
use name_resolver::NameResolver;
use legacy_registry::NameRegistry;
use test_token::Token;
use crate::NameRegistrar;
use ans_common::logic::{pack_label, node_from_packed};

global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
global DELAY: u64 = 86400;
struct Setup { env: TestEnvironment, admin: AztecAddress, alice: AztecAddress, bob: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress }

unconstrained fn label() -> [u8; 31] {
    let mut result = [0 as u8; 31];
    let bytes = "alice".as_bytes();
    for i in 0..5 { result[i] = bytes[i]; }
    result
}
unconstrained fn setup_legacy(legacy: AztecAddress, mut env: TestEnvironment) -> Setup {
    let admin = env.create_light_account();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let registry = env.deploy("@name_registry_v3/NameRegistryV3").with_public_initializer(admin, NameRegistryV3::interface().constructor(admin, DELAY, legacy));
    let registrar = env.deploy("NameRegistrar").with_public_initializer(admin, NameRegistrar::interface().constructor(registry, AztecAddress::zero(), AztecAddress::zero(), 0, 1));
    let resolver = env.deploy("@name_resolver/NameResolver").with_public_initializer(admin, NameResolver::interface().constructor(registry));
    env.call_public(admin, NameRegistryV3::at(registry).bootstrap(registrar, resolver));
    Setup { env, admin, alice, bob, registry, registrar, resolver }
}
unconstrained fn setup() -> Setup { setup_legacy(AztecAddress::zero(), TestEnvironment::new()) }
unconstrained fn commitment(s: Setup, registrar: AztecAddress) -> Field {
    s.env.execute_utility(NameRegistrar::at(registrar).register_commitment(s.alice, label(), 5, 0, YEAR, 0, FUTURE, 123))
}
unconstrained fn register(s: Setup) -> Field {
    let c = commitment(s, s.registrar);
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).commit(c));
    s.env.advance_next_block_timestamp_by(61);
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).register(label(), 5, 0, YEAR, 0, FUTURE, 1, 123));
    node_from_packed(pack_label(label(), 5), 5)
}
unconstrained fn replace_registrar(mut s: Setup) -> AztecAddress {
    let replacement = s.env.deploy("NameRegistrar").with_public_initializer(s.admin, NameRegistrar::interface().constructor(s.registry, AztecAddress::zero(), AztecAddress::zero(), 0, 2));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, replacement));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.bob, NameRegistryV3::at(s.registry).execute_proposal(1));
    replacement
}
unconstrained fn add_resolver(mut s: Setup) -> AztecAddress {
    let replacement = s.env.deploy("@name_resolver/NameResolver").with_public_initializer(s.admin, NameResolver::interface().constructor(s.registry));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(2, replacement));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.bob, NameRegistryV3::at(s.registry).execute_proposal(1));
    replacement
}

#[test]
unconstrained fn modular_registration_resolution_and_primary() {
    let s = setup(); let n = register(s);
    let rec = s.env.view_public(NameRegistryV3::at(s.registry).get_name(n));
    assert_eq(rec.owner, s.alice); assert_eq(rec.generation, 1);
    s.env.call_private(s.alice, NameResolver::at(s.resolver).set_address(n, 1, 0, true, s.bob));
    s.env.call_private(s.bob, NameRegistryV3::at(s.registry).set_primary(n, 1, 1));
    assert(s.env.view_public(NameRegistryV3::at(s.registry).get_primary(s.bob)).present);
}
#[test(should_fail_with = "unauthorized registrar")]
unconstrained fn direct_core_registration_cannot_bypass_policy() {
    let s = setup();
    s.env.call_public(s.alice, NameRegistryV3::at(s.registry).register_from_registrar(1, 0, s.alice.to_field(), 2, YEAR, FUTURE, 0, 5));
}
#[test(should_fail_with = "unauthorized registrar")]
unconstrained fn direct_core_renew_cannot_skip_payment() {
    let s = setup(); let n = register(s);
    s.env.call_public(s.alice, NameRegistryV3::at(s.registry).renew_from_registrar(n, 1, 0, s.alice.to_field(), YEAR, FUTURE));
}
#[test(should_fail_with = "unauthorized resolver")]
unconstrained fn direct_record_edit_rejected() {
    let s = setup(); let n = register(s);
    s.env.call_public(s.alice, NameRegistryV3::at(s.registry).address_from_resolver(n, 1, 0, s.alice.to_field(), true, s.bob));
}
#[test(should_fail_with = "not the holder")]
unconstrained fn resolver_preserves_holder_authorization() {
    let s = setup(); let n = register(s);
    s.env.call_private(s.bob, NameResolver::at(s.resolver).set_address(n, 1, 0, true, s.bob));
}
#[test(should_fail_with = "forward record does not point to caller")]
unconstrained fn resolver_cannot_confirm_primary_for_target() {
    let s = setup(); let n = register(s);
    s.env.call_private(s.alice, NameResolver::at(s.resolver).set_address(n, 1, 0, true, s.bob));
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).set_primary(n, 1, 1));
}
#[test(should_fail_with = "commitment too young")]
unconstrained fn commit_reveal_delay_preserved() {
    let s = setup(); let c = commitment(s, s.registrar);
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).commit(c));
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).register(label(), 5, 0, YEAR, 0, FUTURE, 1, 123));
}
#[test(should_fail_with = "governance delay active")]
unconstrained fn module_switch_cannot_skip_delay() {
    let s = setup();
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, s.registrar));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).execute_proposal(1));
}
#[test(should_fail_with = "unauthorized governance")]
unconstrained fn non_governance_cannot_schedule() {
    let s = setup(); s.env.call_public(s.bob, NameRegistryV3::at(s.registry).schedule_module(1, s.registrar));
}
#[test(should_fail_with = "already bootstrapped")]
unconstrained fn bootstrap_cannot_bypass_delay_again() {
    let s = setup(); s.env.call_public(s.admin, NameRegistryV3::at(s.registry).bootstrap(s.registrar, s.resolver));
}
#[test(should_fail_with = "proposal mismatch")]
unconstrained fn cancelled_proposal_cannot_execute() {
    let s = setup();
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, s.registrar));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).cancel_proposal(1));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).execute_proposal(1));
}
#[test]
unconstrained fn replacement_registrar_keeps_names_and_can_renew() {
    let s = setup(); let n = register(s);
    let before = s.env.view_public(NameRegistryV3::at(s.registry).get_name(n));
    let next = replace_registrar(s);
    s.env.call_private(s.alice, NameRegistrar::at(next).renew(n, 1, 0, YEAR, 0, FUTURE, 2));
    let after = s.env.view_public(NameRegistryV3::at(s.registry).get_name(n));
    assert_eq(after.owner, before.owner); assert_eq(after.expires_at, before.expires_at + YEAR);
}
#[test(should_fail_with = "unauthorized registrar")]
unconstrained fn retired_registrar_cannot_write() {
    let s = setup(); let n = register(s); let _ = replace_registrar(s);
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).renew(n, 1, 0, YEAR, 0, FUTURE, 2));
}
#[test]
unconstrained fn commitment_is_bound_to_registrar_address() {
    let mut s = setup();
    let next = s.env.deploy("NameRegistrar").with_public_initializer(s.admin, NameRegistrar::interface().constructor(s.registry, AztecAddress::zero(), AztecAddress::zero(), 0, 1));
    assert(commitment(s, s.registrar) != commitment(s, next));
}
#[test]
unconstrained fn resolver_change_preserves_owner_and_invalidates_old_primary() {
    let s = setup(); let n = register(s);
    s.env.call_private(s.alice, NameResolver::at(s.resolver).set_address(n, 1, 0, true, s.bob));
    s.env.call_private(s.bob, NameRegistryV3::at(s.registry).set_primary(n, 1, 1));
    let next = add_resolver(s);
    assert_eq(s.env.view_public(NameRegistryV3::at(s.registry).get_resolver(n, 1)), s.resolver);
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).set_resolver(n, 1, 1, next));
    assert(!s.env.view_public(NameRegistryV3::at(s.registry).get_address(n, 1)).present);
    s.env.call_private(s.alice, NameResolver::at(next).set_address(n, 1, 2, true, s.bob));
    let old_primary = s.env.view_public(NameRegistryV3::at(s.registry).get_primary(s.bob));
    let forward = s.env.view_public(NameRegistryV3::at(s.registry).get_address(n, 1));
    assert(old_primary.binding_version != forward.binding_version);
    s.env.call_private(s.bob, NameRegistryV3::at(s.registry).set_primary(n, 1, forward.binding_version));
    assert_eq(s.env.view_public(NameRegistryV3::at(s.registry).get_name(n)).owner, s.alice);
}
#[test(should_fail_with = "unauthorized resolver")]
unconstrained fn previous_resolver_cannot_write_after_switch() {
    let s = setup(); let n = register(s); let next = add_resolver(s);
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).set_resolver(n, 1, 0, next));
    s.env.call_private(s.alice, NameResolver::at(s.resolver).set_address(n, 1, 1, true, s.bob));
}
#[test(should_fail_with = "resolver not approved")]
unconstrained fn unapproved_resolver_rejected() {
    let s = setup(); let n = register(s);
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).set_resolver(n, 1, 0, s.bob));
}
#[test(should_fail_with = "module belongs to another registry")]
unconstrained fn module_from_other_registry_rejected() {
    let mut s = setup();
    let other = s.env.deploy("@name_registry_v3/NameRegistryV3").with_public_initializer(s.admin, NameRegistryV3::interface().constructor(s.admin, DELAY, AztecAddress::zero()));
    let bad = s.env.deploy("@name_resolver/NameResolver").with_public_initializer(s.admin, NameResolver::interface().constructor(other));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(2, bad));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).execute_proposal(1));
}
#[test(should_fail_with = "unauthorized governance")]
unconstrained fn governance_handover_revokes_old_admin() {
    let s = setup();
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(3, s.bob));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.alice, NameRegistryV3::at(s.registry).execute_proposal(1));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, s.registrar));
}
#[test(should_fail_with = "unauthorized governance")]
unconstrained fn unauthorized_upgrade_rejected() {
    let s = setup(); s.env.call_public(s.alice, NameRegistryV3::at(s.registry).schedule_upgrade(42));
}
#[test(should_fail_with = "governance delay active")]
unconstrained fn upgrade_cannot_skip_delay() {
    let s = setup(); s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_upgrade(42));
    s.env.call_public(s.bob, NameRegistryV3::at(s.registry).execute_upgrade(42));
}
#[test(should_fail_with = "upgrade mismatch")]
unconstrained fn cancelled_upgrade_cannot_execute() {
    let s = setup(); s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_upgrade(42));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).cancel_upgrade(42));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.bob, NameRegistryV3::at(s.registry).execute_upgrade(42));
}

unconstrained fn legacy_setup() -> (Setup, AztecAddress, Field) {
    let mut env = TestEnvironment::new(); let admin = env.create_light_account();
    let legacy = env.deploy("@name_registry/NameRegistry").with_public_initializer(admin, NameRegistry::interface().constructor(AztecAddress::zero(), AztecAddress::zero(), 0, 1));
    let s = setup_legacy(legacy, env);
    let c = s.env.execute_utility(NameRegistry::at(legacy).register_commitment(s.alice, label(), 5, 0, YEAR, 0, FUTURE, 123));
    s.env.call_private(s.alice, NameRegistry::at(legacy).commit(c));
    s.env.advance_next_block_timestamp_by(61);
    s.env.call_private(s.alice, NameRegistry::at(legacy).register(label(), 5, 0, YEAR, 0, FUTURE, 1, 123));
    let n = node_from_packed(pack_label(label(), 5), 5);
    s.env.call_private(s.alice, NameRegistry::at(legacy).set_address(n, 1, 0, true, s.bob));
    s.env.call_private(s.bob, NameRegistry::at(legacy).set_primary(n, 1, 1));
    (s, legacy, n)
}
#[test]
unconstrained fn migration_preserves_owner_expiry_forward_but_requires_new_primary() {
    let (s, legacy, n) = legacy_setup();
    let before = s.env.view_public(NameRegistry::at(legacy).get_name(n));
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).migrate(label(), 5));
    let after = s.env.view_public(NameRegistryV3::at(s.registry).get_name(n));
    assert_eq(after.owner, before.owner); assert_eq(after.expires_at, before.expires_at);
    assert_eq(s.env.view_public(NameRegistryV3::at(s.registry).get_address(n, 1)).addr, s.bob);
    assert(!s.env.view_public(NameRegistryV3::at(s.registry).get_primary(s.bob)).present);
    s.env.call_private(s.bob, NameRegistryV3::at(s.registry).set_primary(n, 1, 1));
    assert(s.env.view_public(NameRegistryV3::at(s.registry).get_primary(s.bob)).present);
}
#[test(should_fail_with = "not legacy holder")]
unconstrained fn migration_cannot_take_another_owners_name() {
    let (s, _, _) = legacy_setup(); s.env.call_private(s.bob, NameRegistryV3::at(s.registry).migrate(label(), 5));
}
#[test(should_fail_with = "name already initialized")]
unconstrained fn migration_cannot_repeat_or_overwrite() {
    let (s, _, _) = legacy_setup();
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).migrate(label(), 5));
    s.env.call_private(s.alice, NameRegistryV3::at(s.registry).migrate(label(), 5));
}
#[test(should_fail_with = "legacy name reserved; migrate first")]
unconstrained fn registration_cannot_front_run_legacy_migration() {
    let (s, _, _) = legacy_setup(); let _ = register(s);
}

struct Paid { s: Setup, token: AztecAddress }
unconstrained fn paid() -> Paid {
    let mut s = setup();
    s.alice = s.env.create_contract_account();
    let token = s.env.deploy("@test_token/Token").with_public_initializer(s.admin, Token::interface().constructor(s.admin, "ans-test-token-0000000000000000", "ANST000000000000000000000000000", 18));
    let next = s.env.deploy("NameRegistrar").with_public_initializer(s.admin, NameRegistrar::interface().constructor(s.registry, token, s.bob, 1000, 2));
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, next));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).execute_proposal(1));
    s.registrar = next;
    s.env.call_public(s.admin, Token::at(token).mint_to_public(s.alice, 10000));
    s.env.call_private(s.alice, Token::at(token).transfer_to_private(s.alice, 10000));
    Paid { s, token }
}
unconstrained fn paid_commit(p: Paid) {
    let s = p.s;
    let c = s.env.execute_utility(NameRegistrar::at(s.registrar).register_commitment(s.alice, label(), 5, 0, YEAR, 1000, FUTURE, 123));
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).commit(c));
    s.env.advance_next_block_timestamp_by(61);
}
#[test]
unconstrained fn paid_module_charges_exactly_once_and_renew_uses_separate_authwit() {
    let p = paid(); let s = p.s; paid_commit(p);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(p.token).transfer_in_private(s.alice, s.bob, 1000, 1));
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).register(label(), 5, 0, YEAR, 1000, FUTURE, 1, 123));
    let n = node_from_packed(pack_label(label(), 5), 5);
    assert_eq(s.env.execute_utility(Token::at(p.token).balance_of_private(s.bob)), 1000);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(p.token).transfer_in_private(s.alice, s.bob, 1000, 2));
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).renew(n, 1, 0, YEAR, 1000, FUTURE, 2));
    assert_eq(s.env.execute_utility(Token::at(p.token).balance_of_private(s.bob)), 2000);
    assert_eq(s.env.execute_utility(Token::at(p.token).balance_of_private(s.alice)), 8000);
}
#[test(should_fail)]
unconstrained fn fee_authwit_cannot_name_registry_instead_of_registrar() {
    let p = paid(); let s = p.s; paid_commit(p);
    add_private_authwit_from_call(s.env, s.alice, s.registry, Token::at(p.token).transfer_in_private(s.alice, s.bob, 1000, 1));
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).register(label(), 5, 0, YEAR, 1000, FUTURE, 1, 123));
}
#[test(should_fail_with = "fee exceeds max_fee")]
unconstrained fn registrar_respects_max_fee() {
    let p = paid(); let s = p.s;
    s.env.call_private(s.alice, NameRegistrar::at(s.registrar).renew(1, 1, 0, YEAR, 999, FUTURE, 2));
}
