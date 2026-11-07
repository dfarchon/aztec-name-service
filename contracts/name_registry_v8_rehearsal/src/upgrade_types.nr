// Frozen serialized governance records: field order and widths are compatibility boundaries.
use aztec::protocol::traits::{Deserialize, Packable, Serialize};
use std::meta::derive;
#[derive(Deserialize, Packable, Serialize)]
pub struct Release { pub status: u8, pub family: Field, pub release_seq: u32, pub approved_at: u64 }
#[derive(Deserialize, Packable, Serialize)]
pub struct Edge { pub status: u8, pub kind: u8, pub approved_at: u64 }
#[derive(Deserialize, Packable, Serialize)]
pub struct PendingUpgrade { pub active: bool, pub kind: u8, pub from: Field, pub to: Field, pub nonce: u64, pub proposed_at: u64, pub ready_at: u64 }
#[derive(Deserialize, Packable, Serialize)]
pub struct ScheduledUpgrade { pub active: bool, pub kind: u8, pub from: Field, pub to: Field, pub nonce: u64, pub activation_at: u64 }
