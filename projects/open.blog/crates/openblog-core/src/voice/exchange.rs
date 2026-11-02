//! Portable export and import of the voice library (ADR 0284).
//!
//! An export is one deterministic JSON file that carries the voice sample files and the voice
//! guide exactly as they are stored, each tagged with the folder it came from (`portable` or
//! `private`). Reading one checks every sample with the same parser as a hand-edited file and
//! every guide against the provenance rule, and reports every reason it cannot be used. Pure: it
//! reads and writes no file, and no problem echoes text from the input.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{guide, VoiceSample, VoiceStage, MAX_FILE_BYTES};

/// The `format` of an export file.
pub const EXPORT_FORMAT: &str = "openblog-voice-export";
/// The export version this release writes and the newest it reads.
pub const EXPORT_VERSION: u64 = 1;
/// The largest export file read.
pub const MAX_EXPORT_BYTES: usize = 8 * 1024 * 1024;
/// The most samples one export may carry.
pub const MAX_SAMPLES: usize = 100;
/// The largest guide, in bytes (the Assistant context file limit).
pub const MAX_GUIDE_BYTES: usize = 64 * 1024;

/// One stored file in an export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    /// `portable` or `private`: the folder the file was in.
    pub visibility: String,
    /// The sample file name. Empty for the guide.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file: String,
    /// The file's text, byte for byte.
    pub content: String,
}

/// A checked export.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bundle {
    pub samples: Vec<Item>,
    pub guide: Option<Item>,
}

#[derive(Serialize, Deserialize)]
struct Wire {
    format: String,
    version: u64,
    #[serde(default)]
    samples: Vec<Item>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    guide: Option<Item>,
}

fn known_visibility(value: &str) -> bool {
    matches!(value, "portable" | "private")
}

/// The export of `samples` and `guide`, sorted by file name then folder, two-space JSON, LF line
/// ends and a final newline. The same files always give the same bytes.
pub fn export(samples: &[Item], guide: Option<&Item>) -> String {
    let mut sorted: Vec<Item> = samples.to_vec();
    sorted.sort_by(|a, b| (&a.file, &a.visibility).cmp(&(&b.file, &b.visibility)));
    let wire = Wire {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        samples: sorted,
        guide: guide.cloned().map(|mut item| {
            item.file.clear();
            item
        }),
    };
    let mut text = serde_json::to_string_pretty(&wire).expect("an export serializes");
    text.push('\n');
    text
}

/// Read an export. `Err` lists every problem; nothing partial is returned.
pub fn parse(text: &str) -> Result<Bundle, Vec<String>> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err(vec![format!(
            "The export is over {MAX_EXPORT_BYTES} bytes."
        )]);
    }
    let wire: Wire = serde_json::from_str(text).map_err(|error| {
        // Line and column only: the parser's message can quote the input.
        vec![format!(
            "The file is not a voice export (it could not be read at line {}, column {}).",
            error.line(),
            error.column()
        )]
    })?;
    if wire.format != EXPORT_FORMAT {
        return Err(vec!["The file is not an open.blog voice export.".into()]);
    }
    if wire.version > EXPORT_VERSION {
        return Err(vec![
            "This export was made by a newer release. Update open.blog, then import it; nothing was changed."
                .into(),
        ]);
    }
    if wire.version == 0 {
        return Err(vec!["The export has no valid version.".into()]);
    }
    let mut problems = Vec::new();
    if wire.samples.len() > MAX_SAMPLES {
        problems.push(format!("The export holds more than {MAX_SAMPLES} samples."));
    }
    let mut seen = BTreeSet::new();
    for (index, item) in wire.samples.iter().take(MAX_SAMPLES).enumerate() {
        let label = format!("Sample {}", index + 1);
        if let Err(message) = check_sample(item) {
            problems.push(format!("{label}: {message}"));
        } else if !seen.insert((item.visibility.clone(), item.file.clone())) {
            problems.push(format!("{label}: the same file appears twice."));
        }
    }
    if let Some(item) = &wire.guide {
        if let Err(message) = check_guide(item) {
            problems.push(format!("Guide: {message}"));
        }
    }
    if problems.is_empty() {
        Ok(Bundle {
            samples: wire.samples,
            guide: wire.guide,
        })
    } else {
        Err(problems)
    }
}

/// Whether one sample item is a valid sample whose name matches its content.
pub fn check_sample(item: &Item) -> Result<(), String> {
    if !known_visibility(&item.visibility) {
        return Err("its visibility must be `portable` or `private`.".into());
    }
    if item.content.len() > MAX_FILE_BYTES {
        return Err(format!(
            "it is larger than the {} KiB limit.",
            MAX_FILE_BYTES / 1024
        ));
    }
    let sample = VoiceSample::parse(&item.content)?;
    let name = sample.file_name()?;
    if name != item.file {
        return Err("its file name does not match the prompt, day and stage it holds.".into());
    }
    Ok(())
}

/// Whether the guide item may exist where it says: bounded text, and a guide that quotes
/// private samples is never portable.
pub fn check_guide(item: &Item) -> Result<(), String> {
    if !known_visibility(&item.visibility) {
        return Err("its visibility must be `portable` or `private`.".into());
    }
    if !item.file.is_empty() {
        return Err("a guide has no file name.".into());
    }
    if item.content.len() > MAX_GUIDE_BYTES {
        return Err(format!(
            "it is larger than the {} KiB limit.",
            MAX_GUIDE_BYTES / 1024
        ));
    }
    if item.content.contains('\0') {
        return Err("it contains a null character.".into());
    }
    if item.visibility == "portable" && guide::quotes_private_samples(&item.content) {
        return Err(
            "it quotes private samples, so it can only be private; portable context is tracked by Git."
                .into(),
        );
    }
    Ok(())
}

/// The stage of a checked sample item.
pub fn stage_of(item: &Item) -> Option<VoiceStage> {
    VoiceSample::parse(&item.content)
        .ok()
        .map(|sample| sample.voice.stage)
}

/// The rough draft a checked polished item names.
pub fn rough_of(item: &Item) -> Option<String> {
    VoiceSample::parse(&item.content)
        .ok()
        .and_then(|sample| sample.voice.rough_of)
}
