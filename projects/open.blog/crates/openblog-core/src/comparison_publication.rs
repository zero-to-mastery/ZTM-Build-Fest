//! Published passage comparisons: the one projection of approved alignments
//! that every public representation reads (ADR 0092).
//!
//! [`PublicComparisons`] is built from an explicit allowlist. It copies only
//! alignments the author approved, and from them only the fields named here:
//! each version's identification (its public reference, kind, language and
//! makers), each interpretation's kind and interpreters, every place's
//! locators, and the original wording of a place only when the author states
//! the version's text may be displayed and the wording is a brief excerpt.
//! A version whose rights are unknown or reserved is identified and located,
//! never quoted. Private notes on places, rights notes, notebook passage ids,
//! unknown fields, unapproved alignments and normalizations the author did
//! not choose to publish have no place in these types.
//!
//! Nothing here decides what is permitted: a rights status is the author's
//! own statement (ADR 0085), and the gate only follows it. Nothing here says
//! two places mean the same thing: every comparison carries the author's
//! reading of how its places correspond and the alignment notice. Text is
//! copied exactly as stored, never normalized, with its language tag and a
//! base direction derived from it.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::alignment::{
    Alignment, AlignmentMember, AlignmentSet, Correspondence, ALIGNMENT_NOTICE,
};
use crate::atlas_publication::{
    public_evidence, public_party, PublicEvidence, PublicParty, PublicSource,
};
use crate::citations::{format_reference, public_reference, PublicLocator};
use crate::contributor::Contributor;
use crate::interpretation::{Interpretation, InterpretationKind, InterpreterIdentity};
use crate::knowledge_atlas::Confidence;
use crate::research_notes::Notebook;
use crate::source_library::{AttributionCertainty, RightsDeclaration, RightsStatus, SourceLibrary};

/// Names the public artifact. It has no `version` key, so it is never
/// mistaken for the private alignments file.
pub const PUBLIC_COMPARISONS_FORMAT: &str = "openblog-comparison-projection";
/// The only public comparison format version this release writes.
pub const PUBLIC_COMPARISONS_FORMAT_VERSION: u64 = 1;
/// Where the comparison pages live on the site.
pub const COMPARISONS_URL: &str = "/comparisons/";
/// The first path segment the pages reserve while the site publishes them.
pub const COMPARISONS_SEGMENT: &str = "comparisons";
/// The JSON artifact, relative to the site root.
pub const COMPARISONS_JSON_FILE: &str = "comparisons.json";
/// The longest wording one place may publish, in characters. Longer wording
/// is identified and located but not quoted, so a comparison never
/// republishes a long stretch of a stored text.
pub const MAX_PUBLIC_EXCERPT_CHARS: usize = 1_000;

/// Whether the author's rights statement lets a version's wording be shown.
/// `unknown` and `rightsReserved` never do. This follows the author's own
/// declaration; it is not a judgement that any use is lawful.
pub fn displays_wording(status: RightsStatus) -> bool {
    matches!(
        status,
        RightsStatus::Permission
            | RightsStatus::OpenLicense
            | RightsStatus::PublicDomain
            | RightsStatus::OwnWork
    )
}

/// The published comparisons and the public description of every source
/// they identify, cite or attribute to.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicComparisons {
    pub format: &'static str,
    pub format_version: u64,
    /// What every view of a comparison says: correspondence, never equivalence.
    pub notice: &'static str,
    /// Sorted by id.
    pub comparisons: Vec<PublicComparison>,
    /// Sorted by id.
    pub sources: Vec<PublicSource>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicComparison {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The comparison's page, root-relative.
    pub url: String,
    pub correspondence: Correspondence,
    /// The author's reading in words, never a finding.
    pub correspondence_label: &'static str,
    pub recorded_by: PublicParty,
    pub confidence: Confidence,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<PublicEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    /// Each version or interpretation, in the order the author first placed it.
    pub versions: Vec<PublicVersion>,
}

/// What a column of the comparison is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionKind {
    /// An edition, translation, or witness: its `source` is the version.
    Source,
    /// An attributed interpretation of a place in `source`.
    Interpretation,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicVersion {
    pub kind: VersionKind,
    /// The version itself, or for an interpretation the source interpreted.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpretation: Option<PublicInterpretation>,
    /// For a source version, its makers as the author attributes them, with
    /// how firmly each is tied to it (ADR 0086). The attribution note stays
    /// private. An interpretation's makers are its interpreters.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub makers: Vec<PublicMaker>,
    /// For a source version, that the author records it as anonymous.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub anonymous: bool,
    /// The author's statement of the rights in this version's text.
    pub rights: PublicRights,
    pub places: Vec<PublicPlace>,
}

/// An interpretation's attribution, kept apart from the primary text.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicInterpretation {
    pub id: String,
    pub kind: InterpretationKind,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub interpreters: Vec<PublicInterpreter>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub anonymous: bool,
}

/// One maker of a source version: an editor, translator, scribe or author.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicMaker {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionCertainty>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicInterpreter {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionCertainty>,
}

/// The status and its label, and an open licence's name. The author's note
/// on why they believe it stays private.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicRights {
    pub status: RightsStatus,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// Why a place's wording is not published.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Withheld {
    /// The author has not stated that the version's text may be displayed.
    Rights,
    /// The wording is longer than [`MAX_PUBLIC_EXCERPT_CHARS`].
    Length,
}

/// One place: where it is, and its wording only when the gate allows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicPlace {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
    /// The version lacks the passage.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub absent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<PublicText>,
    /// Set when the place has wording that is not published, and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withheld: Option<Withheld>,
    /// The author's normalization, only when they chose to publish it and the
    /// original wording is published too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized: Option<PublicNormalization>,
    /// The member's position in the alignment, for the Admin preview only.
    #[serde(skip)]
    pub member: usize,
}

/// Wording exactly as stored, with its language and base direction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicText {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// `ltr`, `rtl`, or `auto` when the language does not say.
    pub dir: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicNormalization {
    #[serde(flatten)]
    pub text: PublicText,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The canonical page of a comparison. Alignment ids are lowercase slugs,
/// so they are safe path segments as they are.
pub fn comparison_url(id: &str) -> String {
    format!("{COMPARISONS_URL}{id}/")
}

const RTL_LANGUAGES: &[&str] = &[
    "acm", "aeb", "ajp", "apc", "ar", "arc", "ary", "arz", "azb", "bal", "ckb", "dv", "fa", "glk",
    "hbo", "he", "iw", "ji", "jpr", "jrb", "ks", "lrc", "mzn", "nqo", "ota", "phn", "pnb", "prs",
    "ps", "sam", "sd", "syc", "syr", "ug", "ur", "yi",
];
const RTL_SCRIPTS: &[&str] = &[
    "adlm", "arab", "aran", "armi", "avst", "chrs", "cprt", "elym", "hatr", "hebr", "hung", "khar",
    "lydi", "mand", "mani", "mend", "merc", "mero", "narb", "nbat", "nkoo", "ougr", "palm", "phli",
    "phlp", "phnx", "prti", "rohg", "samr", "sarb", "sogd", "sogo", "syrc", "thaa", "yezi",
];
const LTR_SCRIPTS: &[&str] = &[
    "ahom", "armn", "bali", "bamu", "batk", "beng", "bopo", "brah", "brai", "bugi", "buhd", "cakm",
    "cans", "cari", "cham", "cher", "copt", "cyrl", "cyrs", "deva", "dogr", "dsrt", "dupl", "egyp",
    "ethi", "geok", "geor", "glag", "gong", "gonm", "goth", "gran", "grek", "gujr", "guru", "hang",
    "hani", "hano", "hans", "hant", "hira", "hmng", "hrkt", "ital", "java", "jpan", "kali", "kana",
    "kawi", "khmr", "khoj", "knda", "kore", "kthi", "lana", "laoo", "latf", "latg", "latn", "lepc",
    "limb", "lina", "linb", "lisu", "lyci", "mahj", "maka", "marc", "medf", "mlym", "modi", "mong",
    "mroo", "mtei", "mult", "mymr", "nagm", "nand", "newa", "nshu", "ogam", "olck", "orkh", "orya",
    "osge", "osma", "perm", "phag", "plrd", "runr", "saur", "sgnw", "shaw", "shrd", "sidd", "sind",
    "sinh", "sora", "soyo", "sund", "sylo", "tagb", "takr", "tale", "talu", "taml", "tang", "tavt",
    "telu", "tfng", "tglg", "thai", "tibt", "tirh", "toto", "ugar", "vaii", "vith", "wara", "wcho",
    "xpeo", "xsux", "yiii", "zanb",
];

/// A language tag safe to write in a `lang` attribute, or `None`.
pub fn language_tag(value: &str) -> Option<&str> {
    let tag = value.trim();
    let mut parts = tag.split('-');
    let first = parts.next()?;
    let ok = (2..=8).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_alphabetic())
        && tag.split('-').count() <= 8
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    ok.then_some(tag)
}

/// The base direction for text in a language: a script subtag decides first,
/// then the language. No usable tag, or a script this list does not know,
/// gives `auto`, so a reader's browser decides from the text itself instead
/// of assuming left to right. The Admin workspace uses the same lists.
pub fn text_direction(language: Option<&str>) -> &'static str {
    let Some(tag) = language.and_then(language_tag) else {
        return "auto";
    };
    let tag = tag.to_ascii_lowercase();
    let mut parts = tag.split('-');
    let base = parts.next().unwrap_or_default();
    if let Some(script) =
        parts.find(|part| part.len() == 4 && part.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        return if RTL_SCRIPTS.contains(&script) {
            "rtl"
        } else if LTR_SCRIPTS.contains(&script) {
            "ltr"
        } else {
            "auto"
        };
    }
    if RTL_LANGUAGES.contains(&base) {
        "rtl"
    } else {
        "ltr"
    }
}

fn public_text(text: &str, language: Option<&str>) -> PublicText {
    let language = language.and_then(language_tag).map(str::to_string);
    PublicText {
        text: text.to_string(),
        dir: text_direction(language.as_deref()),
        language,
    }
}

fn public_rights(declared: Option<&RightsDeclaration>, status: RightsStatus) -> PublicRights {
    PublicRights {
        status,
        label: status.label(),
        license: declared
            .filter(|_| status == RightsStatus::OpenLicense)
            .and_then(|rights| rights.license.clone()),
    }
}

/// What the sources the projection reads hold.
#[derive(Clone, Copy)]
pub struct ComparisonInputs<'a> {
    pub library: &'a SourceLibrary,
    pub notebook: &'a Notebook,
    pub contributors: &'a BTreeMap<String, Contributor>,
}

/// Approved alignments whose approval has gone stale (#63, ADR 0125): a
/// passage the alignment names was re-located after the alignment was last
/// saved approved, which the alignments file records as a fingerprint of the
/// passage's locators. Each is withheld from the projection, and only it,
/// until the author checks the place and saves the alignment again. An
/// approval with no record (made before the record existed) is never
/// withheld. By alignment id, the field and the validator's own sentence,
/// naming ids only.
pub fn stale_approvals(
    set: &AlignmentSet,
    inputs: ComparisonInputs<'_>,
) -> BTreeMap<String, String> {
    let links = crate::knowledge_atlas::Links {
        library: inputs.library,
        notebook: inputs.notebook,
    };
    let mut stale = BTreeMap::new();
    for notice in set.notices(links) {
        if notice.code != crate::knowledge_atlas::AtlasDiagnosticCode::StaleApproval {
            continue;
        }
        let Some(id) = notice.id.clone() else {
            continue;
        };
        if !set.alignments.iter().any(|a| a.id == id && a.is_approved()) {
            continue;
        }
        stale.entry(id).or_insert_with(|| {
            format!(
                "{}: {}",
                notice.field.as_deref().unwrap_or("members"),
                notice.message
            )
        });
    }
    stale
}

impl PublicComparisons {
    /// Project the approved alignments of a validated alignments file. The
    /// library and notebook supply identification and wording; the
    /// contributor registry supplies interpreters' public names. An approved
    /// alignment whose approval went stale ([`stale_approvals`]) is left out.
    /// Fails, naming ids only, if an approved alignment points at something
    /// the inputs do not hold.
    pub fn project(set: &AlignmentSet, inputs: ComparisonInputs<'_>) -> Result<Self, String> {
        let stale = stale_approvals(set, inputs);
        let mut comparisons = Vec::new();
        for alignment in set
            .alignments
            .iter()
            .filter(|a| a.is_approved() && !stale.contains_key(&a.id))
        {
            comparisons.push(PublicComparison::project(alignment, inputs)?);
        }
        comparisons.sort_by(|a, b| a.id.cmp(&b.id));
        let mut used: BTreeMap<String, String> = BTreeMap::new();
        for comparison in &comparisons {
            for source in comparison.sources() {
                used.entry(source.to_string())
                    .or_insert_with(|| comparison.id.clone());
            }
        }
        let mut sources = Vec::with_capacity(used.len());
        for (id, user) in used {
            let Some(record) = inputs.library.get(&id) else {
                return Err(format!(
                    "the comparison `{user}` uses the source `{id}`, which is not in the source library"
                ));
            };
            let reference = public_reference(record);
            let text = format_reference(&reference);
            sources.push(PublicSource { reference, text });
        }
        Ok(Self {
            format: PUBLIC_COMPARISONS_FORMAT,
            format_version: PUBLIC_COMPARISONS_FORMAT_VERSION,
            notice: ALIGNMENT_NOTICE,
            comparisons,
            sources,
        })
    }

    pub fn source(&self, id: &str) -> Option<&PublicSource> {
        self.sources
            .binary_search_by(|source| source.reference.key.as_str().cmp(id))
            .ok()
            .map(|index| &self.sources[index])
    }

    /// The artifact as compact, deterministic JSON with root-relative URLs.
    /// `<`, `>` and `&` are written as escapes, so authored text can never
    /// close a `<script>` element the data is later embedded in.
    pub fn to_json(&self) -> String {
        let json = serde_json::to_string(self).expect("the public comparisons are serializable");
        let mut out = String::with_capacity(json.len());
        for c in json.chars() {
            match c {
                '<' | '>' | '&' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
                _ => out.push(c),
            }
        }
        out
    }

    /// A version's title as readers see it: the source's title, or its id.
    pub fn title_of(&self, source: &str) -> String {
        self.source(source)
            .and_then(|source| source.reference.title.clone())
            .unwrap_or_else(|| source.to_string())
    }

    /// Who recorded a comparison: the site author's name, a source's
    /// reference, or the named person.
    pub fn party_text(&self, party: &PublicParty, author: &str) -> String {
        match party.kind {
            crate::knowledge_atlas::AttributionKind::Author => {
                let author = author.trim();
                if author.is_empty() {
                    "The site author".to_string()
                } else {
                    format!("{author} (the site author)")
                }
            }
            crate::knowledge_atlas::AttributionKind::Source => {
                let id = party.source.as_deref().unwrap_or_default();
                self.source(id)
                    .map(|source| source.text.clone())
                    .unwrap_or_else(|| id.to_string())
            }
            crate::knowledge_atlas::AttributionKind::Named => {
                party.name.clone().unwrap_or_default()
            }
        }
    }

    /// One piece of evidence as readers see it: the reference, then where.
    pub fn evidence_text(&self, evidence: &PublicEvidence) -> String {
        let reference = self
            .source(&evidence.source)
            .map(|source| source.text.clone())
            .unwrap_or_else(|| evidence.source.clone());
        if evidence.locators.is_empty() {
            reference
        } else {
            format!(
                "{reference}, {}",
                crate::bibliography::CitationLocale::En.locators_text(&evidence.locators)
            )
        }
    }
}

impl PublicComparison {
    /// What one alignment would publish, approved or not. The build projects
    /// only approved alignments; Admin uses this to show the author, before
    /// approving, which places would be quoted and which only identified.
    pub fn project(alignment: &Alignment, inputs: ComparisonInputs<'_>) -> Result<Self, String> {
        let mut versions: Vec<PublicVersion> = Vec::new();
        let mut keys: Vec<(VersionKind, String)> = Vec::new();
        for (position, member) in alignment.members.iter().enumerate() {
            let (key, version, place) = public_member(alignment, position, member, inputs)?;
            match keys.iter().position(|known| *known == key) {
                Some(index) => versions[index].places.push(place),
                None => {
                    let mut version = version;
                    version.places.push(place);
                    keys.push(key);
                    versions.push(version);
                }
            }
        }
        Ok(Self {
            id: alignment.id.clone(),
            label: alignment.label.clone(),
            url: comparison_url(&alignment.id),
            correspondence: alignment.correspondence,
            correspondence_label: alignment.correspondence.label(),
            recorded_by: public_party(&alignment.recorded_by),
            confidence: alignment.confidence,
            evidence: public_evidence(&alignment.evidence),
            rationale: alignment.rationale.clone(),
            uncertainty: alignment.uncertainty.clone(),
            versions,
        })
    }

    /// Every source the comparison identifies, cites or attributes to.
    pub fn sources(&self) -> BTreeSet<&str> {
        let mut used: BTreeSet<&str> = self.versions.iter().map(|v| v.source.as_str()).collect();
        used.extend(self.evidence.iter().map(|e| e.source.as_str()));
        used.extend(self.recorded_by.source.as_deref());
        used
    }

    /// The places in member order, for the Admin preview.
    pub fn places_in_member_order(&self) -> Vec<&PublicPlace> {
        let mut places: Vec<&PublicPlace> =
            self.versions.iter().flat_map(|v| v.places.iter()).collect();
        places.sort_by_key(|place| place.member);
        places
    }
}

/// The wording gate: published only under a rights statement that permits
/// display and within the excerpt limit.
fn gate(
    text: &str,
    language: Option<&str>,
    rights: RightsStatus,
) -> (Option<PublicText>, Option<Withheld>) {
    if !displays_wording(rights) {
        (None, Some(Withheld::Rights))
    } else if text.chars().count() > MAX_PUBLIC_EXCERPT_CHARS {
        (None, Some(Withheld::Length))
    } else {
        (Some(public_text(text, language)), None)
    }
}

fn normalization(
    alignment: &Alignment,
    member: &AlignmentMember,
    shown: bool,
    language: Option<&str>,
) -> Option<PublicNormalization> {
    let normalized = member.normalized.as_ref()?;
    (alignment.publish_normalized
        && shown
        && normalized.text.chars().count() <= MAX_PUBLIC_EXCERPT_CHARS)
        .then(|| PublicNormalization {
            text: public_text(&normalized.text, language),
            note: normalized.note.clone(),
        })
}

type Member = ((VersionKind, String), PublicVersion, PublicPlace);

fn public_member(
    alignment: &Alignment,
    position: usize,
    member: &AlignmentMember,
    inputs: ComparisonInputs<'_>,
) -> Result<Member, String> {
    let missing = |what: &str, id: &str| {
        format!(
            "the comparison `{}` uses the {what} `{id}`, which is not stored",
            alignment.id
        )
    };
    if let Some(id) = &member.interpretation {
        let interpretation = inputs
            .library
            .interpretation(id)
            .ok_or_else(|| missing("interpretation", id))?;
        let rights = interpretation.rights_status();
        let (text, withheld) = gate(
            &interpretation.text,
            interpretation.language.as_deref(),
            rights,
        );
        let normalized = normalization(
            alignment,
            member,
            text.is_some(),
            interpretation.language.as_deref(),
        );
        let version = PublicVersion {
            kind: VersionKind::Interpretation,
            source: interpretation.source.clone(),
            interpretation: Some(public_interpretation(interpretation, inputs.contributors)),
            makers: Vec::new(),
            anonymous: false,
            rights: public_rights(interpretation.rights.as_ref(), rights),
            places: Vec::new(),
        };
        let place = PublicPlace {
            locators: interpretation
                .locators
                .iter()
                .map(PublicLocator::from)
                .collect(),
            absent: false,
            text,
            withheld,
            normalized,
            member: position,
        };
        return Ok(((VersionKind::Interpretation, id.clone()), version, place));
    }
    let source = member
        .source
        .as_deref()
        .ok_or_else(|| missing("place", &position.to_string()))?;
    let record = inputs
        .library
        .get(source)
        .ok_or_else(|| missing("source", source))?;
    let rights = record.rights_status().ok_or_else(|| {
        format!(
            "the comparison `{}` places a passage in `{source}`, which is not an edition, translation or witness",
            alignment.id
        )
    })?;
    let passage = match &member.passage {
        Some(id) => Some(
            inputs
                .notebook
                .passage(id)
                .filter(|passage| passage.source == source)
                .ok_or_else(|| missing("passage", id))?,
        ),
        None => None,
    };
    let locators = if member.locators.is_empty() {
        passage.map(|p| p.locators.as_slice()).unwrap_or_default()
    } else {
        member.locators.as_slice()
    };
    let language = passage
        .and_then(|p| p.excerpt.language.as_deref())
        .or(record.language.as_deref());
    let (text, withheld) = match passage {
        Some(passage) if !member.absent => gate(&passage.excerpt.text, language, rights),
        _ => (None, None),
    };
    let normalized = normalization(alignment, member, text.is_some(), language);
    let version = PublicVersion {
        kind: VersionKind::Source,
        source: source.to_string(),
        interpretation: None,
        makers: record
            .creators
            .iter()
            .map(|creator| PublicMaker {
                name: creator.name.clone(),
                role: creator.role.clone(),
                attribution: creator.attribution,
            })
            .collect(),
        anonymous: record.anonymous,
        rights: public_rights(record.rights.as_ref(), rights),
        places: Vec::new(),
    };
    let place = PublicPlace {
        locators: locators.iter().map(PublicLocator::from).collect(),
        absent: member.absent,
        text,
        withheld,
        normalized,
        member: position,
    };
    Ok(((VersionKind::Source, source.to_string()), version, place))
}

fn public_interpretation(
    interpretation: &Interpretation,
    contributors: &BTreeMap<String, Contributor>,
) -> PublicInterpretation {
    PublicInterpretation {
        id: interpretation.id.clone(),
        kind: interpretation.kind,
        interpreters: interpretation
            .interpreters
            .iter()
            .map(|interpreter| PublicInterpreter {
                name: match interpreter.identity() {
                    InterpreterIdentity::Contributor(key) => contributors
                        .get(key)
                        .map_or_else(|| key.to_string(), |c| c.name.clone()),
                    InterpreterIdentity::Named(name) => name.to_string(),
                },
                attribution: interpreter.attribution,
            })
            .collect(),
        anonymous: interpretation.anonymous,
    }
}

/// How a withheld place reads.
pub fn withheld_text(withheld: Withheld, rights: &PublicRights) -> String {
    match withheld {
        Withheld::Rights if rights.status == RightsStatus::Unknown => {
            "Wording not shown: the author has not stated the rights in this version's text, so this page gives only where the passage is.".to_string()
        }
        Withheld::Rights => {
            "Wording not shown: the author states this version's text is under copyright, so this page gives only where the passage is.".to_string()
        }
        Withheld::Length => format!(
            "Wording not shown: it is longer than the {MAX_PUBLIC_EXCERPT_CHARS}-character excerpt a comparison publishes."
        ),
    }
}

/// A name with how firmly the author ties it to the text, the way an
/// interpretation's heading and a version's makers both read.
pub fn attributed_name(name: &str, attribution: Option<AttributionCertainty>) -> String {
    match attribution {
        Some(certainty) => format!("{name} ({})", certainty.as_str()),
        None => name.to_string(),
    }
}

/// An interpretation's heading: what it is and who made it.
pub fn interpretation_heading(interpretation: &PublicInterpretation) -> String {
    let kind = match interpretation.kind {
        InterpretationKind::Rendering => "Rendering",
        InterpretationKind::Reading => "Reading",
    };
    if interpretation.interpreters.is_empty() {
        format!("{kind}, anonymous")
    } else {
        let names: Vec<String> = interpretation
            .interpreters
            .iter()
            .map(|i| attributed_name(&i.name, i.attribution))
            .collect();
        format!("{kind} by {}", names.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_follows_script_then_language_and_unknown_scripts_are_auto() {
        assert_eq!(text_direction(Some("he")), "rtl");
        assert_eq!(text_direction(Some("hbo-Hebr")), "rtl");
        assert_eq!(text_direction(Some("arc-Latn")), "ltr");
        assert_eq!(text_direction(Some("und-Sogd")), "rtl");
        assert_eq!(text_direction(Some("xx-Zzzz")), "auto");
        assert_eq!(text_direction(Some("grc")), "ltr");
        assert_eq!(text_direction(Some("")), "auto");
        assert_eq!(text_direction(None), "auto");
        assert_eq!(text_direction(Some("bad tag")), "auto");
    }

    #[test]
    fn only_statements_that_permit_display_show_wording() {
        assert!(!displays_wording(RightsStatus::Unknown));
        assert!(!displays_wording(RightsStatus::RightsReserved));
        for status in [
            RightsStatus::Permission,
            RightsStatus::OpenLicense,
            RightsStatus::PublicDomain,
            RightsStatus::OwnWork,
        ] {
            assert!(displays_wording(status));
        }
    }
}
