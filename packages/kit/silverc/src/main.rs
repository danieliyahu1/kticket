//! kticket-silverc — thin Rust wrapper around silverscript-lang (KTK-88 A1).
//!
//! Compiles a SilverScript contract with constructor args and emits the
//! kticket artifact JSON consumed by `@kticket/kit`:
//!
//! ```json
//! {
//!   "schema": "kticket/compiled-contract/v1",
//!   "contract_name": "Event",
//!   "compiler_version": "0.1.0",
//!   "silverscript_rev": "<pinned rev>",
//!   "bytecode": [..],              // full redeem script (prefix | state | suffix)
//!   "state_layout": { "start": n, "len": n },
//!   "template_hash": [..],         // hash(prefix || suffix) — the burn-template hash concept
//!   "without_selector": bool,
//!   "abi": [{ "name": .., "inputs": [{ "name": .., "type_name": .. }] }]
//! }
//! ```
//!
//! Subcommand `sigscript` builds the spend signature script for a covenant
//! entrypoint via `build_sig_script_for_covenant_decl`.

use std::fs;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{CompileOptions, CovenantDeclCallOptions, CompiledContract, compile_contract};

const SILVERSCRIPT_REV: &str = "80d715f70099baa4ef2fb4fd582597e1d8d06fa0";

#[derive(Debug, Parser)]
#[command(name = "kticket-silverc", about = "Compile kticket SilverScript covenants to artifacts")]
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
        /// Path to JSON constructor arguments (Vec<Expr>)
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
        /// Path to JSON constructor arguments (Vec<Expr>)
        #[arg(long = "ctor")]
        constructor_args: PathBuf,
        /// Policy function name (e.g. mint)
        function: String,
        /// Path to JSON call arguments (Vec<Expr>)
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

fn read_exprs(path: &PathBuf, what: &str) -> Result<Vec<Expr<'static>>, String> {
    let json = fs::read_to_string(path).map_err(|err| format!("failed to read {what} {}: {err}", path.display()))?;
    serde_json::from_str::<Vec<Expr<'static>>>(&json).map_err(|err| format!("failed to parse {what} {}: {err}", path.display()))
}

fn run() -> Result<(), String> {
    let cli = Cli::try_parse().map_err(|err| err.to_string())?;
    match cli.command {
        Command::Compile { src, constructor_args, pretty } => {
            let source = fs::read_to_string(&src).map_err(|err| format!("failed to read {}: {err}", src.display()))?;
            let ctor = read_exprs(&constructor_args, "constructor args")?;
            let compiled = compile_contract(&source, &ctor, CompileOptions::default()).map_err(|err| format!("compile error: {err}"))?;
            let artifact = to_artifact(&compiled)?;
            let json = if pretty {
                serde_json::to_string_pretty(&artifact).map_err(|err| format!("serialize: {err}"))?
            } else {
                serde_json::to_string(&artifact).map_err(|err| format!("serialize: {err}"))?
            };
            println!("{json}");
            Ok(())
        }
        Command::Sigscript { src, constructor_args, function, call_args, leader } => {
            let source = fs::read_to_string(&src).map_err(|err| format!("failed to read {}: {err}", src.display()))?;
            let ctor = read_exprs(&constructor_args, "constructor args")?;
            let args = read_exprs(&call_args, "call args")?;
            let compiled = compile_contract(&source, &ctor, CompileOptions::default()).map_err(|err| format!("compile error: {err}"))?;
            let script = compiled
                .build_sig_script_for_covenant_decl(&function, args, CovenantDeclCallOptions { is_leader: leader })
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
    without_selector: bool,
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
    inputs: Vec<AbiInput>,
}

#[derive(serde::Serialize)]
struct AbiInput {
    name: String,
    type_name: String,
}

fn to_artifact(compiled: &CompiledContract<'_>) -> Result<Artifact, String> {
    let state_layout = StateLayout { start: compiled.state_layout.start, len: compiled.state_layout.len };
    let template_hash = compiled.template_hash();
    let abi = compiled
        .abi
        .iter()
        .map(|entry| AbiEntry {
            name: entry.name.clone(),
            inputs: entry.inputs.iter().map(|input| AbiInput { name: input.name.clone(), type_name: input.type_name.clone() }).collect(),
        })
        .collect();
    Ok(Artifact {
        schema: "kticket/compiled-contract/v1",
        contract_name: compiled.contract_name.clone(),
        compiler_version: compiled.compiler_version.clone(),
        silverscript_rev: SILVERSCRIPT_REV,
        bytecode: compiled.bytecode.clone(),
        state_layout,
        template_hash,
        without_selector: compiled.without_selector,
        abi,
    })
}

// Keep the compiler-version constant aligned with what silverscript emits.
const _COMPILER_VERSION_ALIGN: &str = "0.1.0";
