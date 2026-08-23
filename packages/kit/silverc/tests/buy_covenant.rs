//! Local reproduction of the kticket buy covenant spend (KTK-102 follow-up).
//!
//! Compiles the real Event contract, injects state, builds the deploy covenant
//! UTXO and the buy transaction exactly as the kit builder does, then runs the
//! node's covenant VM on input 0. If this passes, the sig script / tx assembly
//! is correct; if it fails, the error pinpoints the offending check.

use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::tx::{
    CovenantBinding, MutableTransaction, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput,
    TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script};
use kaspa_txscript_errors::TxScriptError;
use secp256k1::{Keypair, Secp256k1, SecretKey};
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{CompileOptions, CompiledContract, compile_contract};
use std::fs;

const COV_A: Hash = Hash::from_bytes(*b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const DUST: u64 = 50_000_000;
const PRICE: i64 = 100_000_000;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn bytes32(s: &str) -> [u8; 32] {
    hex(s).try_into().expect("32 bytes")
}

fn compile_contract_file(name: &str, ctor: Vec<Expr<'static>>) -> CompiledContract<'static> {
    let path = format!("{}/../contracts/{}.sil", env!("CARGO_MANIFEST_DIR"), name);
    let source = Box::leak(Box::new(fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))));
    compile_contract(source.as_str(), &ctor, CompileOptions::default()).expect("compile succeeds")
}

fn event_compiled(authorizing_txid: Vec<u8>, org_spk: Vec<u8>) -> CompiledContract<'static> {
    // Burn template parts (prefix / suffix / hash) come from the burn compile.
    let burn = compile_contract_file("burn", vec![Expr::bytes(authorizing_txid.clone())]);
    let layout = burn.state_layout;
    let prefix = burn.bytecode[..layout.start].to_vec();
    let suffix = burn.bytecode[layout.start + layout.len..].to_vec();
    let template_hash = burn.template_hash().to_vec();

    // The organizer pubkey x-coordinate (org_pkh) is embedded in the P2PK org_spk.
    let org_pkh = &org_spk[1..1 + 32];

    compile_contract_file(
        "event",
        vec![
            Expr::bytes(authorizing_txid),
            Expr::int(PRICE),
            Expr::dynamic_bytes([vec![0x00, 0x00], org_spk.clone()].concat()), // version-prefixed spk
            Expr::bytes(template_hash),
            Expr::dynamic_bytes(prefix),
            Expr::dynamic_bytes(suffix),
            Expr::bytes(org_pkh.to_vec()),
        ],
    )
}

/// Inject the event state into the bytecode's state slot (owner, id=0,
/// amount, is_minter=false, used=false, sale_price) — the same 57-byte
/// push-encoded layout the kit's `encodeState` produces.
fn inject_state_full(compiled: &CompiledContract, owner: Vec<u8>, amount: i64, used: u8, sale_price: i64) -> Vec<u8> {
    let layout = compiled.state_layout;
    let mut state = Vec::new();
    state.push(0x20);
    state.extend_from_slice(&owner);
    state.push(0x01);
    state.push(0x00);
    state.push(0x08);
    state.extend_from_slice(&amount.to_le_bytes());
    state.push(0x01);
    state.push(0x00);
    state.push(0x01);
    state.push(used);
    state.push(0x08);
    state.extend_from_slice(&sale_price.to_le_bytes());
    assert_eq!(state.len(), layout.len, "encoded state must fill the state slot");

    let mut bytecode = compiled.bytecode.clone();
    bytecode.splice(layout.start..layout.start + layout.len, state.iter().cloned());
    bytecode
}

/// Inject the event state into the bytecode's state slot (owner, id=0,
/// amount, is_minter=false, used=false) — the same 48-byte push-encoded layout
/// the kit's `encodeState` produces.
fn inject_state(compiled: &CompiledContract, owner: Vec<u8>, amount: i64) -> Vec<u8> {
    inject_state_full(compiled, owner, amount, 0, 0)
}

/// Inject the event state with an explicit `used` flag (the door's mark_used).
fn inject_state_used(compiled: &CompiledContract, owner: Vec<u8>, amount: i64, used: u8) -> Vec<u8> {
    inject_state_full(compiled, owner, amount, used, 0)
}

fn push_redeem_script(bytecode: &[u8]) -> Vec<u8> {
    ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() })
        .add_data(bytecode)
        .expect("push redeem")
        .drain()
}

/// The covenant spend sig script: mint call args + state-injected redeem reveal.
fn mint_sigscript(compiled: &CompiledContract, buyer_pkh: &[u8], event_redeem: &[u8]) -> Vec<u8> {
    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("mint", vec![Expr::bytes(buyer_pkh.to_vec())], Default::default())
        .expect("mint sigscript");
    sigscript.extend_from_slice(&push_redeem_script(event_redeem));
    sigscript
}

fn p2pk_script(x: &[u8]) -> ScriptPublicKey {
    let mut script = vec![0x20];
    script.extend_from_slice(x);
    script.push(0xac);
    ScriptPublicKey::new(0, script.into())
}

fn execute_input_with_covenants(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("selected input utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
    );
    vm.execute()
}

fn random_keypair() -> Keypair {
    use rand::RngCore;
    let secp = Secp256k1::new();
    let mut sk = [0u8; 32];
    loop {
        rand::thread_rng().fill_bytes(&mut sk);
        if let Ok(secret_key) = SecretKey::from_slice(&sk) {
            return Keypair::from_secret_key(&secp, &secret_key);
        }
    }
}

fn sign_input1(tx: &Transaction, entries: &[UtxoEntry], input_idx: usize, keypair: &Keypair) -> Vec<u8> {
    let tx = MutableTransaction::with_entries(tx.clone(), entries.to_vec());
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = calc_schnorr_signature_hash(&tx.as_verifiable(), input_idx, SIG_HASH_ALL, &reused);
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("sighash message");
    let sig = keypair.sign_schnorr(msg);
    let mut signature = sig.as_ref().to_vec();
    signature.push(SIG_HASH_ALL.to_u8());
    signature
}

#[test]
fn buy_mint_covenant_passes_on_chain_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");
    let org_spk = hex("2050a41b9578b6be3a7044c94ddfcdf40142b44984d309bf946c3c5e89eb95d48fac");
    let org = hex("50a41b9578b6be3a7044c94ddfcdf40142b44984d309bf946c3c5e89eb95d48f");

    let buyer_kp = random_keypair();
    let buyer_x = buyer_kp.x_only_public_key().0.serialize().to_vec();

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.clone());
    let event_redeem = inject_state(&compiled, org.clone(), 12);
    let ticket_redeem = inject_state(&compiled, buyer_x.clone(), 1);
    let remaining_redeem = inject_state(&compiled, org.clone(), 11);

    // The deployed event covenant UTXO.
    let event_value = DUST;
    let event_entries = vec![UtxoEntry::new(event_value, pay_to_script_hash_script(&event_redeem), 0, false, Some(COV_A))];

    // The buyer's P2PK UTXO (funds the purchase).
    let buyer_value = 98_568_234_200u64;
    let buyer_spk = p2pk_script(&buyer_x);

    let change_value = buyer_value - PRICE as u64 - DUST - 100_000;

    // Build the buy tx (mirrors buildBuy output structure).
    let sig0 = mint_sigscript(&compiled, &buyer_x, &event_redeem);
    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                sig0,
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: DUST,
                script_public_key: pay_to_script_hash_script(&ticket_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: DUST,
                script_public_key: pay_to_script_hash_script(&remaining_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: PRICE as u64,
                script_public_key: ScriptPublicKey::new(0, org_spk.clone().into()),
                covenant: None,
            },
            TransactionOutput {
                value: change_value,
                script_public_key: buyer_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    // Sign input 1 (the buyer's P2PK).
    let entries_for_signing = vec![
        event_entries[0].clone(),
        UtxoEntry::new(buyer_value, buyer_spk.clone(), 0, false, None),
    ];
    let sig1 = sign_input1(&unsigned, &entries_for_signing, 1, &buyer_kp);

    // Assemble the signed tx: input 0 = mint sig script, input 1 = buyer sig + P2PK script.
    let mut sig1_script = sig1;
    sig1_script.extend_from_slice(&buyer_spk.script());
    let mut input1 = unsigned.inputs[1].clone();
    input1.signature_script = sig1_script;
    let inputs = vec![unsigned.inputs[0].clone(), input1];
    let tx = Transaction::new(1, inputs, unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);

    let entries = vec![
        event_entries[0].clone(),
        UtxoEntry::new(buyer_value, buyer_spk.clone(), 0, false, None),
    ];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "buy covenant spend should pass: {result:?}");
}

/// The door check-in (KTK-118): owner + organizer co-sign the ticket into its
/// `used: true` state via the `mark_used` transition. The ticket stays with the
/// owner — nothing is burned. Proves the full mark_used covenant spend passes
/// on the node VM with two real Schnorr signatures.
#[test]
fn mark_used_covenant_passes_on_chain_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    // The gate key is the organizer's — `org_pkh` baked into the event contract
    // derives from the P2PK `org_spk`, so the gate signature must come from the
    // matching private key.
    let org_kp = random_keypair();
    let org_x = org_kp.x_only_public_key().0.serialize().to_vec();
    let org_spk = p2pk_script(&org_x);

    let owner_kp = random_keypair();
    let owner_x = owner_kp.x_only_public_key().0.serialize().to_vec();

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    // The minted ticket (unused) is owned by the ticket holder.
    let ticket_redeem = inject_state(&compiled, owner_x.clone(), 1);
    // The door marks it used — owner preserved, used = 0x01.
    let used_redeem = inject_state_used(&compiled, owner_x.clone(), 1, 1);

    let ticket_value = DUST;
    let owner_value = 1_000_000_000u64;
    let owner_spk = p2pk_script(&owner_x);
    let change_value = owner_value - 100_000;

    // The unsigned mark_used template: inputs [ticket, owner fee UTXO],
    // outputs [ticket at used:true, owner change].
    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&used_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: change_value,
                script_public_key: owner_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    // Both parties sign the ticket input (input 0) over the same sighash — the
    // covenant's two `checkSig` calls each verify their own 65-byte push.
    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&ticket_redeem), 0, false, Some(COV_A));
    let owner_entry = UtxoEntry::new(owner_value, owner_spk.clone(), 0, false, None);
    let sig_owner = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 0, &owner_kp);
    let sig_gate = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 0, &org_kp);

    // The mark_used sigscript: push(owner_sig) || push(gate_sig) || <selector> ||
    // push(redeem) — assembled server-side at finalize (KTK-129).
    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl(
            "mark_used",
            vec![Expr::bytes(sig_owner), Expr::bytes(sig_gate)],
            Default::default(),
        )
        .expect("mark_used sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&ticket_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    // Sign the owner's P2PK fee input (input 1).
    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 1, &owner_kp);
    sig1.extend_from_slice(&owner_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, owner_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "mark_used covenant spend should pass: {result:?}");
}

/// Verifies the REAL buyer P2PK signature (from Kasware) against the REAL
/// broadcast buy tx. If this fails, the wallet signed a different transaction
/// than the one the API broadcasts — the root cause of the node rejection.
#[test]
fn real_buy_input1_signature_verifies_against_broadcast_tx() {
    let cov = Hash::from_bytes(bytes32("7e02db46465b68d433e9ab87ac63ad9e8420480d6f8710404f88b235f1b2e9bc"));
    let event_spk = ScriptPublicKey::new(0, hex("aa203be9ce351b4dce0bfd5536de6cae53eff0dd2771ac396f6fb7c4170eff9150f787").into());
    let buyer_spk = ScriptPublicKey::new(0, hex("2071721fd48bf471ad50131c6c3c837dbf13c246041f8478d92f89a588d7a5e8e3ac").into());

    // The tx exactly as broadcast (sig scripts don't affect the sighash).
    let tx = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes(bytes32("1d2b2cdf2a8846c1dd33fa12df0820010610695ccec9a95a2777facb967759da")), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes(bytes32("8ea6a4d324a79a20aa5788128a1651204c0cde7611b9c944fbeb1f5ce5affab6")), index: 1 },
                hex("410d8823ce741a593e0cf928d934b72eeb0622678cad8dd814be852bdc30707ba4980eaab8629973a5d07de81a66d0899fbda664249a878e7a9243a250fdb3671901"),
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput { value: 50_000_000, script_public_key: ScriptPublicKey::new(0, hex("aa20e061f8db45749a1dd7b3477990dcb9c59aaf7737b3d1d3c40d21583c04caeead87").into()), covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: cov }) },
            TransactionOutput { value: 50_000_000, script_public_key: ScriptPublicKey::new(0, hex("aa202b193c77f2a9042506d1f58a0473b4bc0bdbbd0c2d74aaa263277d51db3cefae87").into()), covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: cov }) },
            TransactionOutput { value: 100_000_000, script_public_key: ScriptPublicKey::new(0, hex("2050a41b9578b6be3a7044c94ddfcdf40142b44984d309bf946c3c5e89eb95d48fac").into()), covenant: None },
            TransactionOutput { value: 98_408_047_400, script_public_key: buyer_spk.clone(), covenant: None },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let entries = vec![
        UtxoEntry::new(50_000_000, event_spk, 0, false, Some(cov)),
        UtxoEntry::new(98_568_234_200, buyer_spk.clone(), 0, false, None),
    ];

    // The buyer P2PK output script is `20 <x> ac`; the input sig script is just
    // the Schnorr signature. Execute input 1 exactly as the node would.
    let result = execute_input_with_covenants(tx, entries, 1);
    assert!(result.is_ok(), "real buyer signature should verify: {result:?}");
}

// ---------------------------------------------------------------------------
// Resale (KTK-151): list / delist / purchase golden tests against the node VM.
// ---------------------------------------------------------------------------

/// Resale — list: the holder signs the `list` transition, embedding an asking
/// price in the covenant state itself. The listing is fully on chain.
#[test]
fn list_covenant_passes_on_chain_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let holder_kp = random_keypair();
    let holder_x = holder_kp.x_only_public_key().0.serialize().to_vec();
    let holder_spk = p2pk_script(&holder_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    let ticket_redeem = inject_state(&compiled, holder_x.clone(), 1);
    let listed_redeem = inject_state_full(&compiled, holder_x.clone(), 1, 0, PRICE);

    let ticket_value = DUST;
    let holder_value = 1_000_000_000u64;
    let change_value = holder_value - 100_000;

    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&listed_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: change_value,
                script_public_key: holder_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&ticket_redeem), 0, false, Some(COV_A));
    let holder_entry = UtxoEntry::new(holder_value, holder_spk.clone(), 0, false, None);
    let sig_holder = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 0, &holder_kp);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("list", vec![Expr::bytes(sig_holder), Expr::int(PRICE)], Default::default())
        .expect("list sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&ticket_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 1, &holder_kp);
    sig1.extend_from_slice(&holder_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, holder_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "list covenant spend should pass: {result:?}");
}

/// Resale — purchase (trustless): NO seller signature anywhere. The covenant
/// enforces that one output pays exactly the asking price to the seller's P2PK
/// script while the ticket re-keys to the buyer atomically.
#[test]
fn purchase_covenant_passes_on_chain_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let seller_kp = random_keypair();
    let seller_x = seller_kp.x_only_public_key().0.serialize().to_vec();

    let buyer_kp = random_keypair();
    let buyer_x = buyer_kp.x_only_public_key().0.serialize().to_vec();
    let buyer_spk = p2pk_script(&buyer_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    let listed_ticket_redeem = inject_state_full(&compiled, seller_x.clone(), 1, 0, PRICE);
    let purchased_ticket_redeem = inject_state(&compiled, buyer_x.clone(), 1);

    let ticket_value = DUST;
    let buyer_value = 1_000_000_000u64;
    let change_value = buyer_value - PRICE as u64 - 100_000;

    // inputs [ticket(0), buyer fee(1)],
    // outputs [ticket@buyer (bound), seller payout @asking price, buyer change].
    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&purchased_ticket_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: PRICE as u64,
                script_public_key: p2pk_script(&seller_x),
                covenant: None,
            },
            TransactionOutput {
                value: change_value,
                script_public_key: buyer_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&listed_ticket_redeem), 0, false, Some(COV_A));
    let buyer_entry = UtxoEntry::new(buyer_value, buyer_spk.clone(), 0, false, None);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("purchase", vec![Expr::bytes(buyer_x.clone())], Default::default())
        .expect("purchase sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&listed_ticket_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), buyer_entry.clone()], 1, &buyer_kp);
    sig1.extend_from_slice(&buyer_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, buyer_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "trustless purchase covenant spend should pass: {result:?}");
}

/// The negative half of trustless escrow: a `purchase` spend whose outputs do
/// NOT pay the asking price to the seller's P2PK script must be rejected by
/// the VM. This is what makes the seller's custody safe without signatures.
#[test]
fn purchase_without_seller_payout_is_rejected_by_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let seller_x = random_keypair().x_only_public_key().0.serialize().to_vec();

    let buyer_kp = random_keypair();
    let buyer_x = buyer_kp.x_only_public_key().0.serialize().to_vec();
    let buyer_spk = p2pk_script(&buyer_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    let listed_ticket_redeem = inject_state_full(&compiled, seller_x.clone(), 1, 0, PRICE);
    let purchased_ticket_redeem = inject_state(&compiled, buyer_x.clone(), 1);

    let ticket_value = DUST;
    let buyer_value = 1_000_000_000u64;

    // Same as the passing test, but the seller payout output is missing — the
    // buyer tries to keep the asking price for themselves.
    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&purchased_ticket_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: buyer_value - 100_000,
                script_public_key: buyer_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&listed_ticket_redeem), 0, false, Some(COV_A));
    let buyer_entry = UtxoEntry::new(buyer_value, buyer_spk.clone(), 0, false, None);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("purchase", vec![Expr::bytes(buyer_x.clone())], Default::default())
        .expect("purchase sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&listed_ticket_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), buyer_entry.clone()], 1, &buyer_kp);
    sig1.extend_from_slice(&buyer_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, buyer_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_err(), "purchase without seller payout must be rejected by the VM");
}

/// Resale — delist: the holder cancels the listing before anyone buys.
#[test]
fn delist_covenant_passes_on_chain_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let holder_kp = random_keypair();
    let holder_x = holder_kp.x_only_public_key().0.serialize().to_vec();
    let holder_spk = p2pk_script(&holder_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    let listed_redeem = inject_state_full(&compiled, holder_x.clone(), 1, 0, PRICE);
    let unlisted_redeem = inject_state(&compiled, holder_x.clone(), 1);

    let ticket_value = DUST;
    let holder_value = 1_000_000_000u64;

    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&unlisted_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: holder_value - 100_000,
                script_public_key: holder_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&listed_redeem), 0, false, Some(COV_A));
    let holder_entry = UtxoEntry::new(holder_value, holder_spk.clone(), 0, false, None);
    let sig_holder = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 0, &holder_kp);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("delist", vec![Expr::bytes(sig_holder)], Default::default())
        .expect("delist sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&listed_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 1, &holder_kp);
    sig1.extend_from_slice(&holder_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, holder_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "delist covenant spend should pass: {result:?}");
}

/// Check-in absorbs the listing (v3): a listed, unused ticket passes through
/// `mark_used` and comes out `used` with `sale_price` forced to 0 — the door
/// delists forever, without any seller cooperation beyond their own entry.
#[test]
fn mark_used_on_listed_ticket_clears_the_sale_price() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let org_kp = random_keypair();
    let org_x = org_kp.x_only_public_key().0.serialize().to_vec();
    let org_spk = p2pk_script(&org_x);

    let owner_kp = random_keypair();
    let owner_x = owner_kp.x_only_public_key().0.serialize().to_vec();

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    // Listed AND unused at the door: the seller never cancelled their sale.
    let listed_redeem = inject_state_full(&compiled, owner_x.clone(), 1, 0, PRICE);
    // The door's continuation: used = 0x01, listing gone (sale_price = 0).
    let checked_in_redeem = inject_state_used(&compiled, owner_x.clone(), 1, 1);

    let ticket_value = DUST;
    let owner_value = 1_000_000_000u64;
    let owner_spk = p2pk_script(&owner_x);
    let change_value = owner_value - 100_000;

    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&checked_in_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: change_value,
                script_public_key: owner_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&listed_redeem), 0, false, Some(COV_A));
    let owner_entry = UtxoEntry::new(owner_value, owner_spk.clone(), 0, false, None);
    let sig_owner = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 0, &owner_kp);
    let sig_gate = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 0, &org_kp);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl(
            "mark_used",
            vec![Expr::bytes(sig_owner), Expr::bytes(sig_gate)],
            Default::default(),
        )
        .expect("mark_used sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&listed_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), owner_entry.clone()], 1, &owner_kp);
    sig1.extend_from_slice(&owner_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, owner_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_ok(), "check-in of a listed ticket must clear its sale price and pass: {result:?}");
}

/// v3 guard: `list` refuses checked-in tickets. A used ticket can never enter
/// the market again — not even by hand-crafting the transition outside the app.
#[test]
fn list_on_used_ticket_is_rejected_by_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let holder_kp = random_keypair();
    let holder_x = holder_kp.x_only_public_key().0.serialize().to_vec();
    let holder_spk = p2pk_script(&holder_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    // Already checked in: used = 0x01, unlisted.
    let used_redeem = inject_state_full(&compiled, holder_x.clone(), 1, 1, 0);
    // The market re-entry attempt: same ticket, now carrying an asking price.
    let relisted_redeem = inject_state_full(&compiled, holder_x.clone(), 1, 1, PRICE);

    let ticket_value = DUST;
    let holder_value = 1_000_000_000u64;
    let change_value = holder_value - 100_000;

    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&relisted_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: change_value,
                script_public_key: holder_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&used_redeem), 0, false, Some(COV_A));
    let holder_entry = UtxoEntry::new(holder_value, holder_spk.clone(), 0, false, None);
    let sig_holder = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 0, &holder_kp);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("list", vec![Expr::bytes(sig_holder), Expr::int(PRICE)], Default::default())
        .expect("list sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&used_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), holder_entry.clone()], 1, &holder_kp);
    sig1.extend_from_slice(&holder_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, holder_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_err(), "listing a checked-in ticket must be rejected by the VM");
}

/// v3 guard: `purchase` refuses checked-in tickets. Even the unreachable
/// used+listed hybrid (e.g. minted before v3) cannot change hands — buyers are
/// mathematically safe from ever receiving a worthless ticket.
#[test]
fn purchase_of_used_ticket_is_rejected_by_vm() {
    let authorizing_txid = hex("a5ab658104d1984066e070c644dd53a0977129898423430e1607fe577e2e731b");

    let seller_x = random_keypair().x_only_public_key().0.serialize().to_vec();

    let buyer_kp = random_keypair();
    let buyer_x = buyer_kp.x_only_public_key().0.serialize().to_vec();
    let buyer_spk = p2pk_script(&buyer_x);

    let org_kp = random_keypair();
    let org_spk = p2pk_script(&org_kp.x_only_public_key().0.serialize());

    let compiled = event_compiled(authorizing_txid.clone(), org_spk.script().to_vec());
    // The pre-v3 hybrid: checked in but still carrying a price tag.
    let hybrid_redeem = inject_state_full(&compiled, seller_x.clone(), 1, 1, PRICE);
    let purchased_ticket_redeem = inject_state(&compiled, buyer_x.clone(), 1);

    let ticket_value = DUST;
    let buyer_value = 1_000_000_000u64;
    let change_value = buyer_value - PRICE as u64 - 100_000;

    let unsigned = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
                vec![],
                0,
                50,
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_value,
                script_public_key: pay_to_script_hash_script(&purchased_ticket_redeem),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV_A }),
            },
            TransactionOutput {
                value: PRICE as u64,
                script_public_key: p2pk_script(&seller_x),
                covenant: None,
            },
            TransactionOutput {
                value: change_value,
                script_public_key: buyer_spk.clone(),
                covenant: None,
            },
        ],
        0,
        Default::default(),
        0,
        vec![],
    );

    let ticket_entry = UtxoEntry::new(ticket_value, pay_to_script_hash_script(&hybrid_redeem), 0, false, Some(COV_A));
    let buyer_entry = UtxoEntry::new(buyer_value, buyer_spk.clone(), 0, false, None);

    let mut sigscript = compiled
        .build_sig_script_for_covenant_decl("purchase", vec![Expr::bytes(buyer_x.clone())], Default::default())
        .expect("purchase sigscript");
    sigscript.extend_from_slice(&push_redeem_script(&hybrid_redeem));

    let input0 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
        sigscript,
        0,
        50,
    );

    let mut sig1 = sign_input1(&unsigned, &[ticket_entry.clone(), buyer_entry.clone()], 1, &buyer_kp);
    sig1.extend_from_slice(&buyer_spk.script());
    let input1 = TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([2; 32]), index: 0 },
        sig1,
        0,
        50,
    );

    let tx = Transaction::new(1, vec![input0, input1], unsigned.outputs.clone(), 0, Default::default(), 0, vec![]);
    let entries = vec![ticket_entry, buyer_entry];

    let result = execute_input_with_covenants(tx, entries, 0);
    assert!(result.is_err(), "purchasing a checked-in ticket must be rejected by the VM");
}


