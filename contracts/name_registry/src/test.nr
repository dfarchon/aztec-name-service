use aztec::{
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::{authwit::add_private_authwit_from_call, test_environment::TestEnvironment},
};
use test_token::Token;

use crate::NameRegistry;
use crate::logic::{fee_for, GRACE_PERIOD, MIN_COMMIT_AGE, pack_label};

global DURATION: u64 = 365 * 86400;
global SECRET_A: Field = 0x5ec2e7a;
global SECRET_B: Field = 0x5ec2e7b;
global FAR_FUTURE: u64 = 0xffffffffff;
global PRICE_VERSION: u32 = 1;
global ANNUAL_PRICE: u128 = 1000;
global MINT_AMOUNT: u128 = 100000;

// ------------------------------------------------------------------------------------------------------------------
// Setup helpers
// ------------------------------------------------------------------------------------------------------------------

/// Free registry (no fee token).
unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let registry = env.deploy("NameRegistry").with_public_initializer(
        deployer,
        NameRegistry::interface().constructor(AztecAddress::zero(), AztecAddress::zero(), 0, PRICE_VERSION),
    );
    (env, registry)
}

struct Paid {
    env: TestEnvironment,
    registry: AztecAddress,
    token: AztecAddress,
    treasury: AztecAddress,
    alice: AztecAddress,
}

/// Paid registry with a funded contract account (authwits need a real account contract).
unconstrained fn setup_paid() -> Paid {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let treasury = env.create_light_account();
    let alice = env.create_contract_account();

    let token = env.deploy("@test_token/Token").with_public_initializer(
        admin,
        Token::interface().constructor(admin, "ans-test-token-0000000000000000", "ANST000000000000000000000000000", 18),
    );
    let registry = env.deploy("NameRegistry").with_public_initializer(
        admin,
        NameRegistry::interface().constructor(token, treasury, ANNUAL_PRICE, PRICE_VERSION),
    );

    env.call_public(admin, Token::at(token).mint_to_public(alice, MINT_AMOUNT));
    env.call_private(alice, Token::at(token).transfer_to_private(alice, MINT_AMOUNT));
    Paid { env, registry, token, treasury, alice }
}

unconstrained fn label_of<let N: u32>(s: str<N>) -> ([u8; 31], u32) {
    let bytes = s.as_bytes();
    let mut label = [0 as u8; 31];
    for i in 0..N {
        label[i] = bytes[i];
    }
    (label, N)
}

unconstrained fn commit_for(
    env: TestEnvironment,
    registry: AztecAddress,
    owner: AztecAddress,
    label: [u8; 31],
    len: u32,
    expected_generation: u32,
    max_fee: u128,
    secret: Field,
) {
    let c = env.execute_utility(NameRegistry::at(registry).register_commitment(
        owner,
        label,
        len,
        expected_generation,
        DURATION,
        max_fee,
        FAR_FUTURE,
        secret,
    ));
    env.call_private(owner, NameRegistry::at(registry).commit(c));
}

/// commit → wait → register on a free registry. Returns the node.
unconstrained fn register_name(
    env: TestEnvironment,
    registry: AztecAddress,
    owner: AztecAddress,
    label: [u8; 31],
    len: u32,
    expected_generation: u32,
    secret: Field,
) -> Field {
    commit_for(env, registry, owner, label, len, expected_generation, 0, secret);
    env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    env.call_private(
        owner,
        NameRegistry::at(registry).register(label, len, expected_generation, DURATION, 0, FAR_FUTURE, 0, secret),
    );
    env.execute_utility(NameRegistry::at(registry).node_of(label, len))
}

/// commit → wait → authwit → register on a paid registry.
unconstrained fn register_paid(p: Paid, label: [u8; 31], len: u32, max_fee: u128, fee_nonce: Field, secret: Field) {
    let fee = fee_for(ANNUAL_PRICE, DURATION);
    commit_for(p.env, p.registry, p.alice, label, len, 0, max_fee, secret);
    p.env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    add_private_authwit_from_call(
        p.env,
        p.alice,
        p.registry,
        Token::at(p.token).transfer_in_private(p.alice, p.treasury, fee, fee_nonce),
    );
    p.env.call_private(
        p.alice,
        NameRegistry::at(p.registry).register(label, len, 0, DURATION, max_fee, FAR_FUTURE, fee_nonce, secret),
    );
}

// ------------------------------------------------------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------------------------------------------------------

unconstrained fn setup_with_name() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, Field) {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);
    (env, registry, alice, bob, node)
}

#[test(should_fail_with = "commitment too young")]
unconstrained fn register_before_min_age_fails() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");

    commit_for(env, registry, alice, label, len, 0, 0, SECRET_A);
    env.call_private(
        alice,
        NameRegistry::at(registry).register(label, len, 0, DURATION, 0, FAR_FUTURE, 0, SECRET_A),
    );
}

#[test(should_fail_with = "unknown commitment")]
unconstrained fn copied_reveal_cannot_steal_name() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let (label, len) = label_of("alice");

    commit_for(env, registry, alice, label, len, 0, 0, SECRET_A);
    env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    env.call_private(bob, NameRegistry::at(registry).register(label, len, 0, DURATION, 0, FAR_FUTURE, 0, SECRET_A));
}

#[test(should_fail_with = "unknown commitment")]
unconstrained fn changed_fee_conditions_do_not_match_commitment() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");

    commit_for(env, registry, alice, label, len, 0, 0, SECRET_A);
    env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    env.call_private(
        alice,
        NameRegistry::at(registry).register(label, len, 0, DURATION, 5, FAR_FUTURE, 0, SECRET_A),
    );
}

#[test(should_fail_with = "generation mismatch")]
unconstrained fn second_registration_of_same_name_fails() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let (label, len) = label_of("alice");

    commit_for(env, registry, alice, label, len, 0, 0, SECRET_A);
    commit_for(env, registry, bob, label, len, 0, 0, SECRET_B);
    env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    env.call_private(
        alice,
        NameRegistry::at(registry).register(label, len, 0, DURATION, 0, FAR_FUTURE, 0, SECRET_A),
    );
    env.call_private(bob, NameRegistry::at(registry).register(label, len, 0, DURATION, 0, FAR_FUTURE, 0, SECRET_B));
}

#[test(should_fail_with = "commitment already consumed")]
unconstrained fn commitment_cannot_be_reused() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");

    let _ = register_name(env, registry, alice, label, len, 0, SECRET_A);
    env.call_private(
        alice,
        NameRegistry::at(registry).register(label, len, 0, DURATION, 0, FAR_FUTURE, 0, SECRET_A),
    );
}

#[test(should_fail_with = "fee quote expired")]
unconstrained fn expired_quote_rejected() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");
    let expiry = env.last_block_timestamp() + 10;

    let c = env.execute_utility(NameRegistry::at(registry).register_commitment(
        alice,
        label,
        len,
        0,
        DURATION,
        0,
        expiry,
        SECRET_A,
    ));
    env.call_private(alice, NameRegistry::at(registry).commit(c));
    env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    env.call_private(alice, NameRegistry::at(registry).register(label, len, 0, DURATION, 0, expiry, 0, SECRET_A));
}

#[test(should_fail_with = "invalid label character")]
unconstrained fn uppercase_label_rejected() {
    let (env, registry) = setup();
    let (label, len) = label_of("Alice");
    let _ = env.execute_utility(NameRegistry::at(registry).node_of(label, len));
}

#[test(should_fail_with = "label cannot start or end with hyphen")]
unconstrained fn trailing_hyphen_rejected() {
    let (env, registry) = setup();
    let (label, len) = label_of("alice-");
    let _ = env.execute_utility(NameRegistry::at(registry).node_of(label, len));
}

#[test(should_fail_with = "label padding must be zero")]
unconstrained fn nonzero_padding_rejected() {
    let (env, registry) = setup();
    let (mut label, _) = label_of("alice");
    label[10] = 97;
    let _ = env.execute_utility(NameRegistry::at(registry).node_of(label, 5));
}

#[test]
unconstrained fn fee_quote_is_pro_rata_rounded_up() {
    let p = setup_paid();
    assert_eq(p.env.execute_utility(NameRegistry::at(p.registry).fee_quote(DURATION)), ANNUAL_PRICE);
    assert_eq(p.env.execute_utility(NameRegistry::at(p.registry).fee_quote(86400)), 3);
}

#[test]
unconstrained fn free_registry_quotes_zero() {
    let (env, registry) = setup();
    assert_eq(env.execute_utility(NameRegistry::at(registry).fee_quote(DURATION)), 0);
}

#[test]
unconstrained fn paid_registration_transfers_exact_fee_to_treasury() {
    let p = setup_paid();
    let (label, len) = label_of("alice");

    register_paid(p, label, len, ANNUAL_PRICE, 1, SECRET_A);

    assert_eq(p.env.execute_utility(Token::at(p.token).balance_of_private(p.treasury)), ANNUAL_PRICE);
    assert_eq(p.env.execute_utility(Token::at(p.token).balance_of_private(p.alice)), MINT_AMOUNT - ANNUAL_PRICE);
    let node = p.env.execute_utility(NameRegistry::at(p.registry).node_of(label, len));
    assert_eq(p.env.view_public(NameRegistry::at(p.registry).get_name(node)).generation, 1);
}

#[test]
unconstrained fn consecutive_same_price_registrations_use_distinct_nonces() {
    let p = setup_paid();
    let (l1, n1) = label_of("alice");
    let (l2, n2) = label_of("alice-two");

    register_paid(p, l1, n1, ANNUAL_PRICE, 1, SECRET_A);
    register_paid(p, l2, n2, ANNUAL_PRICE, 2, SECRET_B);

    assert_eq(p.env.execute_utility(Token::at(p.token).balance_of_private(p.treasury)), 2 * ANNUAL_PRICE);
}

#[test(should_fail_with = "fee exceeds max_fee")]
unconstrained fn fee_above_max_fee_rejected() {
    let p = setup_paid();
    let (label, len) = label_of("alice");

    register_paid(p, label, len, ANNUAL_PRICE - 1, 1, SECRET_A);
}

#[test(should_fail)]
unconstrained fn registration_without_fee_authwit_fails() {
    let p = setup_paid();
    let (label, len) = label_of("alice");

    commit_for(p.env, p.registry, p.alice, label, len, 0, ANNUAL_PRICE, SECRET_A);
    p.env.advance_next_block_timestamp_by(MIN_COMMIT_AGE + 1);
    p.env.call_private(
        p.alice,
        NameRegistry::at(p.registry).register(label, len, 0, DURATION, ANNUAL_PRICE, FAR_FUTURE, 1, SECRET_A),
    );
}

#[test(should_fail_with = "duplicate siloed nullifier")]
unconstrained fn fee_authwit_cannot_be_replayed() {
    let p = setup_paid();
    let (l1, n1) = label_of("alice");
    let (l2, n2) = label_of("alice-two");

    register_paid(p, l1, n1, ANNUAL_PRICE, 1, SECRET_A);
    register_paid(p, l2, n2, ANNUAL_PRICE, 1, SECRET_B);
}

#[test]
unconstrained fn paid_renewal_charges_fee() {
    let p = setup_paid();
    let (label, len) = label_of("alice");
    register_paid(p, label, len, ANNUAL_PRICE, 1, SECRET_A);
    let node = p.env.execute_utility(NameRegistry::at(p.registry).node_of(label, len));

    add_private_authwit_from_call(
        p.env,
        p.alice,
        p.registry,
        Token::at(p.token).transfer_in_private(p.alice, p.treasury, ANNUAL_PRICE, 2),
    );
    p.env.call_private(
        p.alice,
        NameRegistry::at(p.registry).renew(node, 1, 0, DURATION, ANNUAL_PRICE, FAR_FUTURE, 2),
    );

    assert_eq(p.env.execute_utility(Token::at(p.token).balance_of_private(p.treasury)), 2 * ANNUAL_PRICE);
}

#[test]
unconstrained fn holder_updates_record_and_revision() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let game = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, game));

    let ar = env.view_public(NameRegistry::at(registry).get_address(node, 1));
    assert(ar.present);
    assert_eq(ar.addr, game);
    assert_eq(ar.binding_version, 1);
    assert_eq(env.view_public(NameRegistry::at(registry).get_name(node)).revision, 1);
}

#[test(should_fail_with = "not the holder")]
unconstrained fn non_holder_cannot_update() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);

    env.call_private(bob, NameRegistry::at(registry).set_address(node, 1, 0, true, bob));
}

#[test(should_fail_with = "revision mismatch")]
unconstrained fn stale_revision_rejected() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, alice));
    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, alice));
}

#[test(should_fail_with = "not the holder")]
unconstrained fn non_holder_cannot_renew() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);

    env.call_private(bob, NameRegistry::at(registry).renew(node, 1, 0, DURATION, 0, FAR_FUTURE, 0));
}

#[test]
unconstrained fn renew_extends_from_current_expiry() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);
    let before = env.view_public(NameRegistry::at(registry).get_name(node)).expires_at;

    env.call_private(alice, NameRegistry::at(registry).renew(node, 1, 0, DURATION, 0, FAR_FUTURE, 0));

    let after = env.view_public(NameRegistry::at(registry).get_name(node));
    assert_eq(after.expires_at, before + DURATION);
    assert_eq(after.generation, 1);
}

#[test(should_fail_with = "name not active")]
unconstrained fn expired_name_cannot_be_updated() {
    let (env, registry, alice, _bob, node) = setup_with_name();
    env.advance_next_block_timestamp_by(DURATION + 1);

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, alice));
}

#[test(should_fail_with = "name not available")]
unconstrained fn cannot_register_during_grace() {
    let (env, registry, _alice, bob, _node) = setup_with_name();
    let (label, len) = label_of("alice");
    env.advance_next_block_timestamp_by(DURATION + 1);

    let _ = register_name(env, registry, bob, label, len, 1, SECRET_B);
}

#[test]
unconstrained fn primary_requires_forward_record_and_version() {
    let (mut env, registry, alice, _bob, node) = setup_with_name();
    let game = env.create_light_account();

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, game));
    env.call_private(game, NameRegistry::at(registry).set_primary(node, 1, 1));

    let p = env.view_public(NameRegistry::at(registry).get_primary(game));
    assert(p.present);
    assert_eq(p.binding_version, 1);
}

#[test(should_fail_with = "forward record does not point to caller")]
unconstrained fn cannot_set_primary_for_unbound_address() {
    let (mut env, registry, alice, _bob, node) = setup_with_name();
    let game = env.create_light_account();
    let mallory = env.create_light_account();

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, game));
    env.call_private(mallory, NameRegistry::at(registry).set_primary(node, 1, 1));
}

#[test]
unconstrained fn rebinding_invalidates_old_primary() {
    let (mut env, registry, alice, _bob, node) = setup_with_name();
    let a = env.create_light_account();
    let b = env.create_light_account();

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, a));
    env.call_private(a, NameRegistry::at(registry).set_primary(node, 1, 1));
    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 1, true, b));
    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 2, true, a));

    let p = env.view_public(NameRegistry::at(registry).get_primary(a));
    let fwd = env.view_public(NameRegistry::at(registry).get_address(node, 1));
    assert_eq(fwd.addr, a);
    assert_eq(fwd.binding_version, 3);
    // Client-side bidirectional check fails: the stored confirmation is for version 1.
    assert(p.binding_version != fwd.binding_version);
}

#[test]
unconstrained fn clear_primary_removes_confirmation() {
    let (mut env, registry, alice, _bob, node) = setup_with_name();
    let game = env.create_light_account();

    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, game));
    env.call_private(game, NameRegistry::at(registry).set_primary(node, 1, 1));
    env.call_private(game, NameRegistry::at(registry).clear_primary());

    assert(!env.view_public(NameRegistry::at(registry).get_primary(game)).present);
}

#[test]
unconstrained fn registration_records_public_owner() {
    let (mut env, registry) = setup();
    let alice = env.create_light_account();
    let (label, len) = label_of("alice");
    let node = register_name(env, registry, alice, label, len, 0, SECRET_A);
    let rec = env.view_public(NameRegistry::at(registry).get_name(node));
    assert_eq(rec.owner, alice);
    let published = env.view_public(NameRegistry::at(registry).get_published_label(node));
    assert(published.present);
    assert_eq(published.packed_label, pack_label(label, len));
}

#[test(should_fail_with = "invalid duration")]
unconstrained fn fractional_year_rejected() {
    crate::logic::assert_duration(DURATION + 1);
}

#[test]
unconstrained fn released_name_starts_a_new_generation() {
    let (env, registry, alice, bob, node) = setup_with_name();
    env.call_private(alice, NameRegistry::at(registry).set_address(node, 1, 0, true, alice));
    env.call_private(alice, NameRegistry::at(registry).set_primary(node, 1, 1));
    env.advance_next_block_timestamp_by(DURATION + GRACE_PERIOD + 1);
    let (label, len) = label_of("alice");
    let _ = register_name(env, registry, bob, label, len, 1, SECRET_B);
    let rec = env.view_public(NameRegistry::at(registry).get_name(node));
    assert_eq(rec.owner, bob);
    assert_eq(rec.generation, 2);
    assert_eq(rec.revision, 0);
    assert(!env.view_public(NameRegistry::at(registry).get_address(node, 2)).present);
    assert_eq(env.view_public(NameRegistry::at(registry).get_primary(alice)).generation, 1);
}

#[test]
unconstrained fn grace_renewal_starts_from_now() {
    let (env, registry, alice, _bob, node) = setup_with_name();
    let before = env.view_public(NameRegistry::at(registry).get_name(node)).expires_at;
    env.advance_next_block_timestamp_by(DURATION + 86400);
    env.call_private(alice, NameRegistry::at(registry).renew(node, 1, 0, DURATION, 0, FAR_FUTURE, 0));
    let after = env.view_public(NameRegistry::at(registry).get_name(node));
    assert(after.expires_at >= before + DURATION + 86400);
    assert_eq(after.generation, 1);
}

#[test(should_fail)]
unconstrained fn public_helper_cannot_forge_owner() {
    let (env, registry, alice, bob, node) = setup_with_name();
    env.call_public(bob, NameRegistry::at(registry)._set_address(node, 1, 0, alice.to_field(), true, bob));
}
