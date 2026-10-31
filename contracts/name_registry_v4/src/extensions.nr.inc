    #[event]
    struct NameTransferred { node: Field, generation: u32, previous_owner: AztecAddress, owner: AztecAddress }
    #[event]
    struct ManagerChanged { node: Field, generation: u32, manager: AztecAddress }
    #[event]
    struct TransferOffered { node: Field, generation: u32, recipient: AztecAddress, expires_at: u64 }
    #[event]
    struct SubnameIssued { parent: Field, node: Field, generation: u32, owner: AztecAddress }
    #[event]
    struct RecordChanged { node: Field, generation: u32, key: Field }

    // A child inherits the lifetime and generation of every ancestor. No descendant walk or mass deletion is needed.
    #[internal("public")]
    fn live_expiry(node: Field) -> u64 {
        let mut current = node;
        let mut expiry = self.storage.names.at(node).read().expires_at;
        let mut valid = true;
        for _ in 0..5 {
            if current != 0 {
                let link = self.storage.parents.at(current).read();
                if link.parent != 0 {
                    let parent = self.storage.names.at(link.parent).read();
                    valid = valid & (parent.generation == link.parent_generation) & (parent.generation > 0);
                    if parent.expires_at < expiry { expiry = parent.expires_at; }
                }
                current = link.parent;
            }
        }
        assert(current == 0, "subname depth exceeded");
        if valid { expiry } else { 0 }
    }

    #[internal("public")]
    fn assert_editor(actor: AztecAddress, node: Field, generation: u32, revision: u32) {
        let meta = self.storage.names.at(node).read();
        assert((meta.generation == generation) & (generation > 0) & (meta.revision == revision), "generation or revision mismatch");
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");
        let manager = self.storage.managers.at(record_key(node, generation, 0)).read();
        assert((actor.to_field() == self.storage.owners.at(node).read()) | (!manager.is_zero() & (manager == actor)), "not record editor");
    }

    #[external("private")]
    fn set_manager(node: Field, generation: u32, revision: u32, manager: AztecAddress) {
        self.enqueue_self._set_manager(self.msg_sender(), node, generation, revision, manager);
    }
    #[external("public")]
    #[only_self]
    fn _set_manager(owner: AztecAddress, node: Field, generation: u32, revision: u32, manager: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, revision, owner.to_field());
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        self.storage.managers.at(record_key(node, generation, 0)).write(manager);
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(ManagerChanged { node, generation, manager });
    }

    // Zero recipient cancels an existing offer. Recipient acceptance prevents accidental unilateral delivery.
    #[external("private")]
    fn offer_transfer(node: Field, generation: u32, revision: u32, recipient: AztecAddress) {
        self.enqueue_self._offer_transfer(self.msg_sender(), node, generation, revision, recipient);
    }
    #[external("public")]
    #[only_self]
    fn _offer_transfer(owner: AztecAddress, node: Field, generation: u32, revision: u32, recipient: AztecAddress) {
        let meta = self.storage.names.at(node).read();
        assert_holder_active(meta, self.storage.owners.at(node).read(), self.context.timestamp(), generation, revision, owner.to_field());
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "parent not active");
        assert(recipient != owner, "recipient is current owner");
        let expires_at = if recipient.is_zero() { 0 } else { self.context.timestamp() + 604800 };
        self.storage.transfers.at(record_key(node, generation, 0)).write(TransferOffer { recipient, expires_at });
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(TransferOffered { node, generation, recipient, expires_at });
    }
    #[external("private")]
    fn accept_transfer(node: Field, generation: u32, revision: u32) {
        self.enqueue_self._accept_transfer(self.msg_sender(), node, generation, revision);
    }
    #[external("public")]
    #[only_self]
    fn _accept_transfer(recipient: AztecAddress, node: Field, generation: u32, revision: u32) {
        let meta = self.storage.names.at(node).read();
        assert((meta.generation == generation) & (meta.revision == revision) & (generation > 0), "generation or revision mismatch");
        assert(self.internal.live_expiry(node) > self.context.timestamp(), "name not active");
        let key = record_key(node, generation, 0);
        let offer = self.storage.transfers.at(key).read();
        assert(!recipient.is_zero() & (offer.recipient == recipient), "not transfer recipient");
        assert(self.context.timestamp() < offer.expires_at, "transfer offer expired");
        let previous_owner = AztecAddress::from_field(self.storage.owners.at(node).read());
        let next = generation + 1;
        self.storage.names.at(node).write(NameMeta { generation: next, revision: 0, expires_at: meta.expires_at });
        self.storage.owners.at(node).write(recipient.to_field());
        self.storage.resolvers.at(record_key(node, next, 0)).write(self.storage.resolvers.at(key).read());
        // Manager, text, forward and primary bindings remain scoped to the old generation.
        let published = self.storage.published_labels.at(node).read();
        self.emit(NameRegisteredV3 { node, generation: next, expires_at: meta.expires_at, owner: recipient, packed_label: published.packed_label, label_len: published.label_len });
        self.emit(NameTransferred { node, generation: next, previous_owner, owner: recipient });
    }

    #[external("private")]
    fn issue_subname(parent: Field, parent_generation: u32, parent_revision: u32, label: [u8; 31], len: u32, expected_generation: u32, owner: AztecAddress, expires_at: u64) {
        let packed = pack_label(label, len);
        self.enqueue_self._issue_subname(self.msg_sender(), parent, parent_generation, parent_revision, packed, len, expected_generation, owner, expires_at);
    }
    #[external("public")]
    #[only_self]
    fn _issue_subname(actor: AztecAddress, parent: Field, parent_generation: u32, parent_revision: u32, packed_label: Field, label_len: u32, expected_generation: u32, owner: AztecAddress, expires_at: u64) {
        let meta = self.storage.names.at(parent).read();
        assert_holder_active(meta, self.storage.owners.at(parent).read(), self.context.timestamp(), parent_generation, parent_revision, actor.to_field());
        let limit = self.internal.live_expiry(parent);
        assert((expires_at > self.context.timestamp()) & (expires_at <= limit), "invalid subname expiry");
        assert(!owner.is_zero(), "owner required");
        let depth = self.storage.parents.at(parent).read().depth + 1;
        assert(depth <= 4, "subname depth exceeded");
        let label_hash = poseidon2_hash_with_separator([label_len as Field, packed_label], DOMAIN_LABEL_V1);
        let node = poseidon2_hash_with_separator([parent, label_hash], DOMAIN_NODE_V1);
        let old = self.storage.names.at(node).read();
        assert(old.generation == expected_generation, "generation mismatch");
        let generation = expected_generation + 1;
        self.storage.parents.at(node).write(ParentLink { parent, parent_generation, depth });
        self.storage.names.at(node).write(NameMeta { generation, revision: 0, expires_at });
        self.storage.owners.at(node).write(owner.to_field());
        self.storage.resolvers.at(record_key(node, generation, 0)).write(self.storage.modules.read().resolver);
        self.storage.published_labels.at(node).write(PublishedLabel { present: true, packed_label, label_len });
        self.emit(NameRegisteredV3 { node, generation, expires_at, owner, packed_label, label_len });
        self.emit(SubnameIssued { parent, node, generation, owner });
    }

    #[external("private")]
    fn revoke_subname(node: Field, generation: u32, parent_generation: u32, parent_revision: u32) {
        self.enqueue_self._revoke_subname(self.msg_sender(), node, generation, parent_generation, parent_revision);
    }
    #[external("public")]
    #[only_self]
    fn _revoke_subname(actor: AztecAddress, node: Field, generation: u32, parent_generation: u32, parent_revision: u32) {
        let link = self.storage.parents.at(node).read();
        assert(link.parent != 0, "not a subname");
        let parent = self.storage.names.at(link.parent).read();
        assert_holder_active(parent, self.storage.owners.at(link.parent).read(), self.context.timestamp(), parent_generation, parent_revision, actor.to_field());
        assert(self.internal.live_expiry(link.parent) > self.context.timestamp(), "parent not active");
        let meta = self.storage.names.at(node).read();
        assert(meta.generation == generation, "generation mismatch");
        self.storage.names.at(node).write(NameMeta { generation: generation + 1, revision: 0, expires_at: 0 });
        self.storage.owners.at(node).write(0);
        self.emit(SubnameIssued { parent: link.parent, node, generation: generation + 1, owner: AztecAddress::zero() });
    }

    #[external("private")]
    fn set_text(node: Field, generation: u32, revision: u32, key: Field, value: [u8; 248], length: u32) {
        assert(length <= 248, "record too long");
        assert(key != 0, "record key required");
        let mut words = [0; 8];
        for i in 0..248 {
            if i >= length { assert(value[i] == 0, "nonzero record padding"); }
            words[i / 31] = words[i / 31] * 256 + value[i] as Field;
        }
        self.enqueue_self._set_text(self.msg_sender(), node, generation, revision, key, words, length);
    }
    #[external("public")]
    #[only_self]
    fn _set_text(actor: AztecAddress, node: Field, generation: u32, revision: u32, key: Field, words: [Field; 8], length: u32) {
        self.internal.assert_editor(actor, node, generation, revision);
        let scope = record_key(node, generation, 0);
        let value_key = poseidon2_hash_with_separator([scope, key], 0x414e535f544558545f5634);
        if !self.storage.text_seen.at(value_key).read() {
            let count = self.storage.text_count.at(scope).read();
            assert(count < 64, "record key limit reached");
            let index = poseidon2_hash_with_separator([scope, count as Field], 0x414e535f494e4445585f5634);
            self.storage.text_keys.at(index).write(key);
            self.storage.text_count.at(scope).write(count + 1);
            self.storage.text_seen.at(value_key).write(true);
        }
        self.storage.text_values.at(value_key).write(TextValue { words, length });
        let meta = self.storage.names.at(node).read();
        self.storage.names.at(node).write(NameMeta { generation, revision: revision + 1, expires_at: meta.expires_at });
        self.emit(RecordChanged { node, generation, key });
    }
