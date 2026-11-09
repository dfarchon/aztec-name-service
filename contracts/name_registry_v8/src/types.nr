use aztec::protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}};
use std::meta::derive;

#[derive(Deserialize, Packable, Serialize)]
pub struct ParentLink { pub parent: Field, pub parent_generation: u32, pub depth: u32 }
#[derive(Deserialize, Packable, Serialize)]
pub struct TransferOffer { pub recipient: AztecAddress, pub expires_at: u64 }
#[derive(Deserialize, Packable, Serialize)]
pub struct TextValue { pub words: [Field; 8], pub length: u32 }
