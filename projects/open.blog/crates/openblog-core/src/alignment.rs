//! Private passage alignments for comparing versions of a work (ADR 0088).
//!
//! An alignment is the author's record that places in two or more versions
//! (editions, translations, witnesses) and interpretations correspond. Each
//! member names one place: a source version and its own locators, optionally
//! a notebook passage that quotes it, or an attributed interpretation, or a
//! version that lacks the passage altogether (`absent`). Several members may
//! come from one version, and a place may belong to several alignments, so
//! splits, merges, reorderings, and omissions are all representable and no
//! one-to-one equivalence is assumed.
//!
//! An alignment says where the author reads places as corresponding, never
//! that they mean the same thing or that any version is authoritative: its
//! `correspondence` has no "equivalent" value, every alignment is attributed
//! and private, and nothing here aligns anything automatically. The original
//! wording stays in the notebook passage (quoted exactly) or the
//! interpretation; a member's `normalized` text is the author's
//! normalization, kept apart from it.
//!
//! An alignment is private until the author approves it (`visibility:
//! "approved"`), which is consent for the comparison projection (ADR 0092) to
//! publish it while the site opts in. Approval publishes nothing by itself,
//! and the projection, not this module, decides what of it is public.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

pub use crate::knowledge_atlas::Visibility;
use crate::knowledge_atlas::{
    atlas_diagnostic, check_attribution, check_evidence, item_diagnostic, open, parse_attribution,
    parse_evidence_list, parse_locator, AtlasDiagnostic, AtlasDiagnosticCode as Code, Attribution,
    Confidence, Ctx, DiagnosticSubject, Evidence, Links, Obj, MAX_LOCATORS, MAX_SHORT_CHARS,
    MAX_UNCERTAINTY_CHARS,
};
use crate::research_notes::{locator_ambiguity, Locator};
use crate::source_library::ResearchSourceKind;

/// The only alignments file version this release reads and writes.
pub const ALIGNMENTS_VERSION: u64 = 1;
pub const MAX_ALIGNMENTS_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ALIGNMENTS: usize = 20_000;
/// Upper bound on the members of one alignment.
pub const MAX_MEMBERS: usize = 32;
const MAX_NORMALIZED_CHARS: usize = 20_000;
const MAX_RATIONALE_CHARS: usize = 4_000;
const ALIGNMENTS_FIELDS: &[&str] = &["version", "alignments"];
const CREDIT_FIELDS: &[&str] = &["credit", "credits", "contributor", "contributors"];

/// What every view of an alignment should say about it.
pub const ALIGNMENT_NOTICE: &str = "An alignment records where its author reads these places as corresponding. It does not say they mean the same thing, and no version is treated as authoritative.";

/// How the aligned places correspond, in the author's reading. There is
/// deliberately no value for "equivalent" or "the same".
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Correspondence {
    /// The places correspond in the structure of the texts.
    Corresponding,
    /// The places overlap only in part.
    Partial,
    /// The places correspond, and their content differs.
    Divergent,
}

impl Correspondence {
    pub const ALL: [Self; 3] = [Self::Corresponding, Self::Partial, Self::Divergent];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "corresponding" => Some(Self::Corresponding),
            "partial" => Some(Self::Partial),
            "divergent" => Some(Self::Divergent),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Corresponding => "corresponding",
            Self::Partial => "partial",
            Self::Divergent => "divergent",
        }
    }

    /// A label that states the author's reading, never a finding.
    pub fn label(self) -> &'static str {
        match self {
            Self::Corresponding => "The author reads these places as corresponding",
            Self::Partial => "The author reads these places as corresponding in part",
            Self::Divergent => "The author reads these places as corresponding but differing",
        }
    }
}

/// The author's normalization of a member's original wording, such as
/// expanded abbreviations or modernized spelling. Stored exactly as written,
/// and never a replacement for the original.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Normalization {
    pub text: String,
    /// What was normalized, in one line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// One place in an alignment.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct AlignmentMember {
    /// The edition, translation, or witness the place is in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Where the place is in that version, independent of every other member.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<Locator>,
    /// A notebook passage quoting the place's original wording.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage: Option<String>,
    /// An attributed interpretation in the source library, aligned as it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpretation: Option<String>,
    /// The version lacks the passage: an omission, a lost leaf, or a gap.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub absent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized: Option<Normalization>,
    /// The author's one-line note on this member.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Which version a member belongs to: members of one version are its side of
/// the alignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemberVersion<'a> {
    Source(&'a str),
    Interpretation(&'a str),
}

impl AlignmentMember {
    pub fn version(&self) -> Option<MemberVersion<'_>> {
        match (&self.source, &self.interpretation) {
            (Some(source), None) => Some(MemberVersion::Source(source)),
            (None, Some(id)) => Some(MemberVersion::Interpretation(id)),
            _ => None,
        }
    }

    /// The fields that identify a member, for duplicate checks.
    fn identity(&self) -> String {
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            self.source.as_deref().unwrap_or(""),
            self.interpretation.as_deref().unwrap_or(""),
            self.passage.as_deref().unwrap_or(""),
            serde_json::to_string(&self.locators).unwrap_or_default(),
            self.absent
        )
    }
}

/// Places the author reads as corresponding across versions.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Alignment {
    /// Immutable identity, a slug unique across alignments.
    pub id: String,
    /// A short private label, such as "The cave: opening image".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub correspondence: Correspondence,
    pub members: Vec<AlignmentMember>,
    /// Why the author aligns these places.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub confidence: Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    /// Who aligns the places: the author, a source (such as a concordance),
    /// or a named person.
    #[serde(rename = "recordedBy")]
    pub recorded_by: Attribution,
    /// Sources the alignment rests on, such as an apparatus or concordance.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Evidence>,
    /// `Private` (the default), or `Approved`: the author's consent for the
    /// comparison projection to publish this alignment (ADR 0092).
    pub visibility: Visibility,
    /// The author chose to publish members' normalizations, labelled, beside
    /// original wording that is itself published. Written only when true.
    #[serde(
        rename = "publishNormalized",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub publish_normalized: bool,
    /// The fingerprint of each aligned passage's locators when the alignment
    /// was last saved approved (ADR 0125): what the author saw and approved.
    /// Additive and optional: an approval recorded before this field has none
    /// and is never withheld as stale. Cleared when the alignment is saved
    /// private.
    #[serde(
        rename = "approvedPassages",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub approved_passages: BTreeMap<String, String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A short, stable fingerprint of where a passage is located: its locators'
/// kinds, values and ends, in order. Private notes on a locator do not
/// change it.
pub fn locators_fingerprint(locators: &[Locator]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for locator in locators {
        let stated = serde_json::to_string(&(&locator.kind, &locator.value, &locator.to))
            .unwrap_or_default();
        for byte in stated.bytes().chain([0xff]) {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

impl Alignment {
    /// Record, for an approved alignment, the fingerprint of each aligned
    /// passage's locators as the notebook holds them now; clear the record
    /// for one that is not approved. Called whenever the alignment is saved,
    /// so a later change to a passage's locators is told apart from an
    /// approval that never recorded any.
    pub fn record_approval(&mut self, notebook: &crate::research_notes::Notebook) {
        self.approved_passages.clear();
        if !self.is_approved() {
            return;
        }
        for member in &self.members {
            let Some(passage) = member
                .passage
                .as_deref()
                .and_then(|id| notebook.passage(id))
            else {
                continue;
            };
            self.approved_passages
                .insert(passage.id.clone(), locators_fingerprint(&passage.locators));
        }
    }

    /// The passages whose locators changed after the approval recorded them:
    /// each aligned passage the notebook still holds, with a recorded
    /// fingerprint that no longer matches. Empty for an approval with no
    /// record (made before the record existed) and for one that is not approved.
    pub fn relocated_passages(&self, notebook: &crate::research_notes::Notebook) -> Vec<String> {
        if !self.is_approved() {
            return Vec::new();
        }
        self.members
            .iter()
            .filter_map(|member| member.passage.as_deref())
            .filter_map(|id| notebook.passage(id))
            .filter(|passage| {
                self.approved_passages
                    .get(&passage.id)
                    .is_some_and(|recorded| *recorded != locators_fingerprint(&passage.locators))
            })
            .map(|passage| passage.id.clone())
            .collect()
    }

    /// Whether the author approved the alignment for publication.
    pub fn is_approved(&self) -> bool {
        self.visibility == Visibility::Approved
    }

    /// The distinct versions the alignment relates, in member order.
    pub fn versions(&self) -> Vec<MemberVersion<'_>> {
        let mut seen = BTreeSet::new();
        self.members
            .iter()
            .filter_map(AlignmentMember::version)
            .filter(|version| seen.insert(*version))
            .collect()
    }

    /// Read one alignment from a request body with the stored rules. Whether
    /// its sources, passages, and interpretations resolve is decided when the
    /// file changes.
    pub fn from_json(raw: Value) -> Result<Self, Vec<AtlasDiagnostic>> {
        let mut diagnostics = Vec::new();
        let (_, alignment) = parse_alignment(0, raw, &mut diagnostics);
        for diagnostic in &mut diagnostics {
            diagnostic.index = None;
        }
        match alignment {
            Some(alignment) if diagnostics.is_empty() => Ok(alignment),
            _ => Err(relabel(diagnostics)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct AlignmentSet {
    pub version: u64,
    pub alignments: Vec<Alignment>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for AlignmentSet {
    fn default() -> Self {
        Self {
            version: ALIGNMENTS_VERSION,
            alignments: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

fn parse_normalization(ctx: &mut Ctx<'_>, mut obj: Obj) -> Option<Normalization> {
    obj.reject_credits(ctx);
    let text = obj.text(ctx, "text", true, MAX_NORMALIZED_CHARS, true);
    let note = obj.text(ctx, "note", false, MAX_SHORT_CHARS, false);
    Some(Normalization {
        text: text?,
        note,
        extra: obj.rest(),
    })
}

fn parse_member(ctx: &mut Ctx<'_>, path: &str, raw: Value) -> Option<AlignmentMember> {
    let Value::Object(map) = raw else {
        ctx.report(Code::InvalidField, path, "must be an object");
        return None;
    };
    let mut obj = Obj {
        path: path.into(),
        map,
    };
    obj.reject_credits(ctx);
    let has = |obj: &Obj, key: &str| obj.map.contains_key(key);
    let (named_source, named_interpretation) = (has(&obj, "source"), has(&obj, "interpretation"));
    let source = obj.id(ctx, "source", "source identifier", false);
    let interpretation = obj.id(ctx, "interpretation", "interpretation identifier", false);
    let passage = obj.id(ctx, "passage", "passage identifier", false);
    let base = obj.field("locators");
    let mut locators = Vec::new();
    for (position, raw) in obj
        .array(ctx, "locators", MAX_LOCATORS)
        .into_iter()
        .enumerate()
    {
        locators.extend(parse_locator(ctx, &format!("{base}[{position}]"), raw));
    }
    let absent = obj.flag(ctx, "absent");
    let normalized = obj
        .object(ctx, "normalized", false)
        .and_then(|normalized| parse_normalization(ctx, normalized));
    let note = obj.text(ctx, "note", false, MAX_SHORT_CHARS, false);
    let field = |key: &str| format!("{path}.{key}");
    match (named_source, named_interpretation) {
        (true, true) => ctx.report(
            Code::InvalidField,
            &field("interpretation"),
            "a member is a place in a source or an interpretation, not both",
        ),
        (false, false) => ctx.report(
            Code::MissingField,
            &field("source"),
            "name the `source` version this place is in, or an `interpretation`",
        ),
        _ => {}
    }
    if named_interpretation && !named_source {
        for (key, present) in [
            ("passage", passage.is_some()),
            ("locators", !locators.is_empty()),
            ("absent", absent),
        ] {
            if present {
                ctx.report(
                    Code::InvalidField,
                    &field(key),
                    "an interpretation already names its source and place; align it as it is",
                );
            }
        }
    }
    if absent {
        for (key, present) in [
            ("passage", passage.is_some()),
            ("locators", !locators.is_empty()),
            ("normalized", normalized.is_some()),
        ] {
            if present {
                ctx.report(
                    Code::ConflictingMember,
                    &field(key),
                    "an absent member records that this version lacks the passage, so it has no place or wording",
                );
            }
        }
    } else if named_source && !named_interpretation && passage.is_none() && locators.is_empty() {
        ctx.report(
            Code::MissingLocator,
            &field("locators"),
            "say where the passage is in this version: give locators or a notebook passage, or mark the member `absent`",
        );
    }
    if normalized.is_some() && !absent && passage.is_none() && interpretation.is_none() {
        ctx.report(
            Code::MissingOriginal,
            &field("normalized"),
            "a normalization needs the original wording it normalizes; name the notebook passage that quotes it",
        );
    }
    Some(AlignmentMember {
        source,
        locators,
        passage,
        interpretation,
        absent,
        normalized,
        note,
        extra: obj.rest(),
    })
}

/// Rules that need only the members themselves.
fn check_members(ctx: &mut Ctx<'_>, members: &[AlignmentMember]) {
    let mut identities = BTreeSet::new();
    let mut present: BTreeSet<MemberVersion<'_>> = BTreeSet::new();
    for member in members.iter().filter(|member| !member.absent) {
        present.extend(member.version());
    }
    for (position, member) in members.iter().enumerate() {
        if !identities.insert(member.identity()) {
            ctx.report(
                Code::DuplicateMember,
                &format!("members[{position}]"),
                "this place is already a member of the alignment",
            );
            continue;
        }
        if member.absent && member.version().is_some_and(|v| present.contains(&v)) {
            ctx.report(
                Code::ConflictingMember,
                &format!("members[{position}].absent"),
                "another member places the passage in this version, so it cannot also be absent from it",
            );
        }
    }
    let versions: BTreeSet<MemberVersion<'_>> = members
        .iter()
        .filter_map(AlignmentMember::version)
        .collect();
    if versions.len() < 2 || present.is_empty() {
        ctx.report(
            Code::MissingCounterpart,
            "members",
            "an alignment relates places in at least two versions or interpretations, and at least one must have the passage",
        );
    }
}

fn parse_alignment(
    index: usize,
    raw: Value,
    diagnostics: &mut Vec<AtlasDiagnostic>,
) -> (Option<String>, Option<Alignment>) {
    let Some((mut ctx, mut obj)) = open("alignments", index, raw, diagnostics) else {
        return (None, None);
    };
    let known = ctx.id.clone();
    let id = obj.id(&mut ctx, "id", "alignment identifier", true);
    obj.reject_credits(&mut ctx);
    let visibility = obj.visibility(&mut ctx);
    let publish_normalized = obj.flag(&mut ctx, "publishNormalized");
    let label = obj.text(&mut ctx, "label", false, MAX_SHORT_CHARS, false);
    let correspondence = match obj.map.remove("correspondence") {
        None => Some(Correspondence::Corresponding),
        Some(Value::String(value)) => {
            let parsed = Correspondence::parse(&value);
            if parsed.is_none() {
                ctx.report(
                    Code::InvalidField,
                    "correspondence",
                    "use corresponding, partial, or divergent; an alignment records where places correspond, never that they mean the same",
                );
            }
            parsed
        }
        Some(_) => {
            ctx.report(Code::InvalidField, "correspondence", "must be a string");
            None
        }
    };
    let mut members = Vec::new();
    for (position, raw) in obj
        .array(&mut ctx, "members", MAX_MEMBERS)
        .into_iter()
        .enumerate()
    {
        members.extend(parse_member(&mut ctx, &format!("members[{position}]"), raw));
    }
    if !ctx.failed {
        check_members(&mut ctx, &members);
    }
    let rationale = obj.text(&mut ctx, "rationale", false, MAX_RATIONALE_CHARS, true);
    let confidence = match obj.map.remove("confidence") {
        None => Some(Confidence::Tentative),
        Some(Value::String(value)) => {
            let parsed = Confidence::parse(&value);
            if parsed.is_none() {
                ctx.report(
                    Code::InvalidField,
                    "confidence",
                    "use tentative, plausible, or strong",
                );
            }
            parsed
        }
        Some(_) => {
            ctx.report(Code::InvalidField, "confidence", "must be a string");
            None
        }
    };
    let uncertainty = obj.text(&mut ctx, "uncertainty", false, MAX_UNCERTAINTY_CHARS, true);
    let recorded_by = if obj.map.contains_key("recordedBy") {
        obj.object(&mut ctx, "recordedBy", true)
            .and_then(|attribution| parse_attribution(&mut ctx, attribution))
    } else {
        Some(Attribution::author())
    };
    let evidence = parse_evidence_list(&mut ctx, &mut obj, "evidence");
    let failed = ctx.failed;
    // Read tolerantly: a record that is not an object of strings is ignored,
    // which leaves the approval as an unrecorded (never stale) one.
    let approved_passages: BTreeMap<String, String> = match obj.map.remove("approvedPassages") {
        Some(Value::Object(record)) => record
            .into_iter()
            .filter_map(|(passage, fingerprint)| match fingerprint {
                Value::String(fingerprint) => Some((passage, fingerprint)),
                _ => None,
            })
            .collect(),
        _ => BTreeMap::new(),
    };
    let extra = obj.rest();
    match (id, correspondence, confidence, recorded_by, failed) {
        (Some(id), Some(correspondence), Some(confidence), Some(recorded_by), false) => (
            Some(id.clone()),
            Some(Alignment {
                id,
                label,
                correspondence,
                members,
                rationale,
                confidence,
                uncertainty,
                recorded_by,
                evidence,
                visibility,
                publish_normalized,
                approved_passages,
                extra,
            }),
        ),
        (id, ..) => (id.or(known), None),
    }
}

impl AlignmentSet {
    /// Parse and validate a serialized alignments file against the source
    /// library and notebook it points into. Every problem is returned at once,
    /// scoped to the alignment and field; nothing is partially accepted.
    pub fn parse(text: &str, links: Links<'_>) -> Result<Self, Vec<AtlasDiagnostic>> {
        if text.len() > MAX_ALIGNMENTS_BYTES {
            return Err(vec![too_large()]);
        }
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        match serde_json::from_str(text) {
            Ok(value) => Self::read_value(value, links).map_err(relabel),
            Err(error) => Err(relabel(vec![atlas_diagnostic(
                Code::InvalidJson,
                None,
                format!("invalid JSON: {error}"),
            )])),
        }
    }

    fn read_value(value: Value, links: Links<'_>) -> Result<Self, Vec<AtlasDiagnostic>> {
        let fail = |code, field: &str, message: String| {
            Err(vec![atlas_diagnostic(code, Some(field), message)])
        };
        let Value::Object(mut root) = value else {
            return fail(
                Code::InvalidField,
                "",
                "the alignments file must be a JSON object".into(),
            );
        };
        match root.remove("version") {
            Some(Value::Number(n)) if n.as_u64() == Some(ALIGNMENTS_VERSION) => {}
            Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > ALIGNMENTS_VERSION) => {
                return fail(
                    Code::UnsupportedVersion,
                    "version",
                    format!("alignments version {n} was written by a newer open.blog; upgrade before editing so newer data is not lost"),
                );
            }
            Some(_) => {
                return fail(
                    Code::UnsupportedVersion,
                    "version",
                    format!("version must be {ALIGNMENTS_VERSION}"),
                )
            }
            None => {
                return fail(
                    Code::MissingField,
                    "version",
                    format!("add `\"version\": {ALIGNMENTS_VERSION}`"),
                )
            }
        }
        let raw = match root.remove("alignments") {
            Some(Value::Array(items)) if items.len() > MAX_ALIGNMENTS => {
                return fail(
                    Code::TooLarge,
                    "alignments",
                    format!("an alignments file may hold at most {MAX_ALIGNMENTS} alignments"),
                )
            }
            Some(Value::Array(items)) => items,
            Some(_) => {
                return fail(
                    Code::InvalidField,
                    "alignments",
                    "must be a JSON array".into(),
                )
            }
            None => Vec::new(),
        };
        let mut diagnostics = Vec::new();
        for key in root.keys().filter(|k| CREDIT_FIELDS.contains(&k.as_str())) {
            diagnostics.push(atlas_diagnostic(
                Code::ContributorCredit,
                Some(key),
                "contributor credits stay in `.credits.json` sidecars",
            ));
        }
        let mut identities = Vec::new();
        let mut alignments = Vec::new();
        for (index, raw) in raw.into_iter().enumerate() {
            let (id, alignment) = parse_alignment(index, raw, &mut diagnostics);
            identities.extend(id.map(|id| (index, id)));
            alignments.extend(alignment.map(|alignment| (index, alignment)));
        }
        check_set(&identities, &alignments, links, &mut diagnostics);
        if !diagnostics.is_empty() {
            return Err(diagnostics);
        }
        let set = Self {
            version: ALIGNMENTS_VERSION,
            alignments: alignments.into_iter().map(|(_, a)| a).collect(),
            extra: root.into_iter().collect(),
        };
        if set.to_json().len() > MAX_ALIGNMENTS_BYTES {
            return Err(vec![too_large()]);
        }
        Ok(set)
    }

    /// Canonical, deterministic text: file order, defaults written, unknown
    /// fields kept, trailing newline. Text is never normalized.
    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }

    pub fn alignment(&self, id: &str) -> Option<&Alignment> {
        self.alignments.iter().find(|a| a.id == id)
    }

    /// Alignments a source is part of, as a member, evidence, or attribution,
    /// so its removal can be refused while they use it.
    pub fn uses_of_source(&self, source: &str) -> Vec<String> {
        self.alignments
            .iter()
            .filter(|a| {
                a.members
                    .iter()
                    .any(|m| m.source.as_deref() == Some(source))
                    || a.evidence.iter().any(|e| e.source == source)
                    || a.recorded_by.source.as_deref() == Some(source)
            })
            .map(|a| a.id.clone())
            .collect()
    }

    pub fn uses_of_passage(&self, passage: &str) -> Vec<String> {
        self.alignments
            .iter()
            .filter(|a| {
                a.members
                    .iter()
                    .any(|m| m.passage.as_deref() == Some(passage))
                    || a.evidence
                        .iter()
                        .any(|e| e.passage.as_deref() == Some(passage))
            })
            .map(|a| a.id.clone())
            .collect()
    }

    pub fn uses_of_interpretation(&self, interpretation: &str) -> Vec<String> {
        self.alignments
            .iter()
            .filter(|a| {
                a.members
                    .iter()
                    .any(|m| m.interpretation.as_deref() == Some(interpretation))
            })
            .map(|a| a.id.clone())
            .collect()
    }

    /// Members whose place may need checking again: locators that no longer
    /// match the passage they name (the passage was re-located after it was
    /// aligned), and members resting on an archived source or passage. These
    /// are notices, never errors, and name ids only.
    pub fn notices(&self, links: Links<'_>) -> Vec<AtlasDiagnostic> {
        let mut notices = Vec::new();
        for (index, alignment) in self.alignments.iter().enumerate() {
            let report = |code, field: String, message: String| {
                item_diagnostic(code, "alignments", index, &alignment.id, &field, message)
            };
            let relocated = alignment.relocated_passages(links.notebook);
            for (position, member) in alignment.members.iter().enumerate() {
                let passage = member
                    .passage
                    .as_deref()
                    .and_then(|id| links.notebook.passage(id));
                if let Some(passage) = passage {
                    if relocated.contains(&passage.id) {
                        notices.push(
                            report(
                                Code::StaleApproval,
                                format!("members[{position}].passage"),
                                format!(
                                    "passage `{}` was re-located after this comparison was approved, so the approval no longer holds and the comparison is withheld; check the place, then save the alignment again to approve it as it is now",
                                    passage.id
                                ),
                            )
                            .with_facts(
                                [format!("passage {}", passage.id)]
                                    .into_iter()
                                    .chain(passage.locators.iter().map(Locator::stated)),
                            ),
                        );
                    } else if !member.locators.is_empty()
                        && !passage.locators.is_empty()
                        && member.locators != passage.locators
                    {
                        notices.push(report(
                            Code::StaleLocator,
                            format!("members[{position}].locators"),
                            format!(
                                "these locators no longer match passage `{}`, which may have been re-located since it was aligned; check the place and update one of them",
                                passage.id
                            ),
                        )
                        .with_facts(
                            member
                                .locators
                                .iter()
                                .map(Locator::stated)
                                .chain([format!("passage {}", passage.id)])
                                .chain(passage.locators.iter().map(Locator::stated)),
                        ));
                    }
                    if passage.archived {
                        notices.push(
                            report(
                                Code::ArchivedMember,
                                format!("members[{position}].passage"),
                                format!("passage `{}` is archived", passage.id),
                            )
                            .with_facts([passage.id.as_str()]),
                        );
                    }
                }
                if let Some(record) = member
                    .source
                    .as_deref()
                    .and_then(|id| links.library.get(id))
                {
                    if record.archived {
                        notices.push(
                            report(
                                Code::ArchivedMember,
                                format!("members[{position}].source"),
                                format!("source `{}` is archived", record.id),
                            )
                            .with_facts([record.id.as_str()]),
                        );
                    }
                }
            }
        }
        relabel(notices)
    }

    fn validated(candidate: &Self, links: Links<'_>) -> Result<Self, Vec<AtlasDiagnostic>> {
        let value = serde_json::to_value(candidate).map_err(|error| {
            relabel(vec![atlas_diagnostic(
                Code::InvalidJson,
                None,
                format!("the alignments could not be serialized: {error}"),
            )])
        })?;
        let reread = Self::read_value(value, links).map_err(relabel)?;
        let message = "an unknown field cannot shadow a defined field";
        let mut shadowed = Vec::new();
        for key in candidate
            .extra
            .keys()
            .filter(|k| ALIGNMENTS_FIELDS.contains(&k.as_str()))
        {
            shadowed.push(atlas_diagnostic(Code::ShadowedField, Some(key), message));
        }
        for (index, (a, b)) in candidate
            .alignments
            .iter()
            .zip(&reread.alignments)
            .enumerate()
        {
            if a != b {
                shadowed.push(item_diagnostic(
                    Code::ShadowedField,
                    "alignments",
                    index,
                    &a.id,
                    "",
                    message,
                ));
            }
        }
        if shadowed.is_empty() {
            Ok(reread)
        } else {
            Err(relabel(shadowed))
        }
    }

    /// Add an alignment or replace the one with the same id in place; the set
    /// changes only when the whole result is valid.
    ///
    /// Saving never re-approves quietly. The fingerprints a stored approval
    /// recorded are kept when an approved alignment is saved again, so an edit
    /// to its rationale does not make a place whose locators changed look
    /// checked. They are recorded afresh only for a new alignment, when the
    /// visibility changes to approved, or when the author says `reapprove`
    /// (they checked the places and approve again). A member added since is
    /// recorded as it stands; an approval cleared by saving private stays
    /// cleared.
    pub fn upsert_alignment(
        &mut self,
        alignment: Alignment,
        links: Links<'_>,
        reapprove: bool,
    ) -> Result<(), Vec<AtlasDiagnostic>> {
        let mut alignment = alignment;
        let existing = self
            .alignments
            .iter()
            .find(|a| a.id == alignment.id)
            .filter(|a| a.is_approved());
        match existing {
            Some(stored) if alignment.is_approved() && !reapprove => {
                let kept = stored.approved_passages.clone();
                alignment.record_approval(links.notebook);
                let current = std::mem::take(&mut alignment.approved_passages);
                alignment.approved_passages = current
                    .into_iter()
                    .map(|(passage, now)| {
                        let recorded = kept.get(&passage).cloned().unwrap_or(now);
                        (passage, recorded)
                    })
                    .collect();
            }
            _ => alignment.record_approval(links.notebook),
        }
        let mut candidate = self.clone();
        match candidate
            .alignments
            .iter()
            .position(|a| a.id == alignment.id)
        {
            Some(index) => candidate.alignments[index] = alignment,
            None => candidate.alignments.push(alignment),
        }
        *self = Self::validated(&candidate, links)?;
        Ok(())
    }

    /// Remove an alignment. Nothing points at one, so it is always allowed.
    pub fn remove_alignment(
        &mut self,
        id: &str,
        links: Links<'_>,
    ) -> Result<Alignment, Vec<AtlasDiagnostic>> {
        let Some(index) = self.alignments.iter().position(|a| a.id == id) else {
            return Err(vec![unknown(id)]);
        };
        let mut candidate = self.clone();
        let removed = candidate.alignments.remove(index);
        *self = Self::validated(&candidate, links)?;
        Ok(removed)
    }
}

/// Name the alignments file, not the atlas, in every message.
fn relabel(mut diagnostics: Vec<AtlasDiagnostic>) -> Vec<AtlasDiagnostic> {
    for diagnostic in &mut diagnostics {
        diagnostic.subject = DiagnosticSubject::Alignments;
    }
    diagnostics
}

fn too_large() -> AtlasDiagnostic {
    crate::knowledge_atlas::too_large(DiagnosticSubject::Alignments, MAX_ALIGNMENTS_BYTES)
}

/// An alignment id that nothing in the file uses.
pub fn unknown(id: &str) -> AtlasDiagnostic {
    AtlasDiagnostic {
        subject: DiagnosticSubject::Alignments,
        code: Code::UnknownAlignment,
        collection: Some("alignments"),
        index: None,
        id: Some(id.into()),
        field: None,
        message: format!("no alignment has the id `{id}`"),
        facts: Vec::new(),
    }
}

fn check_set(
    identities: &[(usize, String)],
    alignments: &[(usize, Alignment)],
    links: Links<'_>,
    diagnostics: &mut Vec<AtlasDiagnostic>,
) {
    let mut seen = BTreeSet::new();
    for (index, id) in identities {
        if !seen.insert(id.as_str()) {
            diagnostics.push(item_diagnostic(
                Code::DuplicateId,
                "alignments",
                *index,
                id,
                "id",
                "every alignment needs its own id",
            ));
        }
    }
    for (index, alignment) in alignments {
        let report = |code, field: &str, message: String| {
            item_diagnostic(code, "alignments", *index, &alignment.id, field, message)
        };
        check_attribution(
            &alignment.recorded_by,
            "recordedBy",
            links,
            &report,
            diagnostics,
        );
        for (position, evidence) in alignment.evidence.iter().enumerate() {
            check_evidence(
                evidence,
                &format!("evidence[{position}]"),
                links,
                &report,
                diagnostics,
            );
        }
        for (position, member) in alignment.members.iter().enumerate() {
            let path = format!("members[{position}]");
            if let Some(id) = &member.interpretation {
                if !links.library.has_interpretation(id) {
                    diagnostics.push(report(
                        Code::UnknownInterpretation,
                        &format!("{path}.interpretation"),
                        format!("no interpretation in the library has the id `{id}`"),
                    ));
                }
            }
            let Some(source) = &member.source else {
                continue;
            };
            let Some(record) = links.library.get(source) else {
                diagnostics.push(report(
                    Code::UnknownSource,
                    &format!("{path}.source"),
                    format!("no source in the library has the id `{source}`"),
                ));
                continue;
            };
            let wrong = match record.kind {
                ResearchSourceKind::Work => Some(format!(
                    "`{source}` is a work, which has no text of its own; align a place in one of its editions, translations, or witnesses"
                )),
                ResearchSourceKind::Reference => Some(format!(
                    "`{source}` is a reference; align the version it points into and give the place as locators"
                )),
                _ => None,
            };
            if let Some(message) = wrong {
                diagnostics.push(report(
                    Code::WrongSourceKind,
                    &format!("{path}.source"),
                    message,
                ));
                continue;
            }
            for (at, locator) in member.locators.iter().enumerate() {
                if let Some(message) = locator_ambiguity(Some(record.kind), source, locator) {
                    diagnostics.push(report(
                        Code::AmbiguousLocator,
                        &format!("{path}.locators[{at}].kind"),
                        message,
                    ));
                }
            }
            if let Some(id) = &member.passage {
                match links.notebook.passage(id) {
                    None => diagnostics.push(report(
                        Code::UnknownPassage,
                        &format!("{path}.passage"),
                        format!("no notebook passage has the id `{id}`"),
                    )),
                    Some(passage) if &passage.source != source => diagnostics.push(report(
                        Code::UnknownPassage,
                        &format!("{path}.passage"),
                        format!(
                            "the passage `{id}` was quoted from a different source than this member names"
                        ),
                    )),
                    Some(_) => {}
                }
            }
        }
    }
}

/// Whether a parsed JSON object has the shape of an alignments file, judged
/// by structure only, so a copy saved into a public folder can be refused.
pub fn looks_like_alignments(root: &Map<String, Value>) -> bool {
    if root.get("version").and_then(Value::as_u64).is_none() {
        return false;
    }
    let Some(alignments) = root.get("alignments").and_then(Value::as_array) else {
        return false;
    };
    let member_like = |member: &Value| {
        member.get("source").is_some_and(Value::is_string)
            || member.get("interpretation").is_some_and(Value::is_string)
    };
    let alignment_like = |item: &Value| {
        item.get("id").is_some_and(Value::is_string)
            && item
                .get("members")
                .and_then(Value::as_array)
                .is_some_and(|members| !members.is_empty() && members.iter().all(member_like))
    };
    !alignments.is_empty() && alignments.iter().all(alignment_like)
}
