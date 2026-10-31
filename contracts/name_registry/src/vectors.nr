use crate::logic::{compute_node, pack_label};
use aztec::protocol::{address::AztecAddress, traits::{FromField, Packable}};
use crate::logic::{record_key, primary_key, compute_register_commitment};
use crate::types::NameMeta;
#[test]
fn labels_match_sdk() {
    let mut label = [0 as u8; 31];
    label[0] = 97; label[1] = 108; label[2] = 105; label[3] = 99; label[4] = 101;
    assert_eq(compute_node(label, 5), 0x1e43ad6ce21bd590eec0cf0102bf2b9c004408b642822c350bd9272a481e4106);
    assert_eq(pack_label(label, 5), 0x616c6963650000000000000000000000000000000000000000000000000000);
}

#[test]
fn keys_commitment_and_packing_match_sdk() {
    let node = 0x1e43ad6ce21bd590eec0cf0102bf2b9c004408b642822c350bd9272a481e4106;
    assert_eq(record_key(node, 1, 0), 0x2a60ad25054c663434d186658f3d09d36416cc091bf25ea3568a35d6c360659b);
    assert_eq(primary_key(0, AztecAddress::from_field(0x1234)), 0x49d87238c9b3f124e99a67cd5b1054f7fd4598094754af7f53926bc76104ef1);
    assert_eq(compute_register_commitment(31337, AztecAddress::from_field(0xabcd), node, 0, 0x99, 31536000,
        AztecAddress::from_field(0x77), AztecAddress::from_field(0x88), 1, 1000, 1700000000, 0x42),
        0x5df62081aa93851512f72883c63943eae2a1503c7d48df06759d36a62039596);
    let meta = NameMeta { generation: 3, revision: 7, expires_at: 1700000000 };
    assert_eq(meta.pack()[0], 0x6553f1000000000700000003);
    assert_eq(NameMeta::unpack(meta.pack()), meta);
}
