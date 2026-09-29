//! Build tool behind scripts/build-setup.mjs. Uses the installer's own `payload` module, so the
//! archive is written by the same tar/zstd code that will read it.
//!
//! ```text
//! payload-pack pack   --out payload.tar.zst [--level 19] [--threads N] [--skip resources/README.md]
//!                     <name>=<path> ...
//! payload-pack bundle --stub scip-installer.exe --payload payload.tar.zst --out SCIP-Setup-x.exe
//! ```

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use scip_installer_lib::payload::{self, PackEntry, PackOptions};

fn usage() -> ExitCode {
    eprintln!(
        "usage: payload-pack pack --out <file> [--level N] [--threads N] [--skip name]... <name>=<path>..."
    );
    eprintln!("       payload-pack bundle --stub <exe> --payload <file> --out <exe>");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else { return usage() };
    let mut named: Vec<(String, String)> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut iter = args[1..].iter();
    while let Some(arg) = iter.next() {
        match arg.strip_prefix("--") {
            Some(flag) => match iter.next() {
                Some(value) => named.push((flag.to_string(), value.clone())),
                None => return usage(),
            },
            None => positional.push(arg.clone()),
        }
    }
    let get = |flag: &str| named.iter().rev().find(|(k, _)| k == flag).map(|(_, v)| v.clone());
    let result = match command.as_str() {
        "pack" => pack(&named, &positional, get("out"), get("level"), get("threads")),
        "bundle" => match (get("stub"), get("payload"), get("out")) {
            (Some(stub), Some(payload_file), Some(out)) => payload::bundle(
                &PathBuf::from(stub),
                &PathBuf::from(payload_file),
                &PathBuf::from(&out),
            )
            .map(|footer| {
                println!("{out}: installer {} bytes + payload {} bytes + footer", footer.offset, footer.len);
            }),
            _ => return usage(),
        },
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("payload-pack: {e}");
            ExitCode::FAILURE
        }
    }
}

fn pack(
    named: &[(String, String)],
    positional: &[String],
    out: Option<String>,
    level: Option<String>,
    threads: Option<String>,
) -> std::io::Result<()> {
    let invalid = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, m.to_string());
    let out = out.ok_or_else(|| invalid("--out is required"))?;
    let entries: Vec<PackEntry> = positional
        .iter()
        .map(|spec| {
            let (name, source) = spec.split_once('=').ok_or_else(|| invalid("entries are <name>=<path>"))?;
            Ok(PackEntry { name: name.to_string(), source: PathBuf::from(source) })
        })
        .collect::<std::io::Result<_>>()?;
    if entries.is_empty() {
        return Err(invalid("nothing to pack"));
    }
    let default_threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let options = PackOptions {
        level: level.map(|l| l.parse()).transpose().map_err(|_| invalid("bad --level"))?.unwrap_or(19),
        threads: threads
            .map(|t| t.parse())
            .transpose()
            .map_err(|_| invalid("bad --threads"))?
            .unwrap_or(default_threads),
        skip: named.iter().filter(|(k, _)| k == "skip").map(|(_, v)| v.clone()).collect(),
    };
    let started = Instant::now();
    let mut count = 0u64;
    let files = payload::pack(BufWriter::new(File::create(&out)?), &entries, &options, |name| {
        count += 1;
        if count % 2000 == 0 {
            println!("  {count} files… ({name})");
        }
    })?;
    let size = std::fs::metadata(&out)?.len();
    println!(
        "{out}: {files} files, {:.1} MB, level {} × {} threads, {:.0} s",
        size as f64 / 1_048_576.0,
        options.level,
        options.threads,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
