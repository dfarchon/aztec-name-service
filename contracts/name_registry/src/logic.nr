use aztec::{
    protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField},
};

use crate::types::NameMeta;

pub global DOMAIN_LABEL_V1: Field = 0x414e535f4c4142454c5f5631; // "ANS_LABEL_V1"
pub global DOMAIN_NODE_V1: Field = 0x414e535f4e4f44455f5631; // "ANS_NODE_V1"
pub global DOMAIN_REGISTER_V3: Field = 0x414e535f52454749535445525f5633; // "ANS_REGISTER_V3"
pub global DOMAIN_RECORD_KEY_V1: Field = 0x414e535f5245434f52445f5631; // "ANS_RECORD_V1"
pub global DOMAIN_PRIMARY_KEY_V1: Field = 0x414e535f5052494d4152595f5631; // "ANS_PRIMARY_V1"

pub global ROOT_NODE: Field = 0;
pub global MAX_LABEL_LEN: u32 = 31;
pub global MIN_LABEL_LEN: u32 = 3;

pub global MIN_COMMIT_AGE: u64 = 60;
pub global MAX_COMMIT_AGE: u64 = 86400;
pub global GRACE_PERIOD: u64 = 30 * 86400;
pub global MIN_DURATION: u64 = 365 * 86400;
pub global MAX_DURATION: u64 = 5 * 365 * 86400;

pub global SECONDS_PER_YEAR: u64 = 365 * 86400;
/// Keeps `annual_price * MAX_DURATION` far below the u128 limit.
pub global MAX_ANNUAL_PRICE: u128 = 0x1000000000000000000000000; // 2^96


/// Registration commitment. Binds the deployment, the name, the expected generation, the future holder, the lease and
/// every fee condition, so a copied commitment is useless and a changed price requires a new plan.
pub fn compute_register_commitment(
    chain_id: Field,
    registry: AztecAddress,
    node: Field,
    expected_generation: u32,
    owner: Field,
    duration: u64,
    fee_token: AztecAddress,
    treasury: AztecAddress,
    price_version: u32,
    max_fee: u128,
    quote_expiry: u64,
    secret: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [
            chain_id,
            registry.to_field(),
            node,
            expected_generation as Field,
            owner,
            duration as Field,
            fee_token.to_field(),
            treasury.to_field(),
            price_version as Field,
            max_fee as Field,
            quote_expiry as Field,
            secret,
        ],
        DOMAIN_REGISTER_V3,
    )
}

/// Validates a label (3–31 chars of [a-z0-9-], no leading/trailing hyphen, zero padding after `len`) and packs it
/// big-endian into a single Field.
pub fn pack_label(label: [u8; 31], len: u32) -> Field {
    assert((len >= MIN_LABEL_LEN) & (len <= MAX_LABEL_LEN), "invalid label length");
    let mut packed: Field = 0;
    for i in 0..MAX_LABEL_LEN {
        let ch = label[i];
        if i < len {
            let is_lower = (ch >= 97) & (ch <= 122);
            let is_digit = (ch >= 48) & (ch <= 57);
            let is_hyphen = ch == 45;
            assert(is_lower | is_digit | is_hyphen, "invalid label character");
            if (i == 0) | (i == len - 1) {
                assert(!is_hyphen, "label cannot start or end with hyphen");
            }
        } else {
            assert(ch == 0, "label padding must be zero");
        }
        packed = packed * 256 + ch as Field;
    }
    packed
}

pub fn node_from_packed(packed_label: Field, len: u32) -> Field {
    let label_key = poseidon2_hash_with_separator([len as Field, packed_label], DOMAIN_LABEL_V1);
    poseidon2_hash_with_separator([ROOT_NODE, label_key], DOMAIN_NODE_V1)
}

pub fn compute_node(label: [u8; 31], len: u32) -> Field {
    node_from_packed(pack_label(label, len), len)
}

/// Pro-rata fee for `duration` seconds, rounded up.
pub fn fee_for(annual_price: u128, duration: u64) -> u128 {
    let year = SECONDS_PER_YEAR as u128;
    (annual_price * (duration as u128) + year - 1) / year
}

pub fn record_key(node: Field, generation: u32, scope: Field) -> Field {
    poseidon2_hash_with_separator([node, generation as Field, scope], DOMAIN_RECORD_KEY_V1)
}

pub fn primary_key(scope: Field, address: AztecAddress) -> Field {
    poseidon2_hash_with_separator([scope, address.to_field()], DOMAIN_PRIMARY_KEY_V1)
}

pub fn is_active(meta: NameMeta, now: u64) -> bool {
    (meta.generation != 0) & (now < meta.expires_at)
}

pub fn is_available(meta: NameMeta, now: u64) -> bool {
    if meta.generation == 0 {
        true
    } else {
        now >= meta.expires_at + GRACE_PERIOD
    }
}

pub fn assert_cleared_record(present: bool, addr: AztecAddress) {
    if present {
        assert(!addr.is_zero(), "address must not be zero");
    } else {
        assert(addr == AztecAddress::zero(), "cleared record must use zero address");
    }
}

pub fn assert_duration(duration: u64) {
    assert((duration >= MIN_DURATION) & (duration <= MAX_DURATION) & (duration % SECONDS_PER_YEAR == 0), "invalid duration");
}

/// `stored_owner` is the public owner address; `owner` is the authenticated caller.
pub fn assert_holder(
    meta: NameMeta,
    stored_owner: Field,
    generation: u32,
    expected_revision: u32,
    owner: Field,
) {
    assert(meta.generation != 0, "name not registered");
    assert(meta.generation == generation, "generation mismatch");
    assert(meta.revision == expected_revision, "revision mismatch");
    assert(stored_owner == owner, "not the holder");
}

pub fn assert_holder_active(
    meta: NameMeta,
    stored_owner: Field,
    now: u64,
    generation: u32,
    expected_revision: u32,
    owner: Field,
) {
    assert_holder(meta, stored_owner, generation, expected_revision, owner);
    assert(now < meta.expires_at, "name not active");
}
