use aztec::protocol::traits::{Deserialize, Packable, Serialize};

/// Annual prices for the short tiers. `RegistryConfig.annual_price` is the 5+ character price.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct LengthPrices {
    pub three: u128,
    pub four: u128,
}

impl LengthPrices {
    pub fn annual_for(self, len: u32, base: u128) -> u128 {
        if len == 3 { self.three } else if len == 4 { self.four } else { base }
    }
}

/// Rules on top of `pack_label` for new registrations: no "--" anywhere (punycode-style `xn--` look-alikes) and no
/// "0x" prefix (address look-alikes). Call after `pack_label`, which guarantees len >= 3 and zero padding.
pub fn assert_new_label(label: [u8; 31], len: u32) {
    assert(!((label[0] == 48) & (label[1] == 120)), "label cannot start with 0x");
    for i in 1..31 {
        if i < len {
            assert(!((label[i] == 45) & (label[i - 1] == 45)), "label cannot contain --");
        }
    }
}
