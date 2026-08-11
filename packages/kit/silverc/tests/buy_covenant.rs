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

    compile_contract_file(
        "event",
        vec![
            Expr::bytes(authorizing_txid),
            Expr::int(PRICE),
            Expr::dynamic_bytes([vec![0x00, 0x00], org_spk.clone()].concat()), // version-prefixed spk
            Expr::bytes(template_hash),
            Expr::dynamic_bytes(prefix),
            Expr::dynamic_bytes(suffix),
        ],
    )
}

/// Inject the event state into the bytecode's state slot (owner, id=0,
/// amount, is_minter=false) — the same 46-byte push-encoded layout the kit's
/// `encodeState` produces.
fn inject_state(compiled: &CompiledContract, owner: Vec<u8>, amount: i64) -> Vec<u8> {
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
    assert_eq!(state.len(), layout.len, "encoded state must fill the state slot");

    let mut bytecode = compiled.bytecode.clone();
    bytecode.splice(layout.start..layout.start + layout.len, state.iter().cloned());
    bytecode
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


