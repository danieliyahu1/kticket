//! kticket-silverc — thin Rust wrapper around silverscript-lang (KTK-88 A1).
//!
//! Compiles a SilverScript contract with constructor args and emits the
//! kticket artifact JSON consumed by `@kticket/kit`:
//!
//! ```json
//! {
//!   "schema": "kticket/compiled-contract/v2",
//!   "contract_name": "Event",
//!   "compiler_version": "0.1.0",
//!   "silverscript_rev": "<pinned rev>",
//!   "bytecode": [..],              // full redeem script (prefix | state | suffix)
//!   "state_layout": { "start": n, "len": n },
//!   "template_hash": [..],         // hash(prefix || suffix) — the burn-template hash concept
//!   "abi": [{ "name": .., "dispatch_tag": .., "inputs": [..] }]
//! }
//! ```
//!
//! Subcommand `sigscript` builds the spend signature script for a covenant
//! entrypoint via SilverScript's portable ABI encoder.

use std::fs;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use silverscript_abi::{
    encode_contract_covenant_decl_sig_script, ArtifactValue, SilAbiArtifact, TypeArtifact,
};
use silverscript_lang::compiler::compile_to_sil_abi_artifact;

const SILVERSCRIPT_REV: &str = "c7d17a15ac88610d013ec9ffffa9520aeb69929b";

#[derive(Debug, Parser)]
#[command(
    name = "kticket-silverc",
    about = "Compile kticket SilverScript covenants to artifacts"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Compile a contract and emit the kticket artifact JSON.
    Compile {
        /// Source SilverScript file (e.g. event.sil)
        src: PathBuf,
        /// Path to JSON constructor arguments (Vec<ArtifactValue>)
        #[arg(long = "ctor")]
        constructor_args: PathBuf,
        /// Emit pretty JSON (default)
        #[arg(long)]
        pretty: bool,
    },
    /// Build the signature script for a covenant entrypoint.
    Sigscript {
        /// Source SilverScript file (e.g. event.sil)
        src: PathBuf,
        /// Path to JSON constructor arguments (Vec<ArtifactValue>)
        #[arg(long = "ctor")]
        constructor_args: PathBuf,
        /// Policy function name (e.g. mint)
        function: String,
        /// Path to JSON call arguments (Vec<ArtifactValue>)
        #[arg(long = "args")]
        call_args: PathBuf,
        /// Is this input the covenant leader (binding=cov only)
        #[arg(long)]
        leader: bool,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn read_values(path: &PathBuf, what: &str) -> Result<Vec<ArtifactValue>, String> {
    let json = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {what} {}: {err}", path.display()))?;
    serde_json::from_str(&json)
        .map_err(|err| format!("failed to parse {what} {}: {err}", path.display()))
}

fn run() -> Result<(), String> {
    let cli = Cli::try_parse().map_err(|err| err.to_string())?;
    match cli.command {
        Command::Compile {
            src,
            constructor_args,
            pretty,
        } => {
            let source = fs::read_to_string(&src)
                .map_err(|err| format!("failed to read {}: {err}", src.display()))?;
            let ctor = read_values(&constructor_args, "constructor args")?;
            let compiled = compile_to_sil_abi_artifact(&source, &ctor)
                .map_err(|err| format!("compile error: {err}"))?;
            let artifact = to_artifact(&compiled)?;
            let json = if pretty {
                serde_json::to_string_pretty(&artifact)
                    .map_err(|err| format!("serialize: {err}"))?
            } else {
                serde_json::to_string(&artifact).map_err(|err| format!("serialize: {err}"))?
            };
            println!("{json}");
            Ok(())
        }
        Command::Sigscript {
            src,
            constructor_args,
            function,
            call_args,
            leader,
        } => {
            let source = fs::read_to_string(&src)
                .map_err(|err| format!("failed to read {}: {err}", src.display()))?;
            let ctor = read_values(&constructor_args, "constructor args")?;
            let args = read_values(&call_args, "call args")?;
            let compiled = compile_to_sil_abi_artifact(&source, &ctor)
                .map_err(|err| format!("compile error: {err}"))?;
            let contract_name = compiled
                .contracts
                .keys()
                .next()
                .ok_or_else(|| "compiled artifact has no contract".to_string())?;
            let script = encode_contract_covenant_decl_sig_script(
                &compiled,
                contract_name,
                &function,
                leader,
                &args,
            )
            .map_err(|err| format!("sigscript error: {err}"))?;
            println!("{}", faster_hex::hex_string(&script));
            Ok(())
        }
    }
}

#[derive(serde::Serialize)]
struct Artifact {
    schema: &'static str,
    contract_name: String,
    compiler_version: String,
    silverscript_rev: &'static str,
    bytecode: Vec<u8>,
    state_layout: StateLayout,
    template_hash: [u8; 32],
    abi: Vec<AbiEntry>,
}

#[derive(serde::Serialize)]
struct StateLayout {
    start: usize,
    len: usize,
}

#[derive(serde::Serialize)]
struct AbiEntry {
    name: String,
    dispatch_tag: String,
    inputs: Vec<AbiInput>,
}

#[derive(serde::Serialize)]
struct AbiInput {
    name: String,
    type_name: String,
}

fn to_artifact(compiled: &SilAbiArtifact) -> Result<Artifact, String> {
    let (contract_name, contract) = compiled
        .contracts
        .iter()
        .next()
        .ok_or_else(|| "compiled artifact has no contract".to_string())?;
    let state_layout = StateLayout {
        start: contract.compiled.state_span.offset,
        len: contract.compiled.state_span.len,
    };
    let abi = contract
        .entries
        .iter()
        .map(|(name, entry)| AbiEntry {
            name: name.clone(),
            dispatch_tag: entry.dispatch_tag.to_hex(),
            inputs: entry
                .params
                .iter()
                .map(|input| AbiInput {
                    name: input.name.clone(),
                    type_name: type_name(&input.ty),
                })
                .collect(),
        })
        .collect();
    Ok(Artifact {
        schema: "kticket/compiled-contract/v2",
        contract_name: contract_name.clone(),
        compiler_version: compiled.compiler_version.clone(),
        silverscript_rev: SILVERSCRIPT_REV,
        bytecode: contract.compiled.bytecode.clone(),
        state_layout,
        template_hash: contract.compiled.template_hash,
        abi,
    })
}

fn type_name(ty: &TypeArtifact) -> String {
    match ty {
        TypeArtifact::Int => "int".to_string(),
        TypeArtifact::Temporal => "temporal".to_string(),
        TypeArtifact::Bool => "bool".to_string(),
        TypeArtifact::Byte => "byte".to_string(),
        TypeArtifact::Bytes => "byte[]".to_string(),
        TypeArtifact::Text => "string".to_string(),
        TypeArtifact::Pubkey => "pubkey".to_string(),
        TypeArtifact::Sig => "sig".to_string(),
        TypeArtifact::Datasig => "datasig".to_string(),
        TypeArtifact::FixedBytes { len } => format!("byte[{len}]"),
        TypeArtifact::FixedArray { item, len } => format!("{}[{len}]", type_name(item)),
        TypeArtifact::DynamicArray { item } => format!("{}[]", type_name(item)),
        TypeArtifact::Struct { name } => name.clone(),
    }
}

// Keep the compiler-version constant aligned with what silverscript emits.
const _COMPILER_VERSION_ALIGN: &str = "0.1.0";
