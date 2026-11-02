//! Contracts for publishing capabilities attached to rendered Markdown.

pub const MAX_CAPABILITY_ID_LENGTH: usize = 64;
pub const MAX_DIAGNOSTIC_MESSAGE_LENGTH: usize = 240;
pub const MAX_CAPABILITY_DIAGNOSTICS: usize = 8;

/// Capabilities the portable projection renders with their own static fallback.
const PORTABLE_FALLBACKS: &[&str] = &[
    "knowledge-check",
    "runnable-code",
    "web-sandbox",
    "interactive-demo",
    "before-after",
    "comments",
    "raw-html",
    "citations",
    "claim-evidence",
    "guided-reading-supplements",
];

/// Planned capabilities registered in `docs/portability/planned-capability-contracts.json`,
/// with the label a portable copy shows until the owning story ships a fallback.
/// A capability the registry marks `implemented` has its own fallback in
/// [`PORTABLE_FALLBACKS`] and is not listed here.
/// `None` marks private state that has no public representation at all.
const PLANNED_CAPABILITIES: &[(&str, Option<&str>)] = &[
    (
        "edition-translation-comparisons",
        Some("Edition and translation comparison"),
    ),
    ("historical-timelines", Some("Timeline")),
    (
        "research-workspace-publication-boundary",
        Some("Research context"),
    ),
    ("citation-source-previews", Some("Source previews")),
    ("knowledge-relationships", Some("Knowledge relationships")),
    ("curated-reading-paths", Some("Reading path")),
    (
        "passage-questions-and-corrections",
        Some("Questions and corrections"),
    ),
    ("local-reader-annotations", None),
    ("scholarly-interpretations", Some("Interpretations")),
    ("shared-source-led-reflections", Some("Shared reflections")),
    ("protected-reflection-drafts", None),
    ("third-perspectives", Some("Third Perspectives")),
    ("diagrams", Some("Diagram")),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortabilityLevel {
    FullyPortable,
    GracefullyTransformed,
    CanonicalOnlyInteraction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityDiagnosticCode {
    UnknownCapability,
    MalformedIdentifier,
    MalformedContent,
    /// The portable projection removed, unwrapped, replaced, renamed, or
    /// repaired authored markup.
    RemovedMarkup,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDiagnostic {
    pub code: CapabilityDiagnosticCode,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptor {
    /// Stable, product-owned identifier. Invalid identifiers use `"invalid"`.
    pub id: String,
    /// Meaning authored by the writer; the source content remains canonical.
    pub authored_semantics: &'static str,
    /// Renderer used for the native open.blog presentation, when available.
    pub native_renderer: Option<&'static str>,
    /// Renderer for a useful static representation where one is defined.
    pub fallback_renderer: Option<&'static str>,
    pub portability: PortabilityLevel,
    /// Diagnostics are scoped to this capability occurrence.
    pub diagnostics: Vec<CapabilityDiagnostic>,
}

impl CapabilityDescriptor {
    /// Describe a capability without changing or consuming its authored Markdown.
    pub fn describe(identifier: &str, native_renderer: Option<&'static str>) -> Self {
        if !valid_identifier(identifier) {
            let mut descriptor = Self {
                id: "invalid".into(),
                authored_semantics: "Unrecognized authored capability.",
                native_renderer: None,
                fallback_renderer: Some("untransformed-markdown"),
                portability: PortabilityLevel::CanonicalOnlyInteraction,
                diagnostics: Vec::new(),
            };
            descriptor.add_diagnostic(
                CapabilityDiagnosticCode::MalformedIdentifier,
                "Malformed capability identifier; authored Markdown is left unchanged.",
            );
            return descriptor;
        }

        let (semantics, fallback_renderer, portability) = match identifier {
            "knowledge-check" => (
                "A question with answer choices and an author-designated correct answer.",
                Some("static-question-and-choices"),
                PortabilityLevel::GracefullyTransformed,
            ),
            "runnable-code" => (
                "Source code with an explicit reader execution affordance.",
                Some("pre-code"),
                PortabilityLevel::GracefullyTransformed,
            ),
            "web-sandbox" => (
                "An HTML, CSS, and JavaScript exercise with an isolated preview.",
                Some("source-code"),
                PortabilityLevel::GracefullyTransformed,
            ),
            "interactive-demo" => (
                "A live demonstration the reader operates, with an authored description of it.",
                Some("authored-fallback"),
                PortabilityLevel::GracefullyTransformed,
            ),
            "before-after" => (
                "Two pictures of the same thing, one before and one after, each with a description and an optional caption.",
                Some("figure-pair"),
                PortabilityLevel::FullyPortable,
            ),
            "comments" => (
                "Reader discussion hosted with the canonical article.",
                Some("canonical-link"),
                PortabilityLevel::CanonicalOnlyInteraction,
            ),
            "raw-html" => (
                "Markup the author wrote as raw HTML or Markdown attributes.",
                Some("allowlisted-html"),
                PortabilityLevel::GracefullyTransformed,
            ),
            "citations" => (
                "Citations of saved references, published as numbered notes or a bibliography.",
                Some("markdown-footnotes"),
                PortabilityLevel::FullyPortable,
            ),
            "claim-evidence" => (
                "The author's approved claims with their supporting and contradicting evidence side by side, and revision notes.",
                Some("markdown-section"),
                PortabilityLevel::FullyPortable,
            ),
            "guided-reading-supplements" => (
                "Author-approved supplements, each labelled with its kind and the least reading mode that shows it; a mode only hides or shows them.",
                Some("labeled-static-group"),
                PortabilityLevel::FullyPortable,
            ),
            planned if matches!(planned_entry(planned), Some(Some(_))) => (
                "A planned capability: its authored content stays visible and the canonical article carries the rest.",
                Some("labeled-canonical-link"),
                PortabilityLevel::CanonicalOnlyInteraction,
            ),
            private if planned_entry(private) == Some(None) => (
                "Private state with no public representation.",
                None,
                PortabilityLevel::CanonicalOnlyInteraction,
            ),
            _ => {
                let mut descriptor = Self {
                    id: identifier.to_string(),
                    authored_semantics: "Unrecognized authored capability.",
                    native_renderer: None,
                    fallback_renderer: Some("untransformed-markdown"),
                    portability: PortabilityLevel::CanonicalOnlyInteraction,
                    diagnostics: Vec::new(),
                };
                descriptor.add_diagnostic(
                    CapabilityDiagnosticCode::UnknownCapability,
                    "Unknown capability; preserve its authored content unchanged.",
                );
                return descriptor;
            }
        };

        Self {
            id: identifier.to_string(),
            authored_semantics: semantics,
            native_renderer,
            fallback_renderer,
            portability,
            diagnostics: Vec::new(),
        }
    }

    /// Whether the portable projection renders this capability's own fallback.
    pub fn has_portable_fallback(&self) -> bool {
        PORTABLE_FALLBACKS.contains(&self.id.as_str())
    }

    /// How a portable copy without this capability's own fallback names it next
    /// to the canonical link: the planned capability's label, a generic label for
    /// unknown or invalid capabilities, and `None` for private state, which adds
    /// nothing to public output.
    pub fn portable_label(&self) -> Option<&'static str> {
        planned_entry(&self.id).unwrap_or(Some("Interactive content"))
    }

    pub fn add_diagnostic(&mut self, code: CapabilityDiagnosticCode, message: &str) {
        if self.diagnostics.len() == MAX_CAPABILITY_DIAGNOSTICS {
            return;
        }
        self.diagnostics.push(CapabilityDiagnostic {
            code,
            message: bounded_message(message),
        });
    }
}

fn planned_entry(identifier: &str) -> Option<Option<&'static str>> {
    PLANNED_CAPABILITIES
        .iter()
        .find(|(id, _)| *id == identifier)
        .map(|(_, label)| *label)
}

fn bounded_message(message: &str) -> String {
    let end = message
        .char_indices()
        .take_while(|(index, character)| {
            index + character.len_utf8() <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    message[..end].to_string()
}

fn valid_identifier(identifier: &str) -> bool {
    let bytes = identifier.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_CAPABILITY_ID_LENGTH
        && bytes[0].is_ascii_lowercase()
        && bytes[bytes.len() - 1] != b'-'
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_capabilities_have_semantics_and_fallbacks() {
        let descriptor = CapabilityDescriptor::describe("knowledge-check", Some("ob-quiz"));
        assert_eq!(descriptor.id, "knowledge-check");
        assert!(descriptor.authored_semantics.contains("answer choices"));
        assert_eq!(descriptor.native_renderer, Some("ob-quiz"));
        assert_eq!(
            descriptor.fallback_renderer,
            Some("static-question-and-choices")
        );
        assert_eq!(
            descriptor.portability,
            PortabilityLevel::GracefullyTransformed
        );
        assert!(descriptor.diagnostics.is_empty());
    }

    #[test]
    fn comments_are_a_canonical_only_interaction() {
        let descriptor = CapabilityDescriptor::describe("comments", Some("ob-comments"));
        assert_eq!(
            descriptor.portability,
            PortabilityLevel::CanonicalOnlyInteraction
        );
        assert_eq!(descriptor.fallback_renderer, Some("canonical-link"));
        assert!(descriptor.diagnostics.is_empty());
    }

    #[test]
    fn planned_capabilities_follow_the_contract_registry_and_fail_closed() {
        let registry: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/portability/planned-capability-contracts.json"
        ))
        .unwrap();
        let implemented = |contract: &serde_json::Value| {
            contract["implementation_status"].as_str() == Some("implemented")
        };
        let ids = registry["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|contract| !implemented(contract))
            .map(|contract| contract["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            PLANNED_CAPABILITIES
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>(),
            ids
        );
        // An implemented capability names the fallback it ships, and the
        // descriptor agrees; it has no canonical-only label to fall back to.
        for contract in registry["contracts"].as_array().unwrap() {
            if !implemented(contract) {
                continue;
            }
            let id = contract["id"].as_str().unwrap();
            let descriptor = CapabilityDescriptor::describe(id, None);
            assert!(PORTABLE_FALLBACKS.contains(&id), "{id}");
            assert!(descriptor.has_portable_fallback(), "{id}");
            assert!(descriptor.diagnostics.is_empty(), "{id}");
            assert_eq!(
                descriptor.fallback_renderer,
                contract["implemented_fallback"].as_str(),
                "{id}"
            );
            // Whatever level it ships at, it is not left as an interaction
            // that only the canonical page can carry.
            assert_ne!(
                descriptor.portability,
                PortabilityLevel::CanonicalOnlyInteraction,
                "{id}"
            );
        }
        for id in ids {
            let descriptor = CapabilityDescriptor::describe(id, None);
            assert_eq!(descriptor.id, id);
            assert!(descriptor.diagnostics.is_empty(), "{id}");
            assert!(!descriptor.has_portable_fallback(), "{id}");
            assert_eq!(
                descriptor.portability,
                PortabilityLevel::CanonicalOnlyInteraction,
                "{id}"
            );
            assert_eq!(
                descriptor.fallback_renderer,
                descriptor
                    .portable_label()
                    .map(|_| "labeled-canonical-link"),
                "{id}"
            );
        }
        for private in ["local-reader-annotations", "protected-reflection-drafts"] {
            assert_eq!(
                CapabilityDescriptor::describe(private, None).portable_label(),
                None
            );
        }
        assert_eq!(
            CapabilityDescriptor::describe("historical-timelines", None).portable_label(),
            Some("Timeline")
        );
        assert_eq!(
            CapabilityDescriptor::describe("future-capability", None).portable_label(),
            Some("Interactive content")
        );
        assert!(CapabilityDescriptor::describe("comments", None).has_portable_fallback());
    }

    #[test]
    fn unknown_capabilities_are_bounded_and_preserve_their_identifier() {
        let descriptor = CapabilityDescriptor::describe("future-capability", None);
        assert_eq!(descriptor.id, "future-capability");
        assert_eq!(
            descriptor.diagnostics[0].code,
            CapabilityDiagnosticCode::UnknownCapability
        );
        assert!(descriptor.diagnostics[0].message.len() <= MAX_DIAGNOSTIC_MESSAGE_LENGTH);
        assert_eq!(descriptor.fallback_renderer, Some("untransformed-markdown"));
    }

    #[test]
    fn malformed_identifiers_get_a_bounded_diagnostic() {
        let descriptor = CapabilityDescriptor::describe(&"x".repeat(128), None);
        assert_eq!(descriptor.id, "invalid");
        assert_eq!(
            descriptor.diagnostics[0].code,
            CapabilityDiagnosticCode::MalformedIdentifier
        );
        assert_eq!(descriptor.diagnostics.len(), 1);
    }

    #[test]
    fn malformed_content_diagnostics_do_not_include_unbounded_source_text() {
        let mut descriptor = CapabilityDescriptor::describe("knowledge-check", Some("ob-quiz"));
        descriptor.add_diagnostic(
            CapabilityDiagnosticCode::MalformedContent,
            &"x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH * 2),
        );
        assert_eq!(
            descriptor.diagnostics[0].message.len(),
            MAX_DIAGNOSTIC_MESSAGE_LENGTH
        );
    }

    #[test]
    fn diagnostics_are_bounded_by_bytes_for_multibyte_messages() {
        let mut descriptor = CapabilityDescriptor::describe("knowledge-check", Some("ob-quiz"));
        descriptor.add_diagnostic(
            CapabilityDiagnosticCode::MalformedContent,
            &"é".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH),
        );
        assert!(descriptor.diagnostics[0].message.len() <= MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    }

    #[test]
    fn diagnostic_count_and_message_length_are_bounded() {
        let mut descriptor = CapabilityDescriptor::describe("knowledge-check", Some("ob-quiz"));
        let long_message = "x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH + 50);
        for _ in 0..MAX_CAPABILITY_DIAGNOSTICS + 1 {
            descriptor.add_diagnostic(CapabilityDiagnosticCode::MalformedContent, &long_message);
        }
        assert_eq!(descriptor.diagnostics.len(), MAX_CAPABILITY_DIAGNOSTICS);
        assert!(descriptor
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.message.len() == MAX_DIAGNOSTIC_MESSAGE_LENGTH));
    }
}
