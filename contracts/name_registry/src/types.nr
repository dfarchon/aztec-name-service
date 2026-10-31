use aztec::protocol::{address::AztecAddress, traits::{Deserialize, FromField, Packable, Serialize, ToField}};
use std::meta::derive;

global TWO_POW_8: Field = 0x100;
global TWO_POW_32: Field = 0x100000000;
global TWO_POW_64: Field = 0x10000000000000000;

#[derive(Deserialize, Eq, Serialize)]
pub struct NameMeta {
    pub generation: u32,
    pub revision: u32,
    pub expires_at: u64,
}

impl Packable for NameMeta {
    let N: u32 = 1;

    fn pack(self) -> [Field; Self::N] {
        [
            self.generation as Field
                + self.revision as Field * TWO_POW_32
                + self.expires_at as Field * TWO_POW_64
,
        ]
    }

    fn unpack(packed: [Field; Self::N]) -> Self {
        let low = packed[0] as u128;
        Self {
            generation: low as u32,
            revision: (low >> 32) as u32,
            expires_at: (low >> 64) as u64,
        }
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct NameRecord {
    pub generation: u32,
    pub owner: AztecAddress,
    pub revision: u32,
    pub expires_at: u64,
}

#[derive(Deserialize, Eq, Serialize)]
pub struct CommitRecord {
    pub committed_at: u64,
    pub consumed: bool,
}

impl Packable for CommitRecord {
    let N: u32 = 1;

    fn pack(self) -> [Field; Self::N] {
        [self.committed_at as Field + self.consumed as Field * TWO_POW_64]
    }

    fn unpack(packed: [Field; Self::N]) -> Self {
        let committed_at = packed[0] as u64;
        Self { committed_at, consumed: packed[0] != committed_at as Field }
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct AddressRecord {
    pub present: bool,
    pub addr: AztecAddress,
    pub binding_version: u32,
}

impl Packable for AddressRecord {
    let N: u32 = 2;

    fn pack(self) -> [Field; Self::N] {
        [self.addr.to_field(), self.binding_version as Field + self.present as Field * TWO_POW_32]
    }

    fn unpack(packed: [Field; Self::N]) -> Self {
        let binding_version = packed[1] as u32;
        Self {
            present: packed[1] != binding_version as Field,
            addr: AztecAddress::from_field(packed[0]),
            binding_version,
        }
    }
}

#[derive(Deserialize, Eq, Serialize)]
pub struct PrimaryRecord {
    pub present: bool,
    pub node: Field,
    pub generation: u32,
    pub binding_version: u32,
}

impl Packable for PrimaryRecord {
    let N: u32 = 2;

    fn pack(self) -> [Field; Self::N] {
        [
            self.node,
            self.generation as Field + self.binding_version as Field * TWO_POW_32 + self.present as Field * TWO_POW_64,
        ]
    }

    fn unpack(packed: [Field; Self::N]) -> Self {
        let low = packed[1] as u64;
        Self {
            present: packed[1] != low as Field,
            node: packed[0],
            generation: low as u32,
            binding_version: (low >> 32) as u32,
        }
    }
}

#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct RegistryConfig {
    pub fee_token: AztecAddress,
    pub treasury: AztecAddress,
    pub annual_price: u128,
    pub price_version: u32,
}

#[derive(Deserialize, Eq, Serialize)]
pub struct PublishedLabel {
    pub present: bool,
    pub packed_label: Field,
    pub label_len: u32,
}

impl Packable for PublishedLabel {
    let N: u32 = 2;

    fn pack(self) -> [Field; Self::N] {
        [self.packed_label, self.label_len as Field + self.present as Field * TWO_POW_8]
    }

    fn unpack(packed: [Field; Self::N]) -> Self {
        let label_len = packed[1] as u8;
        Self { present: packed[1] != label_len as Field, packed_label: packed[0], label_len: label_len as u32 }
    }
}
