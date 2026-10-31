use aztec::{protocol::address::AztecAddress, test::helpers::{test_environment::TestEnvironment, authwit::add_private_authwit_from_call}};
use name_registry_v3::NameRegistryV3;
use name_resolver::NameResolver;
use name_registrar::NameRegistrar;
use test_token::Token;
use crate::NameRegistrarTiered;
use ans_common::logic::{pack_label, node_from_packed};

global YEAR: u64 = 31536000;
global FUTURE: u64 = 0xffffffffff;
global P3: u128 = 128;
global P4: u128 = 32;
global P5: u128 = 1;
global DELAY: u64 = 86400;
struct Setup { env: TestEnvironment, admin: AztecAddress, alice: AztecAddress, treasury: AztecAddress, registry: AztecAddress, registrar: AztecAddress, resolver: AztecAddress, token: AztecAddress }

unconstrained fn label<let N: u32>(s: str<N>) -> [u8; 31] { let mut out = [0 as u8; 31]; for i in 0..N { out[i] = s.as_bytes()[i]; } out }
unconstrained fn node<let N: u32>(s: str<N>) -> Field { node_from_packed(pack_label(label(s), N), N) }
unconstrained fn balance(s: Setup, who: AztecAddress) -> u128 { s.env.execute_utility(Token::at(s.token).balance_of_private(who)) }

unconstrained fn setup() -> Setup { setup_with(false) }
unconstrained fn switch_registrar(mut s: Setup, next: AztecAddress) {
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).schedule_module(1, next));
    s.env.advance_next_block_timestamp_by(DELAY + 1);
    s.env.call_public(s.admin, NameRegistryV3::at(s.registry).execute_proposal(1));
}
/// `previous`: bootstrap with a free previous-generation registrar, so the tiered one can be switched in later.
unconstrained fn setup_with(previous: bool) -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let alice = env.create_contract_account();
    let treasury = env.create_light_account();
    let registry = env.deploy("@name_registry_v3/NameRegistryV3").with_public_initializer(admin, NameRegistryV3::interface().constructor(admin, DELAY, AztecAddress::zero()));
    let token = env.deploy("@test_token/Token").with_public_initializer(admin, Token::interface().constructor(admin, "ans-test-token-0000000000000000", "ANST000000000000000000000000000", 18));
    let registrar = env.deploy("NameRegistrarTiered").with_public_initializer(admin, NameRegistrarTiered::interface().constructor(registry, token, treasury, P5, P3, P4, 3));
    let resolver = env.deploy("@name_resolver/NameResolver").with_public_initializer(admin, NameResolver::interface().constructor(registry));
    let first = if previous {
        env.deploy("@name_registrar/NameRegistrar").with_public_initializer(admin, NameRegistrar::interface().constructor(registry, AztecAddress::zero(), AztecAddress::zero(), 0, 1))
    } else { registrar };
    env.call_public(admin, NameRegistryV3::at(registry).bootstrap(first, resolver));
    env.call_public(admin, Token::at(token).mint_to_public(alice, 10000));
    env.call_private(alice, Token::at(token).transfer_to_private(alice, 10000));
    Setup { env, admin, alice, treasury, registry, registrar, resolver, token }
}

unconstrained fn register<let N: u32>(s: Setup, name: str<N>, fee: u128, nonce: Field) -> Field {
    let r = NameRegistrarTiered::at(s.registrar);
    let c = s.env.execute_utility(r.register_commitment(s.alice, label(name), N, 0, YEAR, fee, FUTURE, 123));
    s.env.call_private(s.alice, r.commit(c));
    s.env.advance_next_block_timestamp_by(61);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, fee, nonce));
    s.env.call_private(s.alice, r.register(label(name), N, 0, YEAR, fee, FUTURE, nonce, 123));
    node(name)
}

#[test]
unconstrained fn registration_price_follows_length_tiers() {
    let s = setup();
    let _ = register(s, "abc", P3, 1);
    assert_eq(balance(s, s.treasury), P3);
    let _ = register(s, "abcd", P4, 2);
    assert_eq(balance(s, s.treasury), P3 + P4);
    let n = register(s, "alice", P5, 3);
    assert_eq(balance(s, s.treasury), P3 + P4 + P5);
    assert_eq(balance(s, s.alice), 10000 - P3 - P4 - P5);
    assert_eq(s.env.view_public(NameRegistryV3::at(s.registry).get_name(n)).owner, s.alice);
    let tiers = s.env.view_public(NameRegistrarTiered::at(s.registrar).get_length_prices());
    assert_eq(tiers.three, P3); assert_eq(tiers.four, P4);
}
#[test]
unconstrained fn multi_year_short_name_charges_tier_per_year() {
    let s = setup();
    let r = NameRegistrarTiered::at(s.registrar);
    let c = s.env.execute_utility(r.register_commitment(s.alice, label("xyz"), 3, 0, 2 * YEAR, 2 * P3, FUTURE, 123));
    s.env.call_private(s.alice, r.commit(c));
    s.env.advance_next_block_timestamp_by(61);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, 2 * P3, 1));
    s.env.call_private(s.alice, r.register(label("xyz"), 3, 0, 2 * YEAR, 2 * P3, FUTURE, 1, 123));
    assert_eq(balance(s, s.treasury), 2 * P3);
}
#[test]
unconstrained fn renewal_uses_the_label_tier() {
    let s = setup();
    let n = register(s, "abc", P3, 1);
    let before = s.env.view_public(NameRegistryV3::at(s.registry).get_name(n));
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, P3, 2));
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).renew(label("abc"), 3, 1, 0, YEAR, P3, FUTURE, 2));
    assert_eq(balance(s, s.treasury), 2 * P3);
    assert_eq(s.env.view_public(NameRegistryV3::at(s.registry).get_name(n)).expires_at, before.expires_at + YEAR);
}
#[test(should_fail_with = "fee exceeds max_fee")]
unconstrained fn short_name_cannot_pay_the_base_price() {
    let s = setup();
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).register(label("abc"), 3, 0, YEAR, P5, FUTURE, 1, 123));
}
#[test(should_fail_with = "fee exceeds max_fee")]
unconstrained fn short_name_renewal_cannot_pay_the_base_price() {
    let s = setup();
    let _ = register(s, "abcd", P4, 1);
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).renew(label("abcd"), 4, 1, 0, YEAR, P5, FUTURE, 2));
}
#[test(should_fail_with = "label cannot contain --")]
unconstrained fn double_hyphen_rejected() {
    let s = setup();
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).register(label("xn--abc"), 7, 0, YEAR, P5, FUTURE, 1, 123));
}
#[test(should_fail_with = "label cannot start with 0x")]
unconstrained fn address_prefix_rejected() {
    let s = setup();
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).register(label("0xdead"), 6, 0, YEAR, P5, FUTURE, 1, 123));
}
#[test]
unconstrained fn single_hyphens_and_inner_0x_allowed() {
    let s = setup();
    let _ = register(s, "a-b-c", P5, 1);
    let _ = register(s, "ab0x1", P5, 2);
    let _ = register(s, "x0abc", P5, 3);
}
#[test]
unconstrained fn names_from_the_previous_registrar_stay_renewable() {
    let s = setup_with(true);
    let old = s.env.view_public(NameRegistryV3::at(s.registry).get_modules()).registrar;
    let c = s.env.execute_utility(NameRegistrar::at(old).register_commitment(s.alice, label("a--b"), 4, 0, YEAR, 0, FUTURE, 7));
    s.env.call_private(s.alice, NameRegistrar::at(old).commit(c));
    s.env.advance_next_block_timestamp_by(61);
    s.env.call_private(s.alice, NameRegistrar::at(old).register(label("a--b"), 4, 0, YEAR, 0, FUTURE, 1, 7));
    switch_registrar(s, s.registrar);
    add_private_authwit_from_call(s.env, s.alice, s.registrar, Token::at(s.token).transfer_in_private(s.alice, s.treasury, P4, 2));
    s.env.call_private(s.alice, NameRegistrarTiered::at(s.registrar).renew(label("a--b"), 4, 1, 0, YEAR, P4, FUTURE, 2));
    assert_eq(balance(s, s.treasury), P4);
}
#[test(should_fail_with = "not the holder")]
unconstrained fn renewal_label_must_belong_to_the_caller() {
    let mut s = setup();
    let _ = register(s, "alice", P5, 1);
    let bob = s.env.create_contract_account();
    s.env.call_public(s.admin, Token::at(s.token).mint_to_public(bob, 1000));
    s.env.call_private(bob, Token::at(s.token).transfer_to_private(bob, 1000));
    add_private_authwit_from_call(s.env, bob, s.registrar, Token::at(s.token).transfer_in_private(bob, s.treasury, P5, 2));
    s.env.call_private(bob, NameRegistrarTiered::at(s.registrar).renew(label("alice"), 5, 1, 0, YEAR, P5, FUTURE, 2));
}
#[test(should_fail_with = "shorter names must not cost less")]
unconstrained fn tiers_must_not_invert() {
    let mut s = setup();
    let _ = s.env.deploy("NameRegistrarTiered").with_public_initializer(s.admin, NameRegistrarTiered::interface().constructor(s.registry, s.token, s.treasury, P5, P4, P3, 4));
}
#[test(should_fail_with = "free registry must have zero price")]
unconstrained fn free_registrar_has_no_tiers() {
    let mut s = setup();
    let _ = s.env.deploy("NameRegistrarTiered").with_public_initializer(s.admin, NameRegistrarTiered::interface().constructor(s.registry, AztecAddress::zero(), AztecAddress::zero(), 0, P3, 0, 4));
}
