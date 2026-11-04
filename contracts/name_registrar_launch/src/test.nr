use aztec::{protocol::address::AztecAddress, test::helpers::{test_environment::TestEnvironment, authwit::add_private_authwit_from_call}};
use name_registry_v6::NameRegistryV6;
use v4_test_module::V4TestModule;
use test_token::Token;
use crate::NameRegistrarLaunch;
use ans_common::logic::{pack_label, node_from_packed};

global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
struct Setup { env: TestEnvironment, admin: AztecAddress, alice: AztecAddress, treasury: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress, token: AztecAddress, paid: bool }
unconstrained fn label<let N: u32>(s: str<N>) -> [u8; 31] { let mut out = [0 as u8; 31]; for i in 0..N { out[i] = s.as_bytes()[i]; } out }
unconstrained fn node<let N: u32>(s: str<N>) -> Field { node_from_packed(pack_label(label(s), N), N) }
unconstrained fn batch(n: Field) -> [Field; 32] { let mut nodes = [0; 32]; nodes[0] = n; nodes }
unconstrained fn balance(s: Setup, who: AztecAddress) -> u128 { s.env.execute_utility(Token::at(s.token).balance_of_private(who)) }
unconstrained fn setup(paid: bool, cap: u64) -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account(); let alice = env.create_contract_account(); let treasury = env.create_light_account();
    let registry = env.deploy("@name_registry_v6/NameRegistryV6").with_public_initializer(admin, NameRegistryV6::interface().constructor(AztecAddress::zero()));
    let resolver = env.deploy("@v4_test_module/V4TestModule").with_public_initializer(admin, V4TestModule::interface().constructor(registry));
    let token = env.deploy("@test_token/Token").with_public_initializer(admin, Token::interface().constructor(admin, "ans-test-token-0000000000000000", "ANST000000000000000000000000000", 18));
    let fee_token = if paid { token } else { AztecAddress::zero() };
    let price = if paid { 1 } else { 0 };
    let registrar = env.deploy("NameRegistrarLaunch").with_public_initializer(admin, NameRegistrarLaunch::interface().constructor(registry, fee_token, treasury, price, price * 128, price * 32, 1, 7, false, cap));
    env.call_public(admin, NameRegistryV6::at(registry).bootstrap(registrar, resolver));
    env.call_public(admin, Token::at(token).mint_to_public(alice, 10000));
    env.call_private(alice, Token::at(token).transfer_to_private(alice, 10000));
    Setup { env, admin, alice, treasury, registry, registrar, resolver, token, paid }
}
unconstrained fn commit<let N: u32>(s: Setup, name: str<N>, admin: bool, age: u64) {
    let r = NameRegistrarLaunch::at(s.registrar);
    let fee: u128 = if s.paid { if N == 3 { 128 } else if N == 4 { 32 } else { 1 } } else { 0 };
    let c = if admin { s.env.execute_utility(r.admin_commitment(s.alice, label(name), N, 0, FUTURE, 123)) }
        else { s.env.execute_utility(r.register_commitment(s.alice, label(name), N, 0, YEAR, fee, FUTURE, 123)) };
    s.env.call_private(if admin { s.admin } else { s.alice }, r.commit(c));
    s.env.advance_next_block_timestamp_by(age);
}
unconstrained fn reveal<let N: u32>(s: Setup, name: str<N>, nonce: Field) -> Field {
    let fee: u128 = if s.paid { if N == 3 { 128 } else if N == 4 { 32 } else { 1 } } else { 0 };
    if fee > 0 { add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, fee, nonce)); }
    s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).register(label(name), N, 0, YEAR, fee, FUTURE, nonce, 123));
    node(name)
}
unconstrained fn register<let N: u32>(s: Setup, name: str<N>) -> Field { commit(s, name, false, 61); reveal(s, name, 1) }
unconstrained fn mint<let N: u32>(s: Setup, name: str<N>) -> Field {
    commit(s, name, true, 61);
    s.env.call_private(s.admin, NameRegistrarLaunch::at(s.registrar).admin_register(label(name), N, s.alice, 0, FUTURE, 123));
    node(name)
}
unconstrained fn renew<let N: u32>(s: Setup, name: str<N>, revision: u32, nonce: Field) {
    let fee: u128 = if s.paid { if N == 3 { 128 } else if N == 4 { 32 } else { 1 } } else { 0 };
    if fee > 0 { add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, fee, nonce)); }
    s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).renew(label(name), N, 1, revision, YEAR, fee, FUTURE, nonce));
}

#[test]
unconstrained fn free_registration_seven_and_lowering_gate() {
    let s = setup(false, 0); let n = register(s, "seventh");
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_name(n)).owner, s.alice);
    assert_eq(balance(s, s.alice), 10000); assert_eq(balance(s, s.treasury), 0);
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(5));
    let _ = register(s, "fifth");
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(3));
    let _ = register(s, "abc");
    assert_eq(s.env.view_public(NameRegistrarLaunch::at(s.registrar).get_policy()).min_public_length, 3);
}
#[test(should_fail_with = "name not yet available")]
unconstrained fn six_rejected_at_seven() { let s = setup(false, 0); let _ = register(s, "sixsix"); }
#[test(should_fail_with = "name not yet available")]
unconstrained fn four_rejected_at_five() { let s = setup(false, 0); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(5)); let _ = register(s, "four"); }
#[test(should_fail_with = "invalid public length")]
unconstrained fn minimum_cannot_be_two() { let s = setup(false, 0); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(2)); }
#[test(should_fail_with = "invalid public length")]
unconstrained fn minimum_cannot_be_thirty_two() { let s = setup(false, 0); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(32)); }
#[test]
unconstrained fn reserved_batch_zero_skip_and_removal() {
    let s = setup(false, 0); let r = NameRegistrarLaunch::at(s.registrar); let n = node("reserve");
    s.env.call_public(s.admin, r.set_reserved(batch(n), true));
    assert(s.env.view_public(r.is_reserved(n))); assert(!s.env.view_public(r.is_reserved(0)));
    s.env.call_public(s.admin, r.set_reserved(batch(n), true));
    s.env.call_public(s.admin, r.set_reserved(batch(n), false));
    assert(!s.env.view_public(r.is_reserved(n))); let _ = register(s, "reserve");
}
#[test(should_fail_with = "name reserved")]
unconstrained fn reserved_public_reveal_rejected() { let s = setup(false, 0); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_reserved(batch(node("reserve")), true)); let _ = register(s, "reserve"); }
#[test]
unconstrained fn paused_admin_mints_short_reserved_and_renewal_stays_open() {
    let s = setup(false, 0); let r = NameRegistrarLaunch::at(s.registrar);
    s.env.call_public(s.admin, r.set_paused(true));
    s.env.call_public(s.admin, r.set_reserved(batch(node("abc")), true));
    let n = mint(s, "abc"); let _ = mint(s, "reserve");
    let before = s.env.view_public(NameRegistryV6::at(s.registry).get_name(n));
    assert_eq(before.owner, s.alice);
    renew(s, "abc", 0, 2);
    assert_eq(s.env.view_public(NameRegistryV6::at(s.registry).get_name(n)).expires_at, before.expires_at + YEAR);
    renew(s, "abc", 1, 3); // cap=0 permits repeated renewal
    s.env.call_public(s.admin, r.set_paused(false)); let _ = register(s, "resumed");
}
#[test(should_fail_with = "registration paused")]
unconstrained fn pause_rejects_public_even_admin() { let s = setup(false, 0); commit(s, "seventh", false, 61); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_paused(true)); let _ = reveal(s, "seventh", 1); }
#[test(should_fail_with = "not administrator")]
unconstrained fn non_admin_mint_rejected() { let s = setup(false, 0); commit(s, "abc", true, 61); s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).admin_register(label("abc"), 3, s.alice, 0, FUTURE, 123)); }
#[test(should_fail_with = "not administrator")]
unconstrained fn non_admin_pause_rejected() { let s = setup(false, 0); s.env.call_public(s.alice, NameRegistrarLaunch::at(s.registrar).set_paused(true)); }
#[test(should_fail_with = "not administrator")]
unconstrained fn non_admin_min_rejected() { let s = setup(false, 0); s.env.call_public(s.alice, NameRegistrarLaunch::at(s.registrar).set_min_public_length(3)); }
#[test(should_fail_with = "not administrator")]
unconstrained fn non_admin_reserved_rejected() { let s = setup(false, 0); s.env.call_public(s.alice, NameRegistrarLaunch::at(s.registrar).set_reserved(batch(1), true)); }
#[test(should_fail_with = "unknown commitment")]
unconstrained fn admin_commit_cannot_use_public_channel() { let s = setup(false, 0); commit(s, "seventh", true, 61); let _ = reveal(s, "seventh", 1); }
#[test(should_fail_with = "unknown commitment")]
unconstrained fn public_commit_cannot_use_admin_channel() { let s = setup(false, 0); commit(s, "seventh", false, 61); s.env.call_private(s.admin, NameRegistrarLaunch::at(s.registrar).admin_register(label("seventh"), 7, s.alice, 0, FUTURE, 123)); }
#[test(should_fail_with = "commitment too young")]
unconstrained fn fifty_nine_second_commit_rejected() { let s = setup(false, 0); commit(s, "seventh", false, 59); let _ = reveal(s, "seventh", 1); }
#[test(should_fail_with = "lease must be one year")]
unconstrained fn other_register_duration_rejected() { let s = setup(false, 0); s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).register(label("seventh"), 7, 0, 2 * YEAR, 0, FUTURE, 1, 123)); }
#[test(should_fail_with = "lease must be one year")]
unconstrained fn other_renew_duration_rejected() { let s = setup(false, 0); let _ = register(s, "seventh"); s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).renew(label("seventh"), 7, 1, 0, 2 * YEAR, 0, FUTURE, 2)); }
#[test(should_fail_with = "not the holder")]
unconstrained fn renewal_requires_holder() { let s = setup(false, 0); let _ = register(s, "seventh"); s.env.call_private(s.admin, NameRegistrarLaunch::at(s.registrar).renew(label("seventh"), 7, 1, 0, YEAR, 0, FUTURE, 2)); }
#[test(should_fail_with = "renewal too early")]
unconstrained fn one_year_cap_rejects_repeated_renewal() { let s = setup(false, YEAR); let _ = register(s, "seventh"); renew(s, "seventh", 0, 2); renew(s, "seventh", 1, 3); }
#[test]
unconstrained fn paid_register_renew_and_admin_mint_fee_exemption() {
    let s = setup(true, 0); let _ = register(s, "seventh"); renew(s, "seventh", 0, 2);
    assert_eq(balance(s, s.treasury), 2); assert_eq(balance(s, s.alice), 9998);
    let _ = mint(s, "abc"); assert_eq(balance(s, s.treasury), 2);
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_min_public_length(3));
    let _ = register(s, "xyz"); assert_eq(balance(s, s.treasury), 130);
}
#[test(should_fail_with = "fee exceeds max_fee")]
unconstrained fn paid_max_fee_enforced() { let s = setup(true, 0); s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).register(label("seventh"), 7, 0, YEAR, 0, FUTURE, 1, 123)); }
#[test(should_fail_with = "name reserved")]
unconstrained fn paid_reserved_rejected() { let s = setup(true, 0); s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_reserved(batch(node("reserve")), true)); let _ = register(s, "reserve"); }
#[test(should_fail_with = "name not yet available")]
unconstrained fn paid_length_gate_applies() { let s = setup(true, 0); let _ = register(s, "sixsix"); }
#[test(should_fail_with = "not administrator")]
unconstrained fn transferred_admin_live_lookup() {
    let s = setup(false, 0);
    s.env.call_public(s.admin, NameRegistryV6::at(s.registry).nominate_administrator(s.alice));
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_paused(true));
    s.env.call_public(s.alice, NameRegistryV6::at(s.registry).accept_administrator());
    s.env.call_public(s.alice, NameRegistrarLaunch::at(s.registrar).set_paused(false));
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_paused(true));
}
#[test(should_fail_with = "not administrator")]
unconstrained fn nominee_cannot_change_policy_before_acceptance() { let s = setup(false, 0); s.env.call_public(s.admin, NameRegistryV6::at(s.registry).nominate_administrator(s.alice)); s.env.call_public(s.alice, NameRegistrarLaunch::at(s.registrar).set_paused(true)); }
#[test(should_fail_with = "unknown commitment")]
unconstrained fn registrar_switch_invalidates_old_commit() {
    let mut s = setup(false, 0); commit(s, "seventh", false, 61);
    let next = s.env.deploy("NameRegistrarLaunch").with_public_initializer(s.admin, NameRegistrarLaunch::interface().constructor(s.registry, AztecAddress::zero(), s.treasury, 0, 0, 0, 2, 7, false, 0));
    s.env.call_public(s.admin, NameRegistryV6::at(s.registry).configure_modules(1, next, s.resolver));
    s.registrar = next;
    let _ = register(s, "newname"); // fresh commitment works immediately
    let _ = reveal(s, "seventh", 2);
}
#[test(should_fail_with = "label cannot contain --")]
unconstrained fn admin_mint_keeps_new_label_rules() { let s = setup(false, 0); s.env.call_private(s.admin, NameRegistrarLaunch::at(s.registrar).admin_register(label("a--b"), 4, s.alice, 0, FUTURE, 123)); }
#[test(should_fail_with = "label cannot start with 0x")]
unconstrained fn public_keeps_new_label_rules() { let s = setup(false, 0); let _ = register(s, "0xabcde"); }
#[test(should_fail_with = "recipient required")]
unconstrained fn admin_mint_requires_recipient() { let s = setup(false, 0); s.env.call_private(s.admin, NameRegistrarLaunch::at(s.registrar).admin_register(label("abc"), 3, AztecAddress::zero(), 0, FUTURE, 123)); }

unconstrained fn invalid_constructor(min: u32, paid: bool, treasury_zero: bool, price: u128, three: u128, four: u128, version: u32) {
    let mut env = TestEnvironment::new(); let admin = env.create_light_account();
    let _ = env.deploy("NameRegistrarLaunch").with_public_initializer(admin, NameRegistrarLaunch::interface().constructor(admin, if paid { admin } else { AztecAddress::zero() }, if treasury_zero { AztecAddress::zero() } else { admin }, price, three, four, version, min, true, 0));
}
#[test(should_fail_with = "invalid public length")]
unconstrained fn constructor_rejects_low_min() { invalid_constructor(2, false, false, 0, 0, 0, 1); }
#[test(should_fail_with = "invalid public length")]
unconstrained fn constructor_rejects_high_min() { invalid_constructor(32, false, false, 0, 0, 0, 1); }
#[test(should_fail_with = "free registry must have zero price")]
unconstrained fn constructor_rejects_free_nonzero_price() { invalid_constructor(7, false, false, 1, 1, 1, 1); }
#[test(should_fail_with = "treasury required")]
unconstrained fn constructor_rejects_paid_zero_treasury() { invalid_constructor(7, true, true, 1, 1, 1, 1); }
#[test(should_fail_with = "shorter names must not cost less")]
unconstrained fn constructor_rejects_inverted_tiers() { invalid_constructor(7, true, false, 2, 1, 1, 1); }
#[test(should_fail_with = "annual price too large")]
unconstrained fn constructor_rejects_overflow() { invalid_constructor(7, true, false, 1, 0x1000000000000000000000001, 1, 1); }
#[test(should_fail_with = "price version required")]
unconstrained fn constructor_rejects_zero_version() { invalid_constructor(7, false, false, 0, 0, 0, 0); }
#[test]
unconstrained fn constructor_initial_pause_and_cap() {
    let mut env = TestEnvironment::new(); let admin = env.create_light_account();
    let r = env.deploy("NameRegistrarLaunch").with_public_initializer(admin, NameRegistrarLaunch::interface().constructor(admin, AztecAddress::zero(), AztecAddress::zero(), 0, 0, 0, 1, 7, true, YEAR));
    assert(env.view_public(NameRegistrarLaunch::at(r).get_policy()).paused);
    assert_eq(env.view_public(NameRegistrarLaunch::at(r).get_max_renew_ahead()), YEAR);
}

#[test(should_fail)]
unconstrained fn paid_registration_requires_authwit() {
    let s = setup(true, 0); commit(s, "seventh", false, 61);
    s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).register(label("seventh"), 7, 0, YEAR, 1, FUTURE, 1, 123));
}
#[test(should_fail)]
unconstrained fn paid_registration_rejects_wrong_authwit_amount() {
    let s = setup(true, 0); commit(s, "seventh", false, 61);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, 2, 1));
    s.env.call_private(s.alice, NameRegistrarLaunch::at(s.registrar).register(label("seventh"), 7, 0, YEAR, 1, FUTURE, 1, 123));
}
#[test(should_fail_with = "registration paused")]
unconstrained fn paid_pause_rejects_public_registration() {
    let s = setup(true, 0); commit(s, "seventh", false, 61);
    s.env.call_public(s.admin, NameRegistrarLaunch::at(s.registrar).set_paused(true));
    let _ = reveal(s, "seventh", 1);
}

#[test]
unconstrained fn constructor_accepts_maximum_renewal_cap() {
    let s = setup(false, 10 * YEAR);
    assert_eq(s.env.view_public(NameRegistrarLaunch::at(s.registrar).get_max_renew_ahead()), 10 * YEAR);
}
#[test(should_fail_with = "renewal cap too large")]
unconstrained fn constructor_rejects_cap_above_ten_years() { let _ = setup(false, 10 * YEAR + 1); }
#[test(should_fail_with = "renewal cap too large")]
unconstrained fn constructor_rejects_u64_max_cap() { let _ = setup(false, 0xffffffffffffffff); }
#[test]
unconstrained fn capped_renewal_in_grace_does_not_underflow() {
    let s = setup(false, YEAR); let n = register(s, "seventh");
    s.env.advance_next_block_timestamp_by(YEAR + 1);
    renew(s, "seventh", 0, 2);
    assert(s.env.view_public(NameRegistryV6::at(s.registry).get_name(n)).expires_at > 0);
}
