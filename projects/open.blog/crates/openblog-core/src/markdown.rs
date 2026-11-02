//! Markdown rendering on top of pulldown-cmark, plus the derived data a blog
//! wants from a post body: headings for a table of contents, plain text for
//! excerpts and search, and an estimated reading time.

use pulldown_cmark::{
    BlockQuoteKind, CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};

use std::collections::BTreeMap;

use crate::capability::{CapabilityDescriptor, CapabilityDiagnosticCode};
use crate::escape;
use crate::recipe::{self, Section};
use crate::slug::slugify;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Heading {
    /// 1 through 6.
    pub level: u8,
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rendered {
    pub html: String,
    /// Image destinations retained by the portable raw-HTML boundary, in source order.
    pub portable_images: Vec<crate::portability::PortableImage>,
    pub portable_has_raw_html: bool,
    /// YouTube identities detected from source paragraphs with portable embed fallbacks.
    pub portable_video_ids: Vec<String>,
    /// Semantic capabilities detected in authored Markdown, in source order.
    pub capabilities: Vec<CapabilityDescriptor>,
    /// Content errors discovered by Markdown extensions such as quiz blocks.
    pub errors: Vec<String>,
    pub headings: Vec<Heading>,
    /// Body text with markup removed; code blocks are excluded.
    pub text: String,
    /// The post's own prose: [`Rendered::text`] without the generated
    /// citation notes region. Descriptions, word counts and reading time
    /// come from it; search keeps the full text.
    pub prose: String,
    /// Words of [`Rendered::prose`].
    pub word_count: usize,
    /// Languages of fenced code blocks, in order of first appearance.
    pub code_languages: Vec<String>,
    /// First image URL in the body, if any. Used as a fallback cover.
    pub first_image: Option<String>,
    /// With [`RenderOptions::recipe`]: the text of each ingredient and step,
    /// and the id of the first recipe heading (for a "Jump to recipe" link).
    pub recipe_ingredients: Vec<String>,
    pub recipe_steps: Vec<String>,
    pub recipe_anchor: Option<String>,
    /// With [`RenderOptions::supplements`]: the supplements read and what was
    /// reported about their markers.
    pub reading_depth: Option<crate::reading_depth::ReadingDepth>,
    /// Every `atlas:` link or image the renderer refused to show as a link
    /// (ADR 0173), whatever its form, for the build to warn about. Its
    /// destination, title and id never reach the HTML.
    pub concept_refusals: Vec<crate::concept_links::Refusal>,
}

#[derive(Clone, Copy, Debug)]
pub struct CodeRunnerRenderOptions<'a> {
    pub endpoint: &'a str,
    pub languages: &'a [String],
}

#[derive(Clone, Copy, Debug)]
pub struct RenderOptions<'a> {
    /// Convert straight quotes and dashes to typographic ones.
    pub smart_punctuation: bool,
    /// Add `loading="lazy"` to images.
    pub lazy_images: bool,
    /// Wrap headings in anchor links so they can be shared.
    pub heading_anchors: bool,
    /// Turn a link that stands alone in its paragraph (to CodePen, for now)
    /// into an embedded frame. See [`crate::embed`].
    pub embeds: bool,
    /// Treat "Ingredients" and "Steps" sections as a recipe (see [`crate::recipe`]).
    pub recipe: bool,
    /// Public browser runner configuration; no credentials are accepted here.
    pub code_runner: Option<CodeRunnerRenderOptions<'a>>,
    /// Site-hosted libraries `web runnable` fences may name with `libs=`.
    pub web_libraries: Option<&'a BTreeMap<String, Vec<String>>>,
    /// Offer "Open in Rust Playground" beside Rust examples. A fence's `playgroundLink=` overrides it.
    pub playground_link: bool,
    /// Set for a post whose citations were published as notes: the native
    /// page gives those generated notes accessible citation anchors and links
    /// back to each citation. `None` renders every footnote as before.
    pub citation_notes: Option<crate::bibliography::CitationNoteLabels<'a>>,
    /// Set for a post whose publication Markdown carries a claim evidence
    /// section (ADR 0075): its prose (description, word count, reading time)
    /// ends at that section's heading, as it ends at generated citation notes.
    pub claim_evidence_section: bool,
    /// Set for a post that opts in to reading modes (ADR 0140): marked
    /// supplements are wrapped in labelled groups and kept out of the post's
    /// own prose. `false` renders every block quote as before.
    pub supplements: bool,
    /// Set for a post (ADR 0172): a link to `atlas:<entry id>` is marked so
    /// the build can resolve it against the public atlas. `false` renders
    /// every such link as the ordinary link it is written as.
    pub concept_links: bool,
}

impl Default for RenderOptions<'_> {
    fn default() -> Self {
        Self {
            smart_punctuation: false,
            lazy_images: true,
            heading_anchors: true,
            embeds: true,
            recipe: false,
            code_runner: None,
            web_libraries: None,
            playground_link: true,
            citation_notes: None,
            claim_evidence_section: false,
            supplements: false,
            concept_links: false,
        }
    }
}

/// What [`render_portable`] adds to [`RenderOptions`]: the canonical article that
/// static fallbacks point readers to, and public post metadata they may use.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PortableContext<'a> {
    pub canonical_url: &'a str,
    /// Set for video posts: timestamp lines become a chapter list.
    pub chapters: bool,
    /// The post's YouTube video, so chapters can link to their moment.
    pub video_id: Option<&'a str>,
}

/// Options written after a fence's language, in the style other site
/// generators use: ```` ```rust title="src/main.rs" {2,4-6} showLineNumbers=10 ````.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FenceInfo {
    pub(crate) lang: String,
    pub(crate) title: Option<String>,
    /// `runnable`: let readers edit and run this Rust example.
    pub(crate) runnable: bool,
    /// `playgroundLink=false`: omit the external Playground fallback link.
    pub(crate) playground_link: Option<bool>,
    /// `showLineNumbers` / `showLineNumbers=false`.
    line_numbers: Option<bool>,
    /// `showLineNumbers=10` starts counting at 10.
    line_start: Option<u32>,
    /// `{2,4-6}`: lines to highlight, validated to digits, commas and dashes.
    highlight: Option<String>,
    /// `module`: run a web sandbox's JavaScript as an ES module.
    module: bool,
    /// `network`: let a web sandbox reach HTTPS APIs.
    network: bool,
    /// `images`: let a web sandbox load HTTPS images.
    images: bool,
    /// `libs=react,vue`: site-hosted libraries to inline into a web sandbox.
    libs: Vec<String>,
    /// The kind named after `demo`, as in ```` ```demo git-sandbox ````.
    pub(crate) demo: Option<String>,
    /// `lesson="first-workflow"`: which scripted lesson a `git-practice` demo runs.
    pub(crate) demo_lesson: Option<String>,
    /// `check` on a `rust runnable` fence: the body continues after a `---checks` line with
    /// hidden `#[test]` functions that the "Check my code" button runs against the reader's code.
    pub(crate) check: bool,
}

/// The marker that ends a `rust runnable check` fence's starter code.
const RUST_CHECKS_MARKER: &str = "---checks";
/// The starter and its checks together must fit the Playground request budget.
const MAX_RUST_CHECK_BYTES: usize = 40_000;
/// What a copy of a `rust runnable check` fence says about the checks it cannot run.
pub(crate) const RUST_CHECKS_SPOILER: &str = "Spoiler: the checks for this challenge";
pub(crate) const RUST_CHECKS_SPOILER_NOTE: &str = "These tests run when you press Check my code on the original article. Reading them first gives away the answer.";

/// Split a `rust runnable check` body into the starter code the reader sees and the hidden
/// checks that follow the `---checks` line. Without the marker there are no checks.
pub(crate) fn split_rust_checks(source: &str) -> (&str, Option<&str>) {
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if line.trim() == RUST_CHECKS_MARKER {
            return (&source[..offset], Some(&source[offset + line.len()..]));
        }
        offset += line.len();
    }
    (source, None)
}

/// What is wrong with a `rust runnable check` body, if anything.
fn rust_check_error(starter: &str, checks: Option<&str>) -> Option<&'static str> {
    let Some(checks) = checks else {
        return Some("a `rust runnable check` fence needs a `---checks` line followed by hidden `#[test]` functions");
    };
    if starter.trim().is_empty() {
        return Some(
            "a `rust runnable check` fence needs starter code before the `---checks` line",
        );
    }
    if !checks.contains("#[test]") {
        return Some("the `---checks` section of a `rust runnable check` fence needs at least one `#[test]` function");
    }
    if starter.len() + checks.len() > MAX_RUST_CHECK_BYTES {
        return Some("a `rust runnable check` fence's starter and checks must stay under 40,000 bytes together");
    }
    None
}

pub(crate) fn parse_fence_info(info: &str) -> FenceInfo {
    let mut out = FenceInfo::default();
    let mut rest = info.trim();
    let mut first = true;
    while !rest.is_empty() {
        if let Some(body) = rest.strip_prefix('{') {
            let end = body.find('}').unwrap_or(body.len());
            let ranges: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
            if !ranges.is_empty()
                && ranges
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == ',' || c == '-')
            {
                out.highlight = Some(ranges);
            }
            rest = body.get(end + 1..).unwrap_or("").trim_start();
            first = false;
            continue;
        }
        if let Some(value) = rest.strip_prefix("title=") {
            let (title, after) = match value.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let inner = &value[1..];
                    let end = inner.find(q).unwrap_or(inner.len());
                    (&inner[..end], inner.get(end + 1..).unwrap_or(""))
                }
                _ => {
                    let end = value.find(char::is_whitespace).unwrap_or(value.len());
                    (&value[..end], &value[end..])
                }
            };
            if !title.trim().is_empty() {
                out.title = Some(title.trim().to_string());
            }
            rest = after.trim_start();
            first = false;
            continue;
        }
        if let Some(value) = rest.strip_prefix("libs=") {
            // Library names are comma-separated, so read up to the next space.
            let end = value.find(char::is_whitespace).unwrap_or(value.len());
            out.libs = value[..end]
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
                .filter(|name| !name.is_empty())
                .collect();
            rest = value[end..].trim_start();
            first = false;
            continue;
        }
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '{' || c == ',')
            .unwrap_or(rest.len());
        let word = &rest[..end];
        rest = rest[end..].trim_start_matches(',').trim_start();
        if let Some(flag) = word.strip_prefix("showLineNumbers") {
            match flag.strip_prefix('=').map(str::trim) {
                None | Some("true") => out.line_numbers = Some(true),
                Some("false") => out.line_numbers = Some(false),
                Some(n) => {
                    if let Ok(n) = n.parse::<u32>() {
                        out.line_numbers = Some(true);
                        out.line_start = Some(n);
                    }
                }
            }
        } else if word == "runnable" {
            out.runnable = true;
        } else if word == "check" {
            out.check = true;
        } else if word == "module" {
            out.module = true;
        } else if word == "network" {
            out.network = true;
        } else if word == "images" {
            out.images = true;
        } else if let Some(value) = word.strip_prefix("lesson=") {
            let id = value.trim_matches(|c| c == '"' || c == '\'');
            if !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                out.demo_lesson = Some(id.to_string());
            }
        } else if let Some(value) = word.strip_prefix("playgroundLink=") {
            out.playground_link = match value {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            };
        } else if first && !word.is_empty() {
            out.lang = word.to_string();
        } else if out.lang == "demo" && out.demo.is_none() && !word.is_empty() {
            out.demo = Some(word.to_string());
        }
        first = false;
    }
    out
}

pub(crate) fn capability_source_ranges(
    markdown: &str,
) -> Vec<(String, crate::portability::SourceRange)> {
    let mut starts = vec![0];
    starts.extend(markdown.match_indices('\n').map(|(offset, _)| offset + 1));
    let position = |offset: usize| {
        let line = starts.partition_point(|start| *start <= offset);
        let column = markdown[starts[line - 1]..offset]
            .trim_end_matches('\r')
            .chars()
            .count()
            + 1;
        (line, column)
    };
    Parser::new_ext(markdown, parser_options(false))
        .into_offset_iter()
        .filter_map(|(event, range)| {
            let Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) = event else {
                return None;
            };
            let fence = parse_fence_info(&info);
            let id = if info.trim() == "quiz" {
                "knowledge-check"
            } else if info.trim() == crate::compare::FENCE {
                crate::compare::CAPABILITY_ID
            } else if fence.lang == "demo" {
                "interactive-demo"
            } else if fence.runnable && fence.lang.eq_ignore_ascii_case("web") {
                "web-sandbox"
            } else if fence.runnable {
                "runnable-code"
            } else {
                return None;
            };
            let (start_line, start_column) = position(range.start);
            let (end_line, end_column) = position(range.end);
            Some((
                id.into(),
                crate::portability::SourceRange {
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                },
            ))
        })
        .collect()
}

fn valid_web_sandbox_source(source: &str) -> bool {
    source.len() <= 100_000
        && source
            .lines()
            .any(|line| matches!(line.trim(), "---html" | "---css" | "---js"))
        && source
            .lines()
            .skip_while(|line| !matches!(line.trim(), "---html" | "---css" | "---js"))
            .skip(1)
            .any(|line| {
                !line.trim().is_empty() && !matches!(line.trim(), "---html" | "---css" | "---js")
            })
}

fn callout_label(kind: BlockQuoteKind) -> (&'static str, &'static str) {
    match kind {
        BlockQuoteKind::Note => ("note", "Note"),
        BlockQuoteKind::Tip => ("tip", "Tip"),
        BlockQuoteKind::Important => ("important", "Important"),
        BlockQuoteKind::Warning => ("warning", "Warning"),
        BlockQuoteKind::Caution => ("caution", "Caution"),
    }
}

/// What [`transform_blocks`] found besides the new events.
#[derive(Default)]
struct BlockData {
    capabilities: Vec<CapabilityDescriptor>,
    ingredients: Vec<String>,
    steps: Vec<String>,
    recipe_anchor: Option<String>,
    errors: Vec<String>,
}

struct QuizChoice {
    text: String,
    correct: bool,
}

struct QuizQuestion {
    prompt: String,
    choices: Vec<QuizChoice>,
    explanation: Option<String>,
    key: String,
}

fn quiz_inline(source: &str) -> Result<String, String> {
    let parser = Parser::new_ext(source, Options::ENABLE_STRIKETHROUGH);
    let events: Vec<_> = parser.collect();
    if events.iter().any(|event| {
        !matches!(
            event,
            Event::Start(Tag::Paragraph | Tag::Emphasis | Tag::Strong | Tag::Strikethrough)
                | Event::End(
                    TagEnd::Paragraph | TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough
                )
                | Event::Text(_)
                | Event::Code(_)
                | Event::SoftBreak
                | Event::HardBreak
        )
    }) {
        return Err("quiz text supports only emphasis, strikethrough, and inline code".into());
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    let html = html.trim();
    Ok(html
        .strip_prefix("<p>")
        .and_then(|s| s.strip_suffix("</p>"))
        .unwrap_or(html)
        .to_string())
}

/// The HTML writer percent-encodes `[` and `]` in an address, which breaks the
/// host of an IPv6 literal (`http://%5B2001:db8::1%5D/` names no host).
/// Write the brackets of an address's authority back, and nothing else.
fn restore_bracketed_hosts(html: String) -> String {
    const MARKER: &str = "://%5B";
    if !html.contains(MARKER) && !html.contains("://%5b") {
        return html;
    }
    let mut out = String::with_capacity(html.len());
    let mut rest = html.as_str();
    while let Some(at) = rest
        .find("://%5")
        .filter(|&at| matches!(rest.as_bytes().get(at + 5..at + 6), Some(b"B" | b"b")))
    {
        let authority = at + 3;
        let end = rest[authority..]
            .find(['/', '?', '#', '"', '\'', '<', ' '])
            .map_or(rest.len(), |end| authority + end);
        out.push_str(&rest[..authority]);
        let span = &rest[authority..end];
        out.push_str(
            &span
                .replace("%5B", "[")
                .replace("%5b", "[")
                .replace("%5D", "]")
                .replace("%5d", "]"),
        );
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn quiz_key(source: &str) -> String {
    // Stable FNV-1a: deliberately small and sufficient for namespacing local UI state.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in source.trim().replace("\r\n", "\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn parse_quiz(source: &str) -> Result<QuizQuestion, String> {
    let mut lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let prompt = lines.next().ok_or("quiz needs a question prompt")?;
    if prompt.starts_with("- [") || prompt.starts_with('>') {
        return Err("quiz needs a question prompt before its choices".into());
    }
    let mut choices = Vec::new();
    let mut explanation = Vec::new();
    let mut in_explanation = false;
    for line in lines {
        if let Some(rest) = line.strip_prefix("> ").or_else(|| line.strip_prefix('>')) {
            if !explanation.is_empty() {
                return Err("quiz explanation must fit on one blockquote line".into());
            }
            in_explanation = true;
            explanation.push(rest.trim());
            continue;
        }
        if in_explanation {
            return Err(format!(
                "quiz has an unexpected line after its explanation: `{line}`"
            ));
        }
        let (correct, text) = if let Some(text) = line.strip_prefix("- [ ] ") {
            (false, text)
        } else if let Some(text) = line
            .strip_prefix("- [x] ")
            .or_else(|| line.strip_prefix("- [X] "))
        {
            (true, text)
        } else {
            return Err(format!("quiz has an unexpected line: `{line}`"));
        };
        if text.trim().is_empty() {
            return Err("quiz choices cannot be empty".into());
        }
        choices.push(QuizChoice {
            text: text.trim().to_string(),
            correct,
        });
    }
    if !(2..=4).contains(&choices.len()) {
        return Err("quiz needs between two and four choices".into());
    }
    if choices.iter().filter(|choice| choice.correct).count() != 1 {
        return Err("quiz needs exactly one correct choice".into());
    }
    // Validate the supported inline subset here so rendering cannot partially succeed.
    quiz_inline(prompt)?;
    for choice in &choices {
        quiz_inline(&choice.text)?;
    }
    if !explanation.is_empty() {
        quiz_inline(&explanation.join(" "))?;
    }
    let mut normalized = collapse_whitespace(prompt);
    for choice in &choices {
        normalized.push_str(if choice.correct { "\n[x] " } else { "\n[ ] " });
        normalized.push_str(&collapse_whitespace(&choice.text));
    }
    if !explanation.is_empty() {
        normalized.push_str("\n> ");
        normalized.push_str(&collapse_whitespace(&explanation.join(" ")));
    }
    Ok(QuizQuestion {
        prompt: prompt.to_string(),
        choices,
        explanation: (!explanation.is_empty()).then(|| explanation.join(" ")),
        key: quiz_key(&normalized),
    })
}

fn render_quiz(
    source: &str,
    seen: &mut std::collections::HashMap<String, usize>,
) -> Result<String, String> {
    let quiz = parse_quiz(source)?;
    let prompt = quiz_inline(&quiz.prompt)?;
    let occurrence = seen.entry(quiz.key.clone()).or_default();
    *occurrence += 1;
    let instance_key = if *occurrence == 1 {
        quiz.key.clone()
    } else {
        format!("{}-{occurrence}", quiz.key)
    };
    let mut html = format!(
        "<ob-quiz data-key=\"{}\"><fieldset><legend>{prompt}</legend><div class=\"ob-quiz-choices\">",
        instance_key
    );
    for (index, choice) in quiz.choices.iter().enumerate() {
        let answer = quiz_inline(&choice.text)?;
        let correct = if choice.correct {
            " data-correct=\"true\""
        } else {
            ""
        };
        html.push_str(&format!(
            "<label class=\"ob-quiz-choice\"><input type=\"radio\" name=\"obq-{}\" value=\"{index}\"{correct}> <span>{answer}</span></label>",
            instance_key
        ));
    }
    html.push_str("</div><p class=\"ob-quiz-feedback\" aria-live=\"polite\" hidden>");
    if let Some(explanation) = quiz.explanation {
        html.push_str(&format!(
            "<span class=\"ob-quiz-explanation\">{}</span>",
            quiz_inline(&explanation)?
        ));
    }
    html.push_str("</p><button class=\"ob-quiz-retry\" type=\"button\" hidden>Retry</button></fieldset></ob-quiz>\n");
    Ok(html)
}

/// A knowledge check without controls: the prompt, lettered choices, and the
/// author's answer and explanation immediately after the choices.
fn render_portable_quiz(source: &str) -> Result<String, String> {
    let quiz = parse_quiz(source)?;
    let mut html = format!(
        "<div class=\"ob-quiz\">
<p class=\"ob-quiz-prompt\"><strong>{}</strong></p>
<ol class=\"ob-quiz-choices\" type=\"A\">
",
        quiz_inline(&quiz.prompt)?
    );
    let mut answer = String::new();
    for (index, choice) in quiz.choices.iter().enumerate() {
        let text = quiz_inline(&choice.text)?;
        if choice.correct {
            // Parsing allows at most four choices, so the letter stays in A-D.
            answer = format!("{}. {text}", char::from(b'A' + index as u8));
        }
        html.push_str(&format!(
            "<li>{text}</li>
"
        ));
    }
    html.push_str(&format!(
        "</ol>
<div class=\"ob-quiz-answer\">
<p>Answer: {answer}</p>
"
    ));
    if let Some(explanation) = quiz.explanation {
        html.push_str(&format!(
            "<p>{}</p>
",
            quiz_inline(&explanation)?
        ));
    }
    html.push_str(
        "</div>
</div>
",
    );
    Ok(html)
}

pub(crate) fn portable_quiz_markdown(source: &str) -> Result<String, String> {
    let quiz = parse_quiz(source)?;
    let mut markdown = format!("**Question:** {}\n\n", quiz.prompt);
    let mut answer = None;
    for (index, choice) in quiz.choices.iter().enumerate() {
        markdown.push_str(&format!("{}. {}\n", index + 1, choice.text));
        if choice.correct {
            answer = Some((index + 1, choice.text.as_str()));
        }
    }
    if let Some((number, text)) = answer {
        markdown.push_str(&format!("\n**Answer:** {number}. {text}\n"));
    }
    if let Some(explanation) = quiz.explanation {
        markdown.push_str(&format!("\n> **Explanation:** {explanation}\n"));
    }
    Ok(markdown)
}

/// The fence's authored line options (`showLineNumbers`, the start line, and
/// `{2,4-5}` highlights) as `data-line-*` attributes.
fn line_attributes(fence: &FenceInfo) -> String {
    let mut attributes = String::new();
    if let Some(on) = fence.line_numbers {
        attributes.push_str(&format!(" data-line-numbers=\"{on}\""));
    }
    if let Some(n) = fence.line_start {
        attributes.push_str(&format!(" data-line-start=\"{n}\""));
    }
    if let Some(ranges) = &fence.highlight {
        attributes.push_str(&format!(
            " data-highlight-lines=\"{}\"",
            escape::attr(ranges)
        ));
    }
    attributes
}

pub(crate) fn rust_playground_url(source: &str) -> Option<String> {
    let mut url = url::Url::parse("https://play.rust-lang.org/").expect("static Playground URL");
    url.query_pairs_mut()
        .append_pair("version", "stable")
        .append_pair("mode", "debug")
        .append_pair("edition", "2021")
        .append_pair("code", source);
    // Keep exported links practical for feed readers and destination importers.
    (url.as_str().len() <= 8 * 1024).then(|| url.into())
}

/// A runnable fence without its runtime: source, an optional external Playground
/// link for Rust, and a link back to the canonical article.
fn portable_code_html(
    fence: &FenceInfo,
    source: &str,
    web_sandbox: bool,
    canonical_url: &str,
    playground_link: bool,
) -> String {
    // Copies cannot run the checks, so the starter is shown as the code and the checks follow
    // as a collapsed spoiler: a reader on another platform can still see how it is checked.
    let (source, spoiler) = if fence.check {
        split_rust_checks(source)
    } else {
        (source, None)
    };
    let code = |lang: &str, source: &str, lines: &str| {
        let class = if lang.is_empty() {
            String::new()
        } else {
            format!(" class=\"language-{}\"", escape::attr(lang))
        };
        format!(
            "<pre><code{class}{lines}>{}</code></pre>",
            escape::text(source)
        )
    };
    let kind = if web_sandbox {
        "ob-web-sandbox"
    } else {
        "ob-runnable-code"
    };
    let mut html = format!("<figure class=\"ob-code-block {kind}\">");
    if let Some(title) = &fence.title {
        html.push_str(&format!(
            "<figcaption class=\"ob-code-title\">{}</figcaption>",
            escape::text(title)
        ));
    }
    let action = if web_sandbox {
        // Mirror the sandbox's own split, keeping any text before the first
        // marker visible instead of silently dropping it.
        let mut preamble = String::new();
        let mut files = [
            ("html", "HTML", String::new()),
            ("css", "CSS", String::new()),
            ("js", "JavaScript", String::new()),
        ];
        let mut active: Option<usize> = None;
        for line in source.lines() {
            let marker = line
                .trim()
                .strip_prefix("---")
                .and_then(|name| files.iter().position(|(file, _, _)| *file == name));
            if marker.is_some() {
                active = marker;
                continue;
            }
            let buffer = match active {
                Some(index) => &mut files[index].2,
                None => &mut preamble,
            };
            buffer.push_str(line);
            buffer.push('\n');
        }
        if !preamble.trim().is_empty() {
            html.push_str(&code("", &preamble, ""));
        }
        for (lang, label, source) in &files {
            if !source.trim().is_empty() {
                html.push_str(&format!("<p class=\"ob-web-sandbox-label\">{label}</p>"));
                html.push_str(&code(lang, source, ""));
            }
        }
        "Open the live preview on"
    } else {
        html.push_str(&code(&fence.lang, source, &line_attributes(fence)));
        if fence.lang.eq_ignore_ascii_case("rust")
            && fence.playground_link.unwrap_or(playground_link)
        {
            if let Some(url) = rust_playground_url(source) {
                html.push_str(&format!(
                    "<p class=\"ob-playground-link\"><a href=\"{}\">Open in Rust Playground</a>.</p>",
                    escape::attr(&url)
                ));
            }
        }
        if let Some(checks) = spoiler {
            html.push_str(&format!(
                "<details class=\"ob-spoiler\"><summary>{RUST_CHECKS_SPOILER}</summary><p>{RUST_CHECKS_SPOILER_NOTE}</p>{}</details>",
                code("rust", checks, "")
            ));
        }
        "Run and edit this example on"
    };
    html.push_str(&format!(
        "<p class=\"ob-portable-note\">{action} <a href=\"{}\">the original article</a>.</p></figure>
",
        escape::attr(canonical_url)
    ));
    html
}

/// How a line of raw block HTML changes the element depth: `+1` for an
/// opening tag left open, `-1` for a closing tag, `0` otherwise (void and
/// self-closing tags, elements closed on the same line, comments).
fn html_line_depth(line: &str) -> i32 {
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
        "track", "wbr",
    ];
    let t = line.trim();
    if t.starts_with("</") {
        return -1;
    }
    let Some(rest) = t.strip_prefix('<') else {
        return 0;
    };
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect::<String>()
        .to_ascii_lowercase();
    let tag_end = t.find('>').unwrap_or(t.len());
    if name.is_empty()
        || VOID.contains(&name.as_str())
        || t[..tag_end].ends_with('/')
        || t.to_ascii_lowercase().contains(&format!("</{name}"))
    {
        return 0;
    }
    1
}

/// Rewrite fenced code blocks (titles, line options), GitHub-style callouts,
/// and, for recipes, the Ingredients and Steps sections.
///
/// Recipe sections only ever open and close at the top level of the post:
/// a heading or list inside a quote, callout, list item, table or footnote
/// belongs to that container and is left alone.
/// An interactive demo a post can embed with a `demo` fence. The element is the native
/// presentation; the authored fallback (or `summary`) is what a reader without JavaScript, a feed
/// reader, and a syndicated copy all see.
pub(crate) struct DemoKind {
    pub(crate) id: &'static str,
    pub(crate) element: &'static str,
    pub(crate) label: &'static str,
    summary: &'static str,
}

const DEMO_KINDS: &[DemoKind] = &[
    DemoKind {
        id: "git-sandbox",
        element: "ob-git-sandbox",
        label: "Git sandbox",
        summary: "An in-memory Git repository you can drive with commands or buttons: make commits, create branches, merge with and without fast-forward, cause a conflict and resolve it, with a graph that updates after every step.",
    },
    DemoKind {
        id: "git-practice",
        element: "ob-practice-lab",
        label: "Git practice terminal",
        summary: "A guided practice terminal: one goal at a time, you type the Git command yourself, and the terminal shows what it would print and why, with a hint when you are stuck.",
    },
    DemoKind {
        id: "fetch-lab",
        element: "ob-fetch-lab",
        label: "Fetch and storage inspector",
        summary: "A simulated network inspector and browser storage panel: edit a request, see the raw response, what `fetch()` and `response.json()` would do with it, and what Web Storage keeps.",
    },
    DemoKind {
        id: "component-lab",
        element: "ob-component-lab",
        label: "Web Components explorer",
        summary: "A live custom element with a real shadow root: change an attribute, a slot or a CSS custom property and see how the light DOM, the shadow tree and the slot assignments respond.",
    },
    DemoKind {
        id: "js-evolution",
        element: "ob-evolution-lab",
        label: "JavaScript evolution comparison",
        summary: "Older and newer JavaScript for the same task, side by side: pick a milestone, read both versions, then run the two fixed functions on the same sample data to see that they agree.",
    },
    DemoKind {
        id: "audio-lab",
        element: "ob-audio-lab",
        label: "Web Audio signal lab",
        summary: "A small real Web Audio synth: an oscillator through a low-pass filter to a deliberately quiet output, with a live trace of the filtered signal. Sound plays only after you press Start.",
    },
    DemoKind {
        id: "native-lab",
        element: "ob-native-lab",
        label: "Native browser APIs playground",
        summary: "Three browser-native features on small examples: View Transitions and the Web Animations API, the popover attribute, and the Intersection and Resize observers, each reporting whether your browser supports it.",
    },
];

const MAX_DEMO_FALLBACK_BYTES: usize = 20_000;

pub(crate) fn demo_kind(id: &str) -> Option<&'static DemoKind> {
    DEMO_KINDS.iter().find(|kind| kind.id == id)
}

fn demo_kind_names() -> String {
    DEMO_KINDS
        .iter()
        .map(|kind| kind.id)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The kind a `demo` fence names, or the authoring error that explains what to write.
fn demo_kind_for(fence: &FenceInfo) -> Result<&'static DemoKind, String> {
    match fence.demo.as_deref() {
        Some(name) => demo_kind(name).ok_or_else(|| {
            format!(
                "a `demo` fence names unknown kind `{name}`; known kinds are {}",
                demo_kind_names()
            )
        }),
        None => Err(format!(
            "a `demo` fence needs a kind, as in `demo git-sandbox`; known kinds are {}",
            demo_kind_names()
        )),
    }
}

/// Check a demo's authored fallback, and return the Markdown it stands for. The fallback is
/// rendered into native pages, feeds and portable copies alike, so it is plain Markdown: no raw
/// HTML, no images, and only absolute https or mailto links. An empty body means "use the
/// kind's own summary".
fn demo_fallback_markdown(kind: &DemoKind, source: &str) -> Result<String, String> {
    if source.trim().is_empty() {
        return Ok(kind.summary.to_string());
    }
    if source.len() > MAX_DEMO_FALLBACK_BYTES {
        return Err(format!(
            "a `demo` fence's fallback must stay under {MAX_DEMO_FALLBACK_BYTES} bytes"
        ));
    }
    for event in Parser::new_ext(source, parser_options(false)) {
        match event {
            Event::Html(_) | Event::InlineHtml(_) => {
                return Err("a `demo` fence's fallback is Markdown: raw HTML is not supported".into())
            }
            Event::Start(Tag::Image { .. }) => {
                return Err("a `demo` fence's fallback cannot contain images; describe what they show".into())
            }
            Event::Start(Tag::Link { dest_url, .. })
                if !(dest_url.starts_with("https://") || dest_url.starts_with("mailto:")) =>
            {
                return Err(format!(
                    "a `demo` fence's fallback links must be absolute https URLs, found `{dest_url}`"
                ))
            }
            _ => {}
        }
    }
    Ok(source.trim().to_string())
}

/// What a portable Markdown copy needs from a `demo` fence: its kind and its fallback.
pub(crate) fn portable_demo_parts(
    fence: &FenceInfo,
    source: &str,
) -> Result<(&'static DemoKind, String), String> {
    let kind = demo_kind_for(fence)?;
    Ok((kind, demo_fallback_markdown(kind, source)?))
}

fn render_demo(
    fence: &FenceInfo,
    source: &str,
    canonical_url: Option<&str>,
) -> Result<String, String> {
    let (kind, markdown) = portable_demo_parts(fence, source)?;
    let mut fallback = String::new();
    pulldown_cmark::html::push_html(
        &mut fallback,
        Parser::new_ext(&markdown, parser_options(false)),
    );
    let caption = fence
        .title
        .as_deref()
        .map(|title| {
            format!(
                "<figcaption class=\"ob-code-title\">{}</figcaption>",
                escape::text(title)
            )
        })
        .unwrap_or_default();
    Ok(match canonical_url {
        Some(url) => format!(
            "<figure class=\"ob-demo ob-portable-demo\" data-demo=\"{id}\">{caption}{fallback}<p class=\"ob-portable-note\">Try the interactive {label} on <a href=\"{url}\">the original article</a>.</p></figure>\n",
            id = kind.id,
            label = escape::text(kind.label),
            url = escape::attr(url),
        ),
        None => format!(
            "<figure class=\"ob-demo\" data-demo=\"{id}\">{caption}<{element}{lesson}>{fallback}</{element}></figure>\n",
            id = kind.id,
            element = kind.element,
            lesson = fence
                .demo_lesson
                .as_deref()
                .map(|id| format!(" data-lesson=\"{}\"", escape::attr(id)))
                .unwrap_or_default(),
        ),
    })
}

fn transform_blocks<'a>(
    events: Vec<Event<'a>>,
    recipe: bool,
    code_runner: Option<CodeRunnerRenderOptions<'_>>,
    web_libraries: Option<&BTreeMap<String, Vec<String>>>,
    playground_link: bool,
    portable: Option<PortableContext<'_>>,
) -> (Vec<Event<'a>>, BlockData) {
    let mut out = Vec::with_capacity(events.len());
    let mut data = BlockData::default();
    let mut titled_code = false;
    let mut runnable_code = false;
    let mut configured_runner = false;
    let mut web_sandbox = false;
    // The whole body of an open `rust runnable check` fence: starter and hidden checks.
    let mut rust_check: Option<String> = None;
    // Open containers (quotes, callouts, list items, tables, footnotes).
    let mut depth = 0usize;
    // An open recipe section: what it holds and the heading level that opened it.
    let mut section: Option<(Section, u8)> = None;
    // The section's top-level list while it is open: `true` when ordered.
    let mut recipe_list: Option<bool> = None;
    let mut item: Option<String> = None;
    // Raw HTML elements opened (and not yet closed) since the section began.
    let mut html_depth = 0i32;
    // A fence the canonical page can run, collected for its static fallback.
    let mut portable_code: Option<(FenceInfo, String)> = None;
    // Fence text arrives line by line inside containers, so each capability
    // fence is collected whole before it is validated or rendered.
    let mut quiz: Option<String> = None;
    let mut sandbox_source = String::new();
    let mut quiz_group_open = false;
    let mut quiz_occurrences = std::collections::HashMap::new();
    // An open `demo` fence and its authored fallback text.
    let mut demo: Option<(FenceInfo, String)> = None;
    // An open `compare` fence and its source.
    let mut compare: Option<String> = None;
    // An open `piece` fence: the kind it names and its `field: value` lines.
    let mut piece: Option<(String, String)> = None;
    // The section a deeper heading switched away from ("### Ingredients for the
    // glaze" inside "## Method"); it resumes when that sub-section ends.
    let mut outer: Option<(Section, u8)> = None;
    let close = |out: &mut Vec<Event<'_>>, section: &mut Option<(Section, u8)>| {
        if section.take().is_some() {
            out.push(Event::Html(CowStr::from("</section>\n")));
        }
    };

    for (i, event) in events.iter().enumerate() {
        if matches!(event, Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) if info.trim() == "quiz")
        {
            data.capabilities.push(CapabilityDescriptor::describe(
                "knowledge-check",
                Some("ob-quiz"),
            ));
            if !quiz_group_open {
                out.push(Event::Html(CowStr::from(
                    "<section class=\"ob-knowledge-check\" aria-label=\"Knowledge check\">\n",
                )));
                quiz_group_open = true;
            }
            quiz = Some(String::new());
            continue;
        }
        if let Some(source) = quiz.as_mut() {
            match event {
                Event::Text(text) => source.push_str(text),
                Event::End(TagEnd::CodeBlock) => {
                    let source = quiz.take().unwrap_or_default();
                    // An empty fence has always built as an empty knowledge check.
                    let rendered = if source.is_empty() {
                        Ok(String::new())
                    } else if portable.is_some() {
                        render_portable_quiz(&source)
                    } else {
                        render_quiz(&source, &mut quiz_occurrences)
                    };
                    match rendered {
                        Ok(html) if html.is_empty() => {}
                        Ok(html) => out.push(Event::Html(CowStr::from(html))),
                        Err(error) => {
                            data.errors.push(error.clone());
                            if let Some(capability) = data.capabilities.last_mut() {
                                capability.add_diagnostic(
                                    CapabilityDiagnosticCode::MalformedContent,
                                    "Malformed knowledge check; see the source-scoped Markdown error.",
                                );
                            }
                            out.push(Event::Html(CowStr::from(format!(
                                "<aside class=\"ob-quiz-error\" role=\"alert\">Invalid knowledge check: {}</aside>\n",
                                escape::text(&error)
                            ))));
                        }
                    }
                    let next_is_quiz = matches!(
                        events.get(i + 1),
                        Some(Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))))
                            if info.trim() == "quiz"
                    );
                    if !next_is_quiz {
                        out.push(Event::Html(CowStr::from("</section>\n")));
                        quiz_group_open = false;
                    }
                }
                _ => {}
            }
            continue;
        }
        if matches!(event, Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) if info.trim() == crate::compare::FENCE)
        {
            compare = Some(String::new());
            continue;
        }
        if let Some(source) = compare.as_mut() {
            match event {
                Event::Text(text) => source.push_str(text),
                Event::End(TagEnd::CodeBlock) => {
                    let source = compare.take().unwrap_or_default();
                    data.capabilities.push(CapabilityDescriptor::describe(
                        crate::compare::CAPABILITY_ID,
                        Some(crate::compare::ELEMENT),
                    ));
                    let parsed = crate::compare::parse(&source).and_then(|pair| {
                        if portable.is_some() && !pair.is_absolute() {
                            Err(vec![
                                "a portable copy needs each picture at an https:// address"
                                    .to_string(),
                            ])
                        } else {
                            Ok(pair)
                        }
                    });
                    match parsed {
                        Ok(pair) => out.push(Event::Html(CowStr::from(if portable.is_some() {
                            pair.portable_html()
                        } else {
                            pair.page_html()
                        }))),
                        Err(problems) => {
                            let error =
                                format!("a `compare` fence is not valid: {}", problems.join("; "));
                            data.errors.push(error.clone());
                            if let Some(capability) = data.capabilities.last_mut() {
                                capability.add_diagnostic(
                                    CapabilityDiagnosticCode::MalformedContent,
                                    "Malformed before and after pair; see the source-scoped Markdown error.",
                                );
                            }
                            out.push(Event::Html(CowStr::from(format!(
                                "<aside class=\"ob-compare-error\" role=\"alert\">Invalid before and after pair: {}</aside>\n",
                                escape::text(&error)
                            ))));
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if let Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) = event {
            let mut words = info.split_whitespace();
            if words.next() == Some("piece") {
                piece = Some((words.next().unwrap_or("").to_string(), String::new()));
                continue;
            }
        }
        if let Some((kind, source)) = piece.as_mut() {
            match event {
                Event::Text(text) => source.push_str(text),
                Event::End(TagEnd::CodeBlock) => {
                    let (kind, source) = (std::mem::take(kind), std::mem::take(source));
                    piece = None;
                    let mode = if portable.is_some() {
                        crate::render::piece::Mode::Portable
                    } else {
                        crate::render::piece::Mode::Page
                    };
                    match crate::piece::Piece::from_directive(&kind, &source) {
                        Ok(parsed) => out.push(Event::Html(CowStr::from(
                            crate::render::piece::post_piece(&parsed, mode),
                        ))),
                        Err(problems) => {
                            let error =
                                format!("`piece {kind}` is not valid: {}", problems.join("; "));
                            data.errors.push(error.clone());
                            out.push(Event::Html(CowStr::from(format!(
                                "<aside class=\"ob-piece-error\" role=\"alert\">Invalid piece: {}</aside>
",
                                escape::text(&error)
                            ))));
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if let Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) = event {
            let fence = parse_fence_info(info);
            if fence.lang == "demo" {
                demo = Some((fence, String::new()));
                continue;
            }
        }
        if let Some((_, source)) = demo.as_mut() {
            match event {
                Event::Text(text) => source.push_str(text),
                Event::End(TagEnd::CodeBlock) => {
                    let (fence, source) = demo.take().unwrap_or_default();
                    data.capabilities.push(CapabilityDescriptor::describe(
                        "interactive-demo",
                        demo_kind_for(&fence).ok().map(|kind| kind.element),
                    ));
                    match render_demo(
                        &fence,
                        &source,
                        portable.map(|context| context.canonical_url),
                    ) {
                        Ok(html) => out.push(Event::Html(CowStr::from(html))),
                        Err(error) => {
                            data.errors.push(error.clone());
                            if let Some(capability) = data.capabilities.last_mut() {
                                capability.add_diagnostic(
                                    CapabilityDiagnosticCode::MalformedContent,
                                    "Malformed interactive demo; see the source-scoped Markdown error.",
                                );
                            }
                            out.push(Event::Html(CowStr::from(format!(
                                "<aside class=\"ob-demo-error\" role=\"alert\">Invalid interactive demo: {}</aside>\n",
                                escape::text(&error)
                            ))));
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if let Some(source) = rust_check.as_mut() {
            if let Event::Text(text) = event {
                source.push_str(text);
                continue;
            }
        }
        if web_sandbox {
            if let Event::Text(text) = event {
                sandbox_source.push_str(text);
            }
        }
        // An empty fence (no text at all) has always built; validate what was written.
        if web_sandbox && matches!(event, Event::End(TagEnd::CodeBlock)) && {
            let source = std::mem::take(&mut sandbox_source);
            !source.is_empty() && !valid_web_sandbox_source(&source)
        } {
            data.errors.push(
                "a `web runnable` fence needs a non-empty `---html`, `---css`, or `---js` section and must stay under 100,000 bytes"
                    .into(),
            );
            if let Some(capability) = data.capabilities.last_mut() {
                capability.add_diagnostic(
                    CapabilityDiagnosticCode::MalformedContent,
                    "Malformed web sandbox; see the source-scoped Markdown error.",
                );
            }
        }
        if let (Some((fence, source)), Some(context)) = (portable_code.as_mut(), portable) {
            match event {
                Event::Text(text) => source.push_str(text),
                Event::End(TagEnd::CodeBlock) => {
                    out.push(Event::Html(CowStr::from(portable_code_html(
                        fence,
                        source,
                        web_sandbox,
                        context.canonical_url,
                        playground_link,
                    ))));
                    portable_code = None;
                    titled_code = false;
                    runnable_code = false;
                    configured_runner = false;
                    web_sandbox = false;
                }
                _ => {}
            }
            continue;
        }
        // What this event becomes in the output.
        let rendered = match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let fence = parse_fence_info(info);
                let mut html = String::new();
                if let Some(title) = &fence.title {
                    html.push_str(&format!(
                        "<figure class=\"ob-code-block\"><figcaption class=\"ob-code-title\">{}</figcaption>",
                        escape::text(title)
                    ));
                }
                titled_code = fence.title.is_some();
                let runner = code_runner.filter(|runner| {
                    fence.lang.eq_ignore_ascii_case("rust")
                        || runner
                            .languages
                            .iter()
                            .any(|language| language.eq_ignore_ascii_case(&fence.lang))
                });
                configured_runner = fence.runnable && runner.is_some();
                runnable_code = fence.runnable && fence.lang.eq_ignore_ascii_case("rust");
                web_sandbox = fence.runnable && fence.lang.eq_ignore_ascii_case("web");
                if fence.check && !runnable_code {
                    data.errors
                        .push("`check` belongs on a `rust runnable` fence".into());
                }
                rust_check = (runnable_code && fence.check && portable.is_none()).then(String::new);
                if fence.runnable {
                    let (id, renderer) = if web_sandbox {
                        ("web-sandbox", Some("ob-web-sandbox"))
                    } else if configured_runner {
                        ("runnable-code", Some("ob-code-runner"))
                    } else if runnable_code {
                        ("runnable-code", Some("ob-rust-playground"))
                    } else {
                        ("runnable-code", None)
                    };
                    data.capabilities
                        .push(CapabilityDescriptor::describe(id, renderer));
                    if portable.is_some() && renderer.is_some() {
                        portable_code = Some((fence, String::new()));
                        continue;
                    }
                }
                if configured_runner {
                    let runner = runner.expect("configured runner was checked");
                    html.push_str(&format!(
                        "<ob-code-runner data-language=\"{}\" data-endpoint=\"{}\">",
                        escape::attr(&fence.lang.to_ascii_lowercase()),
                        escape::attr(runner.endpoint)
                    ));
                } else if runnable_code {
                    html.push_str("<ob-rust-playground");
                    if !fence.playground_link.unwrap_or(playground_link) {
                        html.push_str(" data-playground-link=\"false\"");
                    }
                    html.push('>');
                }
                if web_sandbox {
                    html.push_str("<ob-web-sandbox");
                    for (enabled, attribute) in [
                        (fence.module, " data-module"),
                        (fence.network, " data-network"),
                        (fence.images, " data-images"),
                    ] {
                        if enabled {
                            html.push_str(attribute);
                        }
                    }
                    html.push('>');
                    for name in &fence.libs {
                        match web_libraries.and_then(|libraries| libraries.get(name)) {
                            Some(files) => {
                                for file in files {
                                    html.push_str(&format!(
                                        "<link rel=\"preload\" as=\"fetch\" crossorigin href=\"{}\" data-ob-web-lib=\"{}\">",
                                        escape::attr(file),
                                        escape::attr(name)
                                    ));
                                }
                            }
                            None => data.errors.push(format!(
                                "a `web runnable` fence names library `{name}`, which is not listed under `webSandbox.libraries` in openblog.json"
                            )),
                        }
                    }
                }
                html.push_str("<pre><code");
                if !fence.lang.is_empty() {
                    html.push_str(&format!(
                        " class=\"language-{}\"",
                        escape::attr(&fence.lang)
                    ));
                }
                if runnable_code || configured_runner {
                    html.push_str(&format!(
                        " data-runnable=\"{}\"",
                        escape::attr(&fence.lang.to_ascii_lowercase())
                    ));
                } else if web_sandbox {
                    html.push_str(" data-runnable=\"web\"");
                }
                html.push_str(&line_attributes(&fence));
                html.push('>');
                Event::Html(CowStr::from(html))
            }
            Event::End(TagEnd::CodeBlock)
                if titled_code || runnable_code || configured_runner || web_sandbox =>
            {
                let mut html = String::from("</code></pre>");
                if let Some(source) = rust_check.take() {
                    let (starter, checks) = split_rust_checks(&source);
                    if let Some(error) = rust_check_error(starter, checks) {
                        data.errors.push(error.into());
                        if let Some(capability) = data.capabilities.last_mut() {
                            capability.add_diagnostic(
                                CapabilityDiagnosticCode::MalformedContent,
                                "Malformed Rust check; see the source-scoped Markdown error.",
                            );
                        }
                    }
                    out.push(Event::Text(CowStr::from(starter.to_string())));
                    if let Some(checks) = checks {
                        // Hidden from the editor, present in the page data. `<` is escaped so the
                        // text can never close the script element early.
                        let json = serde_json::to_string(checks)
                            .unwrap_or_else(|_| "\"\"".into())
                            .replace('<', "\\u003c");
                        html.push_str(&format!(
                            "<script type=\"application/json\" data-ob-rust-checks>{json}</script>"
                        ));
                    }
                }
                if configured_runner {
                    html.push_str("</ob-code-runner>");
                } else if runnable_code {
                    html.push_str("</ob-rust-playground>");
                }
                if web_sandbox {
                    html.push_str("</ob-web-sandbox>");
                }
                if titled_code {
                    html.push_str("</figure>");
                }
                html.push('\n');
                titled_code = false;
                runnable_code = false;
                configured_runner = false;
                web_sandbox = false;
                Event::Html(CowStr::from(html))
            }
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                let (class, label) = callout_label(*kind);
                // Portable output has no stylesheet, so the title needs its own emphasis.
                let label = if portable.is_some() {
                    format!("<strong>{label}</strong>")
                } else {
                    label.to_string()
                };
                Event::Html(CowStr::from(format!(
                    "<aside class=\"ob-callout ob-callout-{class}\" role=\"note\"><p class=\"ob-callout-title\">{label}</p>\n"
                )))
            }
            Event::End(TagEnd::BlockQuote(Some(_))) => Event::Html(CowStr::from("</aside>\n")),
            other => other.clone(),
        };
        if !recipe {
            out.push(rendered);
            continue;
        }
        let opens = matches!(
            event,
            Event::Start(
                Tag::BlockQuote(_) | Tag::Item | Tag::FootnoteDefinition(_) | Tag::Table(_)
            )
        );
        let closes = matches!(
            event,
            Event::End(
                TagEnd::BlockQuote(_) | TagEnd::Item | TagEnd::FootnoteDefinition | TagEnd::Table
            )
        );
        // Block boundaries inside an item (paragraphs, sub-lists) separate words.
        if let Some(buf) = item.as_mut() {
            if matches!(
                event,
                Event::Start(Tag::Item | Tag::Paragraph | Tag::List(_))
                    | Event::End(TagEnd::Item | TagEnd::Paragraph | TagEnd::List(_))
            ) {
                buf.push(' ');
            }
        }

        match event {
            Event::Start(Tag::Heading { level, id, .. }) if depth == 0 => {
                let level = heading_level(*level);
                let title: String = events[i + 1..]
                    .iter()
                    .take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_))))
                    .filter_map(|e| match e {
                        Event::Text(t) | Event::Code(t) => Some(t.as_ref()),
                        _ => None,
                    })
                    .collect();
                let mut kind = recipe::classify_heading(&title);
                if outer.is_some_and(|(_, outer_level)| level <= outer_level) {
                    outer = None;
                }
                if let Some((open_kind, open_level)) = section {
                    // A heading at the same or a higher level ends the section; so
                    // does a deeper "Method" inside "Ingredients" (or the reverse).
                    let switches = level > open_level && kind.is_some_and(|k| k != open_kind);
                    if switches && outer.is_none() {
                        outer = Some((open_kind, open_level));
                    }
                    if level <= open_level || switches {
                        close(&mut out, &mut section);
                    }
                }
                // After a switched-in sub-section ends, the outer kind carries on.
                let mut level_opened = level;
                if let (None, None, Some((outer_kind, outer_level))) = (section, kind, outer) {
                    if level > outer_level {
                        kind = Some(outer_kind);
                        level_opened = outer_level;
                        outer = None;
                    }
                }
                if let (None, Some(kind)) = (section, kind) {
                    out.push(Event::Html(CowStr::from(format!(
                        "<section class=\"ob-recipe-part ob-recipe-{}\">\n",
                        kind.class()
                    ))));
                    section = Some((kind, level_opened));
                    html_depth = 0;
                    if data.recipe_anchor.is_none() {
                        data.recipe_anchor = id.as_ref().map(|s| s.to_string());
                    }
                }
                out.push(rendered);
            }
            // Raw HTML arrives one line at a time. Elements opened inside the
            // section stay inside it; a closing tag for a wrapper opened before
            // the section (`</details>`) ends the section first.
            Event::Html(html) if depth == 0 && section.is_some() => {
                let delta = html_line_depth(html);
                if delta < 0 && html_depth == 0 {
                    close(&mut out, &mut section);
                } else {
                    html_depth = (html_depth + delta).max(0);
                }
                out.push(rendered);
            }
            Event::Start(Tag::List(start)) if depth == 0 && recipe_list.is_none() => {
                let Some((kind, _)) = section else {
                    out.push(rendered);
                    continue;
                };
                let kind = kind.class();
                recipe_list = Some(start.is_some());
                let html = match start {
                    Some(n) if *n != 1 => {
                        format!("<ol class=\"ob-recipe-list ob-{kind}\" start=\"{n}\">\n")
                    }
                    Some(_) => format!("<ol class=\"ob-recipe-list ob-{kind}\">\n"),
                    None => format!("<ul class=\"ob-recipe-list ob-{kind}\">\n"),
                };
                out.push(Event::Html(CowStr::from(html)));
            }
            Event::End(TagEnd::List(_)) if depth == 0 && recipe_list.is_some() => {
                let ordered = recipe_list.take().unwrap_or(false);
                out.push(Event::Html(CowStr::from(if ordered {
                    "</ol>\n"
                } else {
                    "</ul>\n"
                })));
            }
            Event::Start(Tag::Item) if depth == 0 && recipe_list.is_some() => {
                item = Some(String::new());
                out.push(rendered);
            }
            Event::End(TagEnd::Item) if depth == 1 && recipe_list.is_some() => {
                if let (Some(text), Some((kind, _))) = (item.take(), section) {
                    let text = collapse_whitespace(&text);
                    if !text.is_empty() {
                        match kind {
                            Section::Ingredients => data.ingredients.push(text),
                            Section::Steps => data.steps.push(text),
                        }
                    }
                }
                out.push(rendered);
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some(buf) = item.as_mut() {
                    buf.push_str(t);
                }
                out.push(rendered);
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(buf) = item.as_mut() {
                    buf.push(' ');
                }
                out.push(rendered);
            }
            _ => out.push(rendered),
        }
        if opens {
            depth += 1;
        } else if closes {
            depth = depth.saturating_sub(1);
        }
    }
    close(&mut out, &mut section);
    (out, data)
}

/// The URL a paragraph consists of, if it is nothing but one link (or the bare
/// URL as text, or Hashnode's `%[url]`).
fn standalone_url(inner: &[Event]) -> Option<String> {
    match inner {
        [Event::Start(Tag::Link { dest_url, .. }), middle @ .., Event::End(TagEnd::Link)]
            if middle
                .iter()
                .all(|e| matches!(e, Event::Text(_) | Event::Code(_))) =>
        {
            Some(dest_url.to_string())
        }
        _ if !inner.is_empty() && inner.iter().all(|e| matches!(e, Event::Text(_))) => {
            let joined: String = inner
                .iter()
                .map(|e| match e {
                    Event::Text(t) => t.as_ref(),
                    _ => "",
                })
                .collect();
            let joined = joined.trim();
            (joined.starts_with("http") || joined.starts_with("%[http")).then(|| joined.to_string())
        }
        _ => None,
    }
}

/// The production embed represented by one paragraph's inner events, if any.
pub(crate) fn standalone_embed(inner: &[Event<'_>]) -> Option<crate::embed::Embed> {
    standalone_url(inner).and_then(|url| crate::embed::detect(&url))
}

/// Whether any paragraph of `markdown`, parsed either way, is a standalone link the production
/// renderer would replace with an embed when embeds are on.
pub(crate) fn has_standalone_embed(markdown: &str) -> bool {
    [false, true].into_iter().any(|smart| {
        let events: Vec<_> = Parser::new_ext(markdown, parser_options(smart)).collect();
        events.iter().enumerate().any(|(index, event)| {
            matches!(event, Event::Start(Tag::Paragraph))
                && events[index + 1..]
                    .iter()
                    .position(|e| matches!(e, Event::End(TagEnd::Paragraph)))
                    .is_some_and(|len| {
                        standalone_embed(&events[index + 1..index + 1 + len]).is_some()
                    })
        })
    })
}

/// Replace standalone embeddable links with their embed HTML.
fn apply_embeds(events: Vec<Event<'_>>) -> Vec<Event<'_>> {
    let mut out = Vec::with_capacity(events.len());
    let mut i = 0;
    while i < events.len() {
        if matches!(events[i], Event::Start(Tag::Paragraph)) {
            if let Some(len) = events[i + 1..]
                .iter()
                .position(|e| matches!(e, Event::End(TagEnd::Paragraph)))
            {
                let inner = &events[i + 1..i + 1 + len];
                if let Some(embed) = standalone_embed(inner) {
                    out.push(Event::Html(CowStr::from(crate::embed::html(&embed))));
                    i += len + 2;
                    continue;
                }
            }
        }
        out.push(events[i].clone());
        i += 1;
    }
    out
}

/// Replace standalone embeddable links with a titled link to the provider, and,
/// for video posts, a paragraph of timestamp lines with a chapter list.
fn apply_portable_paragraphs<'a>(
    events: Vec<Event<'a>>,
    context: PortableContext<'_>,
    video_ids: &mut Vec<String>,
) -> Vec<Event<'a>> {
    let mut out = Vec::with_capacity(events.len());
    let mut i = 0;
    while i < events.len() {
        if matches!(events[i], Event::Start(Tag::Paragraph)) {
            if let Some(len) = events[i + 1..]
                .iter()
                .position(|e| matches!(e, Event::End(TagEnd::Paragraph)))
            {
                let inner = &events[i + 1..i + 1 + len];
                let replacement = standalone_embed(inner)
                    .map(|embed| {
                        if let Some(id) = crate::embed::youtube_video_id(&embed.link) {
                            video_ids.push(id);
                        }
                        portable_embed_html(inner, &embed)
                    })
                    .or_else(|| {
                        context
                            .chapters
                            .then(|| {
                                chapters_html(
                                    inner
                                        .split(|e| matches!(e, Event::SoftBreak | Event::HardBreak))
                                        .collect(),
                                    context.video_id,
                                )
                            })
                            .flatten()
                    });
                if let Some(html) = replacement {
                    out.push(Event::Html(CowStr::from(html)));
                    i += len + 2;
                    continue;
                }
            }
        }
        if context.chapters && matches!(events[i], Event::Start(Tag::List(None))) {
            if let Some((len, html)) = chapter_list(&events[i..], context.video_id) {
                out.push(Event::Html(CowStr::from(html)));
                i += len;
                continue;
            }
        }
        out.push(events[i].clone());
        i += 1;
    }
    out
}

/// `canonical#fragment`, with the fragment percent-encoded as a browser would
/// (the WHATWG fragment set: controls, space, `"`, `<`, `>` and backtick), so a
/// destination that validates URLs keeps the link. The element's `id` stays as
/// authored; browsers decode the same way, so the fragment still matches it.
fn canonical_fragment(canonical_url: &str, fragment: &str) -> String {
    let mut href = format!("{canonical_url}#");
    for character in fragment.chars() {
        if character.is_ascii_control() || matches!(character, ' ' | '"' | '<' | '>' | '`') {
            href.push_str(&format!("%{:02X}", character as u32));
        } else {
            href.push(character);
        }
    }
    href
}

/// Point footnote citations at the note on the canonical article, as heading
/// anchors do, keeping each note's id and number: a copy that drops ids still
/// reaches the cited note. Numbers follow first use, as in the native page.
fn apply_portable_footnotes<'a>(
    events: Vec<Event<'a>>,
    context: PortableContext<'_>,
) -> Vec<Event<'a>> {
    let mut numbers: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    events
        .into_iter()
        .map(|event| {
            let (name, reference) = match &event {
                Event::FootnoteReference(name) => (name.to_string(), true),
                Event::Start(Tag::FootnoteDefinition(name)) => (name.to_string(), false),
                _ => return event,
            };
            let next = numbers.len() + 1;
            let number = *numbers.entry(name.clone()).or_insert(next);
            let html = if reference {
                format!(
                    "<sup class=\"footnote-reference\"><a href=\"{}\">{number}</a></sup>",
                    escape::attr(&canonical_fragment(context.canonical_url, &name))
                )
            } else {
                // A name in the reserved `ob-` namespace is left off as an id;
                // the projection reports it.
                let id = if crate::raw_html::reserved_id(&name) {
                    String::new()
                } else {
                    format!(" id=\"{}\"", escape::attr(&name))
                };
                format!(
                    "<div class=\"footnote-definition\"{id}><sup class=\"footnote-definition-label\">{number}</sup>\n"
                )
            };
            Event::Html(CowStr::from(html))
        })
        .collect()
}

/// Give generated citation notes accessible anchors on the native page: each
/// marker is a `doc-noteref` link with a visually hidden "Citation" before its
/// number and an id of its own, and each note ends with a `doc-backlink` to
/// every place it is cited. The generated heading and notes, which always
/// close the post, are one `doc-endnotes` region named by that heading, and
/// each note can take focus, so following a marker without JavaScript lands
/// keyboard and screen-reader focus on the note it names. The author's own
/// footnotes are written exactly as the HTML writer writes them, with the same
/// numbers (first use), because every footnote in the post shares one
/// numbering.
fn apply_citation_notes<'a>(
    events: Vec<Event<'a>>,
    labels: crate::bibliography::CitationNoteLabels<'_>,
) -> Vec<Event<'a>> {
    let mut uses: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut first_note = None;
    let mut generated_notes = 0;
    for (index, event) in events.iter().enumerate() {
        match event {
            Event::FootnoteReference(name) if labels.number(name).is_some() => {
                *uses.entry(name.to_string()).or_default() += 1;
            }
            Event::Start(Tag::FootnoteDefinition(name)) if labels.number(name).is_some() => {
                first_note.get_or_insert(index);
                generated_notes += 1;
            }
            _ => {}
        }
    }
    let region = first_note.and_then(|first| notes_heading(&events, first));
    let mut notes_closed = 0;
    let mut in_generated_note = false;
    let mut numbers: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut open_note: Option<(String, usize)> = None;
    let mut out = Vec::with_capacity(events.len());
    for (index, event) in events.into_iter().enumerate() {
        if let Some((start, id)) = &region {
            if index == *start {
                out.push(Event::Html(CowStr::from(format!(
                    "<section class=\"ob-citation-notes\" role=\"doc-endnotes\" aria-labelledby=\"{}\">\n",
                    escape::attr(id)
                ))));
            }
        }
        let (name, reference) = match &event {
            Event::FootnoteReference(name) => (name.to_string(), true),
            Event::Start(Tag::FootnoteDefinition(name)) => (name.to_string(), false),
            Event::End(TagEnd::FootnoteDefinition) => {
                out.push(event);
                if std::mem::take(&mut in_generated_note) {
                    notes_closed += 1;
                    if region.is_some() && notes_closed == generated_notes {
                        out.push(Event::Html(CowStr::from("</section>\n")));
                    }
                }
                continue;
            }
            Event::End(TagEnd::Paragraph) => {
                // The note's text is one paragraph; its links back close it.
                if let Some((name, number)) = open_note.take() {
                    let count = uses.get(&name).copied().unwrap_or(0);
                    for occurrence in 1..=count {
                        let which = if count > 1 {
                            format!(" ({occurrence})")
                        } else {
                            String::new()
                        };
                        out.push(Event::Html(CowStr::from(format!(
                            " <a class=\"ob-citation-back\" href=\"#{}-ref-{occurrence}\" role=\"doc-backlink\"><span aria-hidden=\"true\">\u{21a9}\u{fe0e}</span><span class=\"ob-visually-hidden\">{} {number}{which}</span></a>",
                            escape::attr(&name),
                            escape::text(labels.locale.back_words())
                        ))));
                    }
                }
                out.push(event);
                continue;
            }
            _ => {
                out.push(event);
                continue;
            }
        };
        let next = numbers.len() + 1;
        let number = *numbers.entry(name.clone()).or_insert(next);
        let generated = labels.number(&name).is_some();
        let html = match (reference, generated) {
            (true, true) => {
                let occurrence = seen.entry(name.clone()).or_default();
                *occurrence += 1;
                format!(
                    "<sup class=\"footnote-reference ob-citation\"><a href=\"#{name}\" id=\"{name}-ref-{occurrence}\" role=\"doc-noteref\"><span class=\"ob-visually-hidden\">{} </span>{number}</a></sup>",
                    escape::text(labels.locale.citation_word()),
                    name = escape::attr(&name),
                )
            }
            (true, false) => format!(
                "<sup class=\"footnote-reference\"><a href=\"#{}\">{number}</a></sup>",
                escape::attr(&name)
            ),
            (false, generated) => {
                if generated {
                    open_note = Some((name.clone(), number));
                    in_generated_note = true;
                }
                format!(
                    "<div class=\"footnote-definition{}\" id=\"{}\"{}><sup class=\"footnote-definition-label\">{number}</sup>",
                    if generated { " ob-citation-note" } else { "" },
                    escape::attr(&name),
                    if generated { " tabindex=\"-1\"" } else { "" },
                )
            }
        };
        out.push(Event::Html(CowStr::from(html)));
    }
    out
}

/// Where the generated notes' region starts and the id of the heading that
/// names it: the heading that ends straight before the first generated note.
/// `None` (and no region) if the events are not in that shape.
fn notes_heading(events: &[Event<'_>], first_note: usize) -> Option<(usize, String)> {
    if !matches!(
        events.get(first_note.checked_sub(1)?),
        Some(Event::End(TagEnd::Heading(_)))
    ) {
        return None;
    }
    events[..first_note]
        .iter()
        .rposition(|event| matches!(event, Event::Start(Tag::Heading { .. })))
        .and_then(|start| match &events[start] {
            Event::Start(Tag::Heading { id: Some(id), .. }) => Some((start, id.to_string())),
            _ => None,
        })
}

/// A chapter list for a tight bulleted list whose items are all timestamp
/// lines (`- 00:00 Intro`), with the number of events it replaces.
fn chapter_list(events: &[Event<'_>], video_id: Option<&str>) -> Option<(usize, String)> {
    let mut lines = Vec::new();
    let mut item = None;
    for (index, event) in events.iter().enumerate().skip(1) {
        match event {
            Event::Start(Tag::Item) if item.is_none() => item = Some(index + 1),
            Event::End(TagEnd::Item) => lines.push(&events[item.take()?..index]),
            Event::End(TagEnd::List(false)) if item.is_none() => {
                return chapters_html(lines, video_id).map(|html| (index + 1, html));
            }
            // Anything inside an item is checked as a chapter line.
            _ if item.is_some() => {}
            _ => return None,
        }
    }
    None
}

/// A provider link in place of an embedded frame. An authored link keeps its
/// own (already resolved) address and text; bare URLs use the rebuilt address.
fn portable_embed_html(inner: &[Event<'_>], embed: &crate::embed::Embed) -> String {
    let (href, title) = match inner {
        [Event::Start(Tag::Link { dest_url, .. }), middle @ .., Event::End(TagEnd::Link)] => {
            let title: String = middle
                .iter()
                .filter_map(|e| match e {
                    Event::Text(t) | Event::Code(t) => Some(t.as_ref()),
                    _ => None,
                })
                .collect();
            let title = title.trim();
            let authored = !title.is_empty() && title != dest_url.as_ref();
            (dest_url.to_string(), authored.then(|| title.to_string()))
        }
        _ => (embed.link.clone(), None),
    };
    let (label, suffix) = match title {
        Some(title) => (title, format!(" ({})", escape::text(&embed.link_label))),
        None => (embed.link_label.clone(), String::new()),
    };
    format!(
        "<p class=\"ob-embed-link ob-embed-{}\"><a href=\"{}\">{}</a>{suffix}</p>\n",
        embed.provider,
        escape::attr(&href),
        escape::text(&label)
    )
}

/// Seconds for a chapter timestamp (`M:SS` or `H:M:SS`, up to two hour and
/// three minute digits), read as the Admin release kit reads them.
fn chapter_seconds(timestamp: &str) -> Option<u32> {
    let parts: Vec<&str> = timestamp.split(':').collect();
    if !parts
        .iter()
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let value = |part: &str| part.parse::<u32>().ok();
    match parts.as_slice() {
        [minutes, seconds] if minutes.len() <= 3 && seconds.len() == 2 => {
            let (minutes, seconds) = (value(minutes)?, value(seconds)?);
            (seconds < 60).then(|| minutes * 60 + seconds)
        }
        [hours, minutes, seconds]
            if hours.len() <= 2 && minutes.len() <= 3 && seconds.len() == 2 =>
        {
            let (hours, minutes, seconds) = (value(hours)?, value(minutes)?, value(seconds)?);
            (minutes < 60 && seconds < 60).then(|| hours * 3600 + minutes * 60 + seconds)
        }
        _ => None,
    }
}

/// A chapter list when every line (at least two) starts with a timestamp and
/// holds only text, inline code, or emphasis.
fn chapters_html(lines: Vec<&[Event<'_>]>, video_id: Option<&str>) -> Option<String> {
    if lines.len() < 2 {
        return None;
    }
    let mut html = String::from("<ol class=\"ob-chapters\" aria-label=\"Video chapters\">\n");
    for line in lines {
        let mut depth = 0i32;
        for event in line {
            match event {
                Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough) => depth += 1,
                Event::End(TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough) => depth -= 1,
                Event::Text(_) | Event::Code(_) => {}
                _ => return None,
            }
            if depth < 0 {
                return None;
            }
        }
        let (Event::Text(first), rest) = line.split_first()? else {
            return None;
        };
        if depth != 0 {
            return None;
        }
        let (timestamp, label) = first.split_once(char::is_whitespace)?;
        let seconds = chapter_seconds(timestamp)?;
        let label = label.trim_start();
        if label.is_empty() && rest.is_empty() {
            return None;
        }
        let mut label_html = String::new();
        pulldown_cmark::html::push_html(
            &mut label_html,
            std::iter::once(Event::Text(CowStr::from(label.to_string())))
                .chain(rest.iter().cloned()),
        );
        let time = format!("<time datetime=\"PT{seconds}S\">{timestamp}</time>");
        let time = match video_id {
            Some(id) => format!(
                "<a href=\"{}\">{time}</a>",
                escape::attr(&format!(
                    "https://www.youtube.com/watch?v={id}&t={seconds}s"
                ))
            ),
            None => time,
        };
        html.push_str(&format!("<li>{time} {}</li>\n", label_html.trim_end()));
    }
    html.push_str("</ol>\n");
    Some(html)
}

pub(crate) fn parser_options(smart_punctuation: bool) -> Options {
    let mut options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_GFM; // > [!NOTE] callouts
    if smart_punctuation {
        options |= Options::ENABLE_SMART_PUNCTUATION;
    }
    options
}

/// CommonMark reads U+0000 as U+FFFD. For a post with supplements it is
/// replaced before parsing, so a NUL in the text can never look like the tag
/// the renderer uses to mark a supplement. Posts without a NUL are untouched,
/// and posts that have not opted in are never rewritten.
fn without_nul(markdown: &str, supplements: bool) -> std::borrow::Cow<'_, str> {
    if supplements && markdown.contains('\u{0}') {
        std::borrow::Cow::Owned(markdown.replace('\u{0}', "\u{FFFD}"))
    } else {
        std::borrow::Cow::Borrowed(markdown)
    }
}

pub fn render(markdown: &str, options: RenderOptions<'_>) -> Rendered {
    let source = without_nul(markdown, options.supplements);
    let mut parsed_events =
        Parser::new_ext(&source, parser_options(options.smart_punctuation)).collect::<Vec<_>>();
    let mut findings = Vec::new();
    if options.supplements {
        findings = crate::reading_depth::reserve_ids(&mut parsed_events);
        crate::reading_depth::name_headings(&mut parsed_events);
    }
    // Every `atlas:` link and image is made safe before anything reads the
    // events' text, so no id reaches a heading's slug either.
    let marked = crate::concept_links::mark_events(&mut parsed_events, options.concept_links);
    assign_heading_ids(
        &mut parsed_events,
        options.citation_notes.as_ref(),
        options.supplements,
    );
    let refusals = marked.refused;
    let mut rendered = render_events(parsed_events, markdown.len(), options, None, findings);
    rendered.concept_refusals = refusals;
    rendered
}

/// The start of an attributed section's anchor, which no heading id may have
/// (the same text as `attributed_perspective::ANCHOR_PREFIX`).
const RESERVED_ANCHOR_PREFIX: &str = crate::attributed_perspective::ANCHOR_PREFIX;

/// Every start of an anchor the build itself writes on a post's page, which no
/// heading id may have: attributed sections (ADR 0126) and the research-context
/// section and its items (ADR 0197). Local to this function by design.
const RESERVED_ANCHOR_PREFIXES: [&str; 3] = [
    RESERVED_ANCHOR_PREFIX,
    crate::curated_context::ANCHOR_PREFIX,
    crate::curated_context::SECTION_ID,
];

fn reserved_anchor(id: &str) -> bool {
    RESERVED_ANCHOR_PREFIXES
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

/// Give every heading its id: the `{#id}` the author wrote, or a slug of its
/// text made unique among the post's slugs. Written ids are not consulted, so
/// existing native anchors keep their targets; the portable projection makes
/// its own copy's ids unique. Done before rendering so the portable projection
/// knows every heading anchor before it checks raw HTML ids.
///
/// The author's headings get exactly these ids whether or not the post
/// publishes citations, so turning citations on never moves an inbound link.
/// Only the generated notes heading (`notes`), which always closes the post
/// and names the notes' region, must be the only element with its id: it
/// alone also avoids the ids the post's own markup writes ([`written_ids`]:
/// `{#id}` values, footnote labels and raw HTML `id`s).
fn assign_heading_ids(
    events: &mut [Event<'_>],
    notes: Option<&crate::bibliography::CitationNoteLabels<'_>>,
    supplements: bool,
) {
    let notes_start = notes.and_then(|labels| generated_notes_heading(events, labels));
    let written = if notes_start.is_some() {
        written_ids(events)
    } else {
        std::collections::HashSet::new()
    };
    // The one hint element a post's concept links inside headings describe
    // themselves with (ADR 0173) owns its id: no heading takes it.
    let mut used_ids: std::collections::HashSet<String> =
        std::iter::once(crate::concept_links::HEADING_HINT_ID.to_string()).collect();
    let mut heading: Option<(usize, String)> = None;
    for index in 0..events.len() {
        match &events[index] {
            Event::Start(Tag::Heading { .. }) => heading = Some((index, String::new())),
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, title)) = heading.as_mut() {
                    title.push_str(t);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, title)) = heading.as_mut() {
                    title.push(' ');
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                let Some((start, title)) = heading.take() else {
                    continue;
                };
                // A heading written inside a supplement already has the id
                // that names it (ADR 0142); it takes no slug from the post's.
                if supplements
                    && matches!(
                        &events[start],
                        Event::Start(Tag::Heading { id: Some(id), .. })
                            if id.starts_with(crate::reading_depth::ID_PREFIX)
                    )
                {
                    continue;
                }
                let mut id = slugify(&title);
                if id.is_empty() {
                    id = "section".to_string();
                }
                // `ob-supplement-` names the supplements' own ids only, for a
                // post that has them; any other post's slugs are as they were.
                if supplements && id.starts_with(crate::reading_depth::ID_PREFIX) {
                    id = format!("section-{id}");
                }
                // `ob-by-` belongs to attributed sections (ADR 0126). A
                // heading whose text begins "OB by" must not take it.
                if reserved_anchor(&id) {
                    id = format!("heading-{id}");
                }
                let Event::Start(Tag::Heading { id: existing, .. }) = &mut events[start] else {
                    continue;
                };
                // A heading with a written id still takes its slug, as it
                // always has, so the slugs after it keep their values.
                let generated = existing.is_none();
                let avoid_written = generated && notes_start == Some(start);
                let base = id.clone();
                let mut n = 2;
                while (avoid_written && written.contains(&id)) || !used_ids.insert(id.clone()) {
                    id = format!("{base}-{n}");
                    n += 1;
                }
                // An id the author wrote in the reserved space is replaced by
                // the heading's own slug: only a section's real author may
                // own an `ob-by-` anchor.
                let reserved = existing.as_deref().is_some_and(|written| {
                    reserved_anchor(written) || written == crate::concept_links::HEADING_HINT_ID
                });
                if generated || reserved {
                    *existing = Some(CowStr::from(id));
                }
            }
            _ => {}
        }
    }
}

/// Where the generated notes heading starts: the heading that ends straight
/// before the first generated note, as [`notes_heading`] finds it once ids
/// are assigned.
fn generated_notes_heading(
    events: &[Event<'_>],
    labels: &crate::bibliography::CitationNoteLabels<'_>,
) -> Option<usize> {
    let first_note = events.iter().position(|event| {
        matches!(event, Event::Start(Tag::FootnoteDefinition(name)) if labels.number(name).is_some())
    })?;
    if !matches!(
        events.get(first_note.checked_sub(1)?),
        Some(Event::End(TagEnd::Heading(_)))
    ) {
        return None;
    }
    events[..first_note]
        .iter()
        .rposition(|event| matches!(event, Event::Start(Tag::Heading { .. })))
}

/// Where the claim evidence section starts: the last level-two heading that
/// reads exactly "Claims and evidence", which `claim_publication::check_section`
/// has already confirmed is the composed section's.
fn claim_section_heading(events: &[Event<'_>]) -> Option<usize> {
    events.windows(3).rposition(|window| {
        matches!(
            window,
            [
                Event::Start(Tag::Heading {
                    level: HeadingLevel::H2,
                    ..
                }),
                Event::Text(title),
                Event::End(TagEnd::Heading(HeadingLevel::H2)),
            ] if title.as_ref() == crate::claim_publication::SECTION_HEADING
        )
    })
}

/// The element ids a post's own markup writes: each heading's `{#id}`, each
/// footnote definition's label (its note's id) and each `id` attribute found
/// in raw HTML, read as a browser reads it ([`crate::raw_html::id_attributes`]).
/// Consecutive raw HTML fragments are read together, so a tag that spans
/// lines still counts.
fn written_ids(events: &[Event<'_>]) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    let mut raw = String::new();
    for event in events {
        match event {
            Event::Html(html) | Event::InlineHtml(html) => {
                raw.push_str(html);
                continue;
            }
            Event::Start(Tag::Heading { id: Some(id), .. })
            | Event::Start(Tag::FootnoteDefinition(id)) => {
                ids.insert(id.to_string());
            }
            _ => {}
        }
        ids.extend(
            crate::raw_html::id_attributes(&std::mem::take(&mut raw))
                .into_iter()
                .map(|(_, id)| id),
        );
    }
    ids.extend(
        crate::raw_html::id_attributes(&raw)
            .into_iter()
            .map(|(_, id)| id),
    );
    ids
}

/// For a post that opted in to reading modes, the renames [`render`] makes
/// before it assigns heading ids: ids that belong to the supplements are
/// freed and supplement headings are named. Everything that reads heading
/// ids outside the renderer runs the same steps, so its ids are the page's.
fn reserve_supplement_ids(events: &mut [Event<'_>], supplements: bool) {
    if supplements {
        crate::reading_depth::reserve_ids(events);
        crate::reading_depth::name_headings(events);
    }
}

/// Every heading id the author's Markdown gets, as [`render`] assigns them
/// with or without citations: the author's `{#id}` values and the generated
/// slugs. `supplements` is whether the post opted in to reading modes.
pub(crate) fn heading_ids(markdown: &str, supplements: bool) -> Vec<String> {
    let source = without_nul(markdown, supplements);
    let mut events = Parser::new_ext(&source, parser_options(false)).collect::<Vec<_>>();
    reserve_supplement_ids(&mut events, supplements);
    crate::concept_links::mark_events(&mut events, false);
    assign_heading_ids(&mut events, None, supplements);
    events
        .into_iter()
        .filter_map(|event| match event {
            Event::Start(Tag::Heading { id: Some(id), .. }) => Some(id.to_string()),
            _ => None,
        })
        .collect()
}

/// The passage text of a publication body (ADR 0076), section by section:
/// the text before the first heading (no anchor), then each heading's id
/// with its title and the text up to the next heading of any level. Text is
/// read from the same events and with the same heading ids as [`render`],
/// so it is the text the native page shows, without what the page generates
/// around it: footnote and citation markers, image alternative text, raw
/// HTML, code blocks and the generated citation notes region. Whitespace is
/// not yet collapsed; [`crate::passage_target`] does that. With `embeds`
/// on, a paragraph that is only an embeddable link is left out, as
/// [`apply_embeds`] replaces it with a frame that has no prose.
pub(crate) fn passage_sections(
    markdown: &str,
    smart_punctuation: bool,
    embeds: bool,
    notes: Option<&crate::bibliography::CitationNoteLabels<'_>>,
    supplements: bool,
) -> Vec<(Option<String>, String)> {
    let source = without_nul(markdown, supplements);
    let mut events =
        Parser::new_ext(&source, parser_options(smart_punctuation)).collect::<Vec<_>>();
    reserve_supplement_ids(&mut events, supplements);
    crate::concept_links::mark_events(&mut events, false);
    assign_heading_ids(&mut events, notes, supplements);
    let notes_start = notes.and_then(|labels| generated_notes_heading(&events, labels));
    let mut sections: Vec<(Option<String>, String)> = vec![(None, String::new())];
    let mut in_code_block = false;
    let mut images = 0usize;
    let mut index = 0;
    while index < events.len() {
        let event = &events[index];
        let position = index;
        index += 1;
        if notes_start == Some(position) {
            break;
        }
        if embeds && matches!(event, Event::Start(Tag::Paragraph)) {
            if let Some(len) = events[index..]
                .iter()
                .position(|e| matches!(e, Event::End(TagEnd::Paragraph)))
            {
                if standalone_embed(&events[index..index + len]).is_some() {
                    index += len + 1;
                    continue;
                }
            }
        }
        if let Event::Start(Tag::Heading { id, .. }) = event {
            sections.push((id.as_ref().map(|id| id.to_string()), String::new()));
            continue;
        }
        let text = &mut sections
            .last_mut()
            .expect("the lead section is always there")
            .1;
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Image { .. }) => images += 1,
            Event::End(TagEnd::Image) => images = images.saturating_sub(1),
            Event::Text(t) | Event::Code(t) if !in_code_block && images == 0 => text.push_str(t),
            Event::SoftBreak | Event::HardBreak => text.push(' '),
            Event::End(
                TagEnd::Heading(_)
                | TagEnd::Paragraph
                | TagEnd::Item
                | TagEnd::TableCell
                | TagEnd::BlockQuote(_)
                | TagEnd::FootnoteDefinition,
            ) => text.push(' '),
            _ => {}
        }
    }
    sections
}

pub fn render_portable(
    markdown: &str,
    options: RenderOptions<'_>,
    projection: &crate::portability::PortableProjection<'_>,
) -> Result<Rendered, String> {
    let source = without_nul(markdown, options.supplements);
    let mut parsed_events =
        Parser::new_ext(&source, parser_options(options.smart_punctuation)).collect::<Vec<_>>();
    let mut findings = Vec::new();
    if options.supplements {
        findings = crate::reading_depth::reserve_ids(&mut parsed_events);
        crate::reading_depth::name_headings(&mut parsed_events);
    }
    crate::concept_links::mark_events(&mut parsed_events, false);
    assign_heading_ids(&mut parsed_events, None, options.supplements);
    // A `compare` fence names its pictures in text, so they are resolved here like image links.
    let mut compare_images = Vec::new();
    let mut in_compare = false;
    for event in &mut parsed_events {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if info.trim() == crate::compare::FENCE =>
            {
                in_compare = true;
            }
            Event::End(TagEnd::CodeBlock) => in_compare = false,
            Event::Text(source) if in_compare => {
                let mapped = crate::compare::map_sources(source, |address| {
                    let resolved = projection
                        .resolve_link(address)
                        .unwrap_or_else(|_| address.to_string());
                    compare_images.push(resolved.clone());
                    resolved
                });
                *source = CowStr::from(mapped);
            }
            _ => {}
        }
    }
    for event in &mut parsed_events {
        let destination = match event {
            Event::Start(Tag::Link { dest_url, .. })
            | Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url),
            _ => None,
        };
        if let Some(destination) = destination {
            *destination = CowStr::from(projection.resolve_link(destination)?);
        }
    }
    let sanitized = crate::raw_html::sanitize(parsed_events, projection)?;
    let mut rendered = render_events(
        sanitized.events,
        markdown.len(),
        options,
        Some(projection.markdown_context()),
        findings,
    );
    // Recipe sections are added after raw HTML is balanced inside its own
    // containers, so the finished body is balanced once more as a whole.
    rendered.html = crate::raw_html::balance(&rendered.html);
    rendered.capabilities.extend(sanitized.capability);
    rendered.portable_images = sanitized.images;
    rendered.portable_images.extend(
        compare_images
            .into_iter()
            .filter(|url| url.starts_with("http"))
            .map(|url| crate::portability::PortableImage {
                url,
                raw_html: false,
            }),
    );
    rendered.portable_has_raw_html = sanitized.has_raw_html;
    Ok(rendered)
}

pub(crate) fn portable_semantic_facts(
    markdown: &str,
    options: RenderOptions<'_>,
    projection: &crate::portability::PortableProjection<'_>,
) -> Result<Vec<crate::portability::SemanticFact>, String> {
    use crate::portability::SemanticFact;
    let source = without_nul(markdown, options.supplements);
    let events = Parser::new_ext(&source, parser_options(options.smart_punctuation));
    let mut sanitized = crate::raw_html::sanitize(events.collect(), projection)?;
    if options.supplements {
        crate::reading_depth::reserve_ids(&mut sanitized.events);
        // The marker line is replaced by a label in the HTML and kept as
        // written in Markdown, so it is not a fact either must carry.
        sanitized.events = crate::reading_depth::transform(sanitized.events, false).events;
    }
    let mut facts = Vec::new();
    let mut semantic_events = Vec::new();
    let mut index = 0;
    while index < sanitized.events.len() {
        if matches!(sanitized.events[index], Event::Start(Tag::Paragraph)) {
            if let Some(length) = sanitized.events[index + 1..]
                .iter()
                .position(|event| matches!(event, Event::End(TagEnd::Paragraph)))
            {
                let inner = &sanitized.events[index + 1..index + 1 + length];
                if inner.iter().all(|event| matches!(event, Event::Text(_))) {
                    if let Some(embed) = standalone_embed(inner) {
                        facts.push(
                            SemanticFact::new("media", "source link", embed.link)
                                .with_link_label(embed.link_label),
                        );
                        index += length + 2;
                        continue;
                    }
                }
            }
        }
        semantic_events.push(sanitized.events[index].clone());
        index += 1;
    }
    for (index, event) in semantic_events.iter().enumerate() {
        let (destination, end) = match event {
            Event::Start(Tag::Link { dest_url, .. }) => (dest_url, TagEnd::Link),
            Event::Start(Tag::Image { dest_url, .. }) => (dest_url, TagEnd::Image),
            _ => continue,
        };
        let mut label = String::new();
        let mut text_label = String::new();
        let mut image = None;
        for inner in semantic_events[index + 1..]
            .iter()
            .take_while(|event| **event != Event::End(end))
        {
            match inner {
                Event::Text(text) | Event::Code(text) => {
                    label.push_str(text);
                    text_label.push_str(text);
                }
                Event::SoftBreak | Event::HardBreak => {
                    label.push(' ');
                    text_label.push(' ');
                }
                Event::Start(Tag::Image { dest_url, .. }) => {
                    image = Some((text_label.len(), projection.resolve_link(dest_url)?));
                }
                Event::End(TagEnd::Image) => {
                    if let Some((start, destination)) = image.take() {
                        if text_label[start..].trim() != destination {
                            text_label.push_str(&format!(" ({destination})"));
                        }
                    }
                }
                _ => {}
            }
        }
        let mut fact = SemanticFact::new(
            "content",
            "link or media target",
            projection.resolve_link(destination)?,
        )
        .with_link_label(label.clone())
        .with_text_link_label(text_label)
        .with_link_kind(if end == TagEnd::Image {
            crate::portability::SemanticLinkKind::Image
        } else {
            crate::portability::SemanticLinkKind::Anchor
        });
        if label == destination.as_ref()
            && index > 0
            && matches!(semantic_events[index - 1], Event::Start(Tag::Paragraph))
        {
            if let Some(length) = semantic_events[index..]
                .iter()
                .position(|event| *event == Event::End(TagEnd::Paragraph))
            {
                if let Some(embed) = standalone_embed(&semantic_events[index..index + length]) {
                    fact = fact.with_html_link_label(embed.link_label);
                }
            }
        }
        facts.push(fact);
    }
    let mut code: Option<(String, String)> = None;
    for event in semantic_events {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let info = match kind {
                    CodeBlockKind::Fenced(info) => info.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((info, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                let Some((info, source)) = code.take() else {
                    continue;
                };
                if source.trim().is_empty() {
                    continue;
                }
                if info.split_whitespace().next() == Some("piece") {
                    // A piece is plain content: its names and labels must
                    // survive export; its frames degrade to links.
                    let kind = info.split_whitespace().nth(1).unwrap_or("");
                    if let Ok(piece) = crate::piece::Piece::from_directive(kind, &source) {
                        for text in piece.visible_text() {
                            facts.push(SemanticFact::new("content", "text", text));
                        }
                    }
                    continue;
                }
                if info.trim() == crate::compare::FENCE {
                    // Both captions must survive export; the pictures travel as images.
                    if let Ok(pair) = crate::compare::parse(&source) {
                        for text in pair.visible_text() {
                            facts.push(SemanticFact::new("content", "text", text));
                        }
                    }
                    continue;
                }
                let fence = parse_fence_info(&info);
                if info.trim() == "quiz" {
                    let quiz = parse_quiz(&source)?;
                    for (field, value) in std::iter::once(("prompt", quiz.prompt.as_str()))
                        .chain(
                            quiz.choices
                                .iter()
                                .map(|choice| ("choice", choice.text.as_str())),
                        )
                        .chain(
                            quiz.explanation
                                .as_deref()
                                .map(|value| ("explanation", value)),
                        )
                    {
                        facts.push(SemanticFact::new(
                            "knowledge-check",
                            field,
                            crate::raw_html::semantic_content(&quiz_inline(value)?),
                        ));
                    }
                    facts.push(SemanticFact::new(
                        "knowledge-check",
                        "answer label",
                        "Answer:",
                    ));
                    let (index, answer) = quiz
                        .choices
                        .iter()
                        .enumerate()
                        .find(|(_, choice)| choice.correct)
                        .unwrap();
                    let answer = crate::raw_html::semantic_content(&quiz_inline(&answer.text)?);
                    facts.push(
                        SemanticFact::new(
                            "knowledge-check",
                            "answer",
                            format!("Answer: {}. {answer}", char::from(b'A' + index as u8)),
                        )
                        .with_markdown_value(format!("Answer: {}. {answer}", index + 1)),
                    );
                } else if fence.runnable && fence.lang.eq_ignore_ascii_case("web") {
                    for line in source.lines() {
                        let label = match line.trim() {
                            "---html" => Some("HTML"),
                            "---css" => Some("CSS"),
                            "---js" => Some("JavaScript"),
                            _ => None,
                        };
                        facts.push(SemanticFact::new(
                            "web-sandbox",
                            if label.is_some() {
                                "source label"
                            } else {
                                "source"
                            },
                            label.unwrap_or(line),
                        ));
                    }
                } else if fence.lang == "demo" {
                    // The fallback is plain Markdown and is rendered without smart punctuation,
                    // so its text, the label and the canonical link must all survive export.
                    let (kind, markdown) = portable_demo_parts(&fence, &source)?;
                    for event in Parser::new_ext(&markdown, parser_options(false)) {
                        if let Event::Text(text) | Event::Code(text) = event {
                            facts.push(SemanticFact::new("content", "text", text.to_string()));
                        }
                    }
                    facts.push(SemanticFact::new(
                        "interactive-demo",
                        "capability label",
                        kind.label,
                    ));
                    facts.push(SemanticFact::new(
                        "interactive-demo",
                        "canonical link",
                        projection.canonical_url(),
                    ));
                } else if fence.check {
                    // The export carries the starter as the code and the checks as a spoiler.
                    let (starter, checks) = split_rust_checks(&source);
                    facts.push(SemanticFact::new(
                        "runnable-code",
                        "source",
                        starter.to_string(),
                    ));
                    if let Some(checks) = checks {
                        facts.push(SemanticFact::new(
                            "runnable-code",
                            "spoiler checks",
                            checks.trim_end().to_string(),
                        ));
                    }
                } else {
                    facts.push(SemanticFact::new("runnable-code", "source", source));
                }
                if let Some(title) = fence.title {
                    let capability = if fence.lang == "demo" {
                        "interactive-demo"
                    } else {
                        "runnable-code"
                    };
                    facts.push(SemanticFact::new(capability, "title", title));
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, source)) = &mut code {
                    source.push_str(&text);
                } else if let Some(url) = text
                    .trim()
                    .strip_prefix("%[")
                    .and_then(|s| s.strip_suffix(']'))
                {
                    facts.push(SemanticFact::new(
                        "media",
                        "source link",
                        projection.resolve_link(url)?,
                    ));
                } else {
                    facts.push(SemanticFact::new("content", "text", text.to_string()));
                }
            }
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                facts.push(SemanticFact::new("callout", "label", callout_label(kind).1));
            }
            Event::FootnoteReference(label) => {
                facts.push(
                    SemanticFact::new(
                        "references",
                        "citation target",
                        projection.resolve_link(&format!("#{label}"))?,
                    )
                    .with_markdown_value(label.to_string()),
                );
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                facts.push(SemanticFact::new(
                    "raw-html",
                    "retained content",
                    crate::raw_html::semantic_content(&html),
                ));
            }
            _ => {}
        }
    }
    Ok(facts)
}

fn render_events<'a>(
    parsed_events: Vec<Event<'a>>,
    source_length: usize,
    options: RenderOptions<'_>,
    portable: Option<PortableContext<'_>>,
    id_findings: Vec<crate::reading_depth::Finding>,
) -> Rendered {
    let (parsed_events, inside_supplement, reading_depth) = if options.supplements {
        let transformed = crate::reading_depth::transform(parsed_events, true);
        let mut depth = transformed.depth;
        // Renamed ids come first, within the findings' limit.
        depth.findings.splice(0..0, id_findings);
        depth.findings.truncate(crate::reading_depth::MAX_FINDINGS);
        (transformed.events, transformed.inside, Some(depth))
    } else {
        (parsed_events, Vec::new(), None)
    };
    // The post's own words, built with every push `text` gets except the
    // words of a supplement (ADR 0140). Only a post with supplements keeps it.
    let mut own = options.supplements.then(String::new);
    let mut own_end = None;
    // Per open block quote: the supplement it is, for its end marker.
    let mut quote_supplements: Vec<Option<usize>> = Vec::new();
    // Footnote labels cited inside a supplement, and the supplements citing.
    let mut cited_in: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    let mut cited_outside: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut events: Vec<Event> = Vec::new();
    let mut headings = Vec::new();
    let mut text = String::new();
    let mut code_languages: Vec<String> = Vec::new();
    let mut first_image = None;

    let mut in_code_block = false;
    let mut heading: Option<(HeadingLevel, usize, String)> = None;
    // Where the generated notes begin, and the text before them. A marker
    // removed from the text takes the space before it when punctuation follows.
    let notes_start = match (portable, options.citation_notes.as_ref()) {
        (None, Some(labels)) => generated_notes_heading(&parsed_events, labels),
        _ => None,
    };
    // The claim evidence section comes before any notes, and ends the prose
    // too: it records the author's reading, not the post's own words.
    let claims_start = match portable {
        None if options.claim_evidence_section => claim_section_heading(&parsed_events),
        _ => None,
    };
    let mut prose_end = None;
    let mut after_marker = false;

    // Spacing goes to both texts; a word goes to the post's own only outside
    // a supplement.
    macro_rules! space {
        ($($piece:expr),+) => {{
            $(text.push_str($piece);
            if let Some(own) = own.as_mut() {
                own.push_str($piece);
            })+
        }};
    }

    for (index, event) in parsed_events.into_iter().enumerate() {
        if notes_start == Some(index) || claims_start == Some(index) {
            prose_end.get_or_insert(text.len());
            if let Some(own) = &own {
                own_end.get_or_insert(own.len());
            }
        }
        let followed_marker = std::mem::take(&mut after_marker);
        let inside = inside_supplement.get(index).copied().unwrap_or(false);
        if let Event::FootnoteReference(name) = &event {
            if inside {
                let holder = quote_supplements.iter().rev().flatten().next().copied();
                if let Some(holder) = holder {
                    let held = cited_in.entry(name.to_string()).or_default();
                    if !held.contains(&holder) {
                        held.push(holder);
                    }
                }
            } else {
                cited_outside.insert(name.to_string());
            }
        }
        match &event {
            Event::Start(Tag::BlockQuote(_)) => quote_supplements.push(None),
            Event::Html(html) if reading_depth.is_some() => {
                // The tag [`reading_depth::transform`] left on a supplement's
                // quote: its boundary words go in the page's text, so a text
                // copy shows where it starts and stops.
                let ordinal = crate::reading_depth::sentinel_ordinal(html);
                if let (Some(ordinal), Some(depth)) = (ordinal, reading_depth.as_ref()) {
                    if let (Some(slot), Some(supplement)) = (
                        quote_supplements.last_mut(),
                        depth.supplements.get(ordinal.wrapping_sub(1)),
                    ) {
                        *slot = Some(ordinal - 1);
                        text.push_str(&crate::reading_depth::start_words(supplement));
                        space!(" ");
                    }
                }
            }
            _ => {}
        }
        match &event {
            Event::FootnoteReference(name)
                if options
                    .citation_notes
                    .as_ref()
                    .is_some_and(|labels| labels.number(name).is_some()) =>
            {
                after_marker = true;
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code_block = true;
                if let CodeBlockKind::Fenced(info) = kind {
                    let lang = parse_fence_info(info).lang;
                    if !lang.is_empty()
                        && info.trim() != "quiz"
                        && info.trim() != crate::compare::FENCE
                        && !code_languages.contains(&lang)
                    {
                        code_languages.push(lang);
                    }
                }
            }
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Image { dest_url, .. }) => {
                if first_image.is_none() {
                    first_image = Some(dest_url.to_string());
                }
            }
            // A heading inside a supplement is a heading, but not an entry of
            // the outline (ADR 0142).
            Event::Start(Tag::Heading { level, .. }) if !inside => {
                heading = Some((*level, events.len(), String::new()));
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, _, buf)) = heading.as_mut() {
                    buf.push_str(t);
                }
                if !in_code_block {
                    if followed_marker
                        && t.starts_with(|c: char| ",.;:!?)]}\u{2019}\u{201d}".contains(c))
                    {
                        text.truncate(text.trim_end_matches(' ').len());
                        if let (Some(own), false) = (own.as_mut(), inside) {
                            own.truncate(own.trim_end_matches(' ').len());
                        }
                    }
                    text.push_str(t);
                    if let (Some(own), false) = (own.as_mut(), inside) {
                        own.push_str(t);
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, _, buf)) = heading.as_mut() {
                    buf.push(' ');
                }
                space!(" ");
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                if let Some(Some(held)) = quote_supplements.pop() {
                    if let Some(supplement) = reading_depth
                        .as_ref()
                        .and_then(|depth| depth.supplements.get(held))
                    {
                        space!(" ");
                        text.push_str(&crate::reading_depth::end_words(supplement));
                    }
                }
                space!(" ");
            }
            Event::End(TagEnd::Paragraph)
            | Event::End(TagEnd::Item)
            | Event::End(TagEnd::TableCell) => space!(" "),
            _ => {}
        }

        if let (Event::End(TagEnd::Heading(_)), true) = (&event, inside) {
            space!(" ");
        } else if let Event::End(TagEnd::Heading(_)) = &event {
            if let Some((level, start_index, title)) = heading.take() {
                let id = match &events[start_index] {
                    Event::Start(Tag::Heading { id: Some(id), .. }) => id.to_string(),
                    _ => "section".to_string(),
                };
                let level_num = heading_level(level);
                if options.heading_anchors && level_num >= 2 {
                    let href = portable
                        .map(|context| canonical_fragment(context.canonical_url, &id))
                        .unwrap_or_else(|| format!("#{id}"));
                    let anchor = format!(
                        "<a class=\"ob-heading-anchor\" href=\"{}\" aria-label=\"Link to this section\">#</a>",
                        crate::escape::attr(&href)
                    );
                    events.push(Event::Html(CowStr::from(anchor)));
                }
                headings.push(Heading {
                    level: level_num,
                    id,
                    text: title.trim().to_string(),
                });
                space!(" ");
            }
        }

        events.push(event);
    }

    let mut portable_video_ids = Vec::new();
    let events = if let Some(context) = portable {
        apply_portable_footnotes(
            apply_portable_paragraphs(events, context, &mut portable_video_ids),
            context,
        )
    } else if options.embeds {
        apply_embeds(events)
    } else {
        events
    };
    let (events, blocks) = transform_blocks(
        events,
        options.recipe,
        options.code_runner,
        options.web_libraries,
        options.playground_link,
        portable,
    );
    // After block transforms, which track footnote containers by their events.
    let events = match (portable, options.citation_notes) {
        (None, Some(labels)) => apply_citation_notes(events, labels),
        _ => events,
    };
    // Last, so every transform above saw each supplement as the quote it is.
    let events = match &reading_depth {
        Some(depth) => crate::reading_depth::wrap(events, depth),
        None => events,
    };
    let mut html = String::with_capacity(source_length * 2);
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    if portable.is_none() {
        // A note cited only inside supplements says which, so the page can
        // show a supplement a reader navigates into (ADR 0142).
        let mut notes: Vec<_> = cited_in
            .iter()
            .filter(|(name, _)| !cited_outside.contains(*name))
            .collect();
        notes.sort();
        for (name, holders) in notes {
            let ids = holders
                .iter()
                .filter_map(|holder| reading_depth.as_ref()?.supplements.get(*holder))
                .map(|supplement| supplement.id.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let name = escape::attr(name);
            for class in [
                "footnote-definition ob-citation-note",
                "footnote-definition",
            ] {
                let opening = format!("<div class=\"{class}\" id=\"{name}\"");
                if html.contains(&opening) {
                    html = html.replacen(
                        &opening,
                        &format!("{opening} data-ob-supplement=\"{ids}\""),
                        1,
                    );
                    break;
                }
            }
        }
    }
    let mut html = restore_bracketed_hosts(html);
    if options.lazy_images {
        html = html.replace("<img src=", "<img loading=\"lazy\" decoding=\"async\" src=");
    }

    // Supplements are not the post's own words: they stay in the search text
    // but not in the description, word count or reading time.
    let prose = match &own {
        Some(own) => collapse_whitespace(&own[..own_end.unwrap_or(own.len())]),
        None => collapse_whitespace(&text[..prose_end.unwrap_or(text.len())]),
    };
    let text = collapse_whitespace(&text);
    let mut capabilities = blocks.capabilities;
    if reading_depth
        .as_ref()
        .is_some_and(|depth| !depth.is_empty())
    {
        capabilities.push(CapabilityDescriptor::describe(
            crate::reading_depth::CAPABILITY_ID,
            None,
        ));
    }
    let word_count = prose.split_whitespace().count();
    Rendered {
        html,
        portable_images: Vec::new(),
        portable_has_raw_html: false,
        portable_video_ids,
        capabilities,
        errors: blocks.errors,
        headings,
        text,
        prose,
        word_count,
        code_languages,
        first_image,
        recipe_ingredients: blocks.ingredients,
        recipe_steps: blocks.steps,
        recipe_anchor: blocks.recipe_anchor,
        reading_depth,
        concept_refusals: Vec::new(),
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_space = true;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// Estimated reading time in whole minutes, never less than one.
pub fn reading_minutes(word_count: usize) -> u32 {
    ((word_count as f64 / 225.0).ceil() as u32).max(1)
}

/// The first `max_chars` of plain text, cut at a word boundary with an ellipsis.
pub fn excerpt(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut cut = String::new();
    for word in text.split(' ') {
        if cut.chars().count() + word.chars().count() + 1 > max_chars {
            break;
        }
        if !cut.is_empty() {
            cut.push(' ');
        }
        cut.push_str(word);
    }
    let trimmed = cut.trim_end_matches(['.', ',', ';', ':', '-']);
    format!("{trimmed}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_headings_with_ids_and_anchors() {
        let r = render(
            "# Title\n\n## Hello World\n\ntext\n\n## Hello World\n",
            RenderOptions::default(),
        );
        assert!(r.html.contains("<h2 id=\"hello-world\">"));
        assert!(r.html.contains("<h2 id=\"hello-world-2\">"));
        assert!(r.html.contains("ob-heading-anchor"));
        assert_eq!(r.headings.len(), 3);
        assert_eq!(r.headings[1].level, 2);
        assert_eq!(r.text, "Title Hello World text Hello World");
    }

    #[test]
    fn collects_code_languages_and_skips_code_text() {
        let r = render(
            "Intro\n\n```rust\nfn main() {}\n```\n\n```js\nlet x\n```\n",
            RenderOptions::default(),
        );
        assert_eq!(r.code_languages, vec!["rust", "js"]);
        assert_eq!(r.text, "Intro");
        assert!(r.html.contains("<pre><code class=\"language-rust\">"));
        assert!(r.capabilities.is_empty());
    }

    #[test]
    fn web_runnable_fences_render_as_progressively_enhanced_sandboxes() {
        let source = "```web runnable title=\"Try it\"\n---html\n<button>Hi</button>\n---css\nbutton { color: red; }\n---js\nconsole.log('hi');\n```\n";
        let rendered = render(source, RenderOptions::default());
        assert!(rendered.html.contains("<ob-web-sandbox>"));
        assert!(rendered.html.contains("data-runnable=\"web\""));
        assert!(rendered.html.contains("&lt;button&gt;Hi&lt;/button&gt;"));
        assert!(rendered.html.contains("</ob-web-sandbox></figure>"));
        assert_eq!(rendered.capabilities.len(), 1);
        assert_eq!(rendered.capabilities[0].id, "web-sandbox");
        assert_eq!(
            rendered.capabilities[0].native_renderer,
            Some("ob-web-sandbox")
        );
    }

    #[test]
    fn web_runnable_options_mark_the_sandbox_and_preload_site_libraries() {
        let libraries = BTreeMap::from([(
            "react".to_string(),
            vec![
                "/vendor/react.min.js".to_string(),
                "/vendor/react-dom.min.js".to_string(),
            ],
        )]);
        let options = RenderOptions {
            web_libraries: Some(&libraries),
            ..RenderOptions::default()
        };
        let source = "```web runnable module network images libs=React title=\"Try it\"\n---js\nawait Promise.resolve();\n```\n";
        let rendered = render(source, options);
        assert!(rendered.errors.is_empty(), "{:?}", rendered.errors);
        assert!(
            rendered
                .html
                .contains("<ob-web-sandbox data-module data-network data-images>"),
            "{}",
            rendered.html
        );
        let first = rendered
            .html
            .find("href=\"/vendor/react.min.js\" data-ob-web-lib=\"react\"")
            .expect("first library file");
        let second = rendered
            .html
            .find("href=\"/vendor/react-dom.min.js\" data-ob-web-lib=\"react\"")
            .expect("second library file");
        assert!(first < second, "library files keep their configured order");
        assert!(rendered
            .html
            .contains("<figcaption class=\"ob-code-title\">Try it</figcaption>"));

        let plain = render(
            "```web runnable\n---html\n<p>Hi</p>\n```\n",
            RenderOptions::default(),
        );
        assert!(
            plain.html.contains("<ob-web-sandbox><pre>"),
            "{}",
            plain.html
        );
    }

    #[test]
    fn rust_check_fences_split_the_starter_from_the_hidden_checks() {
        let source = "```rust runnable check title=\"Add them\"\nfn add(a: u32, b: u32) -> u32 {\n    // TODO <fill in> & \"go\"\n    0\n}\n---checks\n/// Add them together.\n#[test]\nfn adds() {\n    assert_eq!(add(2, 3), 5); // </script>\n}\n```\n";
        let rendered = render(source, RenderOptions::default());
        assert!(rendered.errors.is_empty(), "{:?}", rendered.errors);
        let html = &rendered.html;
        // The editor sees the starter, escaped, and none of the checks.
        let pre = &html[html.find("<pre>").unwrap()..html.find("</pre>").unwrap()];
        assert!(
            pre.contains("// TODO &lt;fill in&gt; &amp; \"go\""),
            "{pre}"
        );
        assert!(!pre.contains("assert_eq"), "{pre}");
        assert!(!pre.contains("---checks"), "{pre}");
        // The checks ride along as JSON that cannot close its own script element.
        let script_start = html
            .find("<script type=\"application/json\" data-ob-rust-checks>")
            .unwrap();
        let json =
            &html[script_start + "<script type=\"application/json\" data-ob-rust-checks>".len()..];
        let json = &json[..json.find("</script>").unwrap()];
        assert!(!json.contains('<'), "{json}");
        let checks: String = serde_json::from_str(json).unwrap();
        assert!(checks.contains("fn adds()") && checks.contains("</script>"));
        assert!(
            html.contains("<ob-rust-playground>") && html.trim_end().ends_with("</figure>"),
            "{html}"
        );
        // It is still an ordinary runnable-code capability.
        assert_eq!(rendered.capabilities[0].id, "runnable-code");
    }

    #[test]
    fn rust_check_fences_report_what_is_missing() {
        for (source, expected) in [
            (
                "```rust runnable check\nfn a() {}\n```\n",
                "needs a `---checks` line",
            ),
            (
                "```rust runnable check\n---checks\n#[test]\nfn t() {}\n```\n",
                "needs starter code",
            ),
            (
                "```rust runnable check\nfn a() {}\n---checks\nfn helper() {}\n```\n",
                "at least one `#[test]`",
            ),
            (
                "```rust check\nfn a() {}\n---checks\n#[test]\nfn t() {}\n```\n",
                "belongs on a `rust runnable` fence",
            ),
        ] {
            let rendered = render(source, RenderOptions::default());
            assert!(
                rendered.errors.iter().any(|error| error.contains(expected)),
                "{expected}: {:?}",
                rendered.errors
            );
        }
        let too_big = format!(
            "```rust runnable check\nfn a() {{}}\n---checks\n#[test]\nfn t() {{}}\n// {}\n```\n",
            "x".repeat(40_000)
        );
        assert!(render(&too_big, RenderOptions::default())
            .errors
            .iter()
            .any(|e| e.contains("under 40,000 bytes")));
    }

    #[test]
    fn split_rust_checks_finds_the_marker_line_only() {
        assert_eq!(split_rust_checks("a\n---checks\nb\n"), ("a\n", Some("b\n")));
        assert_eq!(split_rust_checks("a\n  ---checks  \nb"), ("a\n", Some("b")));
        assert_eq!(
            split_rust_checks("let s = \"---checks\";\n"),
            ("let s = \"---checks\";\n", None)
        );
        assert_eq!(split_rust_checks("only starter"), ("only starter", None));
    }

    #[test]
    fn web_runnable_fences_reject_unconfigured_libraries() {
        let rendered = render(
            "```web runnable libs=react,vue\n---js\nReact;\n```\n",
            RenderOptions::default(),
        );
        assert_eq!(rendered.errors.len(), 2, "{:?}", rendered.errors);
        assert!(rendered.errors[0].contains("library `react`"));
        assert!(rendered.errors[1].contains("library `vue`"));
        assert!(!rendered.html.contains("data-ob-web-lib"));
    }

    #[test]
    fn invalid_web_runnable_fences_report_validation_errors() {
        for source in [
            "```web runnable\n<button>Missing marker</button>\n```\n",
            "```web runnable\n---html\n\n```\n",
        ] {
            let rendered = render(source, RenderOptions::default());
            assert!(
                rendered
                    .errors
                    .iter()
                    .any(|error| error.contains("needs a non-empty")),
                "{:?}",
                rendered.errors
            );
            assert_eq!(rendered.capabilities.len(), 1);
            assert_eq!(
                rendered.capabilities[0].diagnostics[0].code,
                CapabilityDiagnosticCode::MalformedContent
            );
            assert!(
                rendered.capabilities[0].diagnostics[0].message.len()
                    <= crate::capability::MAX_DIAGNOSTIC_MESSAGE_LENGTH
            );
        }
    }

    #[test]
    fn demo_fences_render_the_element_around_their_authored_fallback() {
        let r = render(
            "```demo git-sandbox title=\"Try it\"\nWithout JavaScript, follow the **worked example** below.\n```\n",
            RenderOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            r.html.contains("<figure class=\"ob-demo\" data-demo=\"git-sandbox\"><figcaption class=\"ob-code-title\">Try it</figcaption><ob-git-sandbox><p>Without JavaScript, follow the <strong>worked example</strong> below.</p>\n</ob-git-sandbox></figure>"),
            "{}",
            r.html
        );
        assert_eq!(r.capabilities.len(), 1);
        assert_eq!(r.capabilities[0].id, "interactive-demo");
        assert_eq!(r.capabilities[0].native_renderer, Some("ob-git-sandbox"));
    }

    #[test]
    fn a_practice_demo_names_its_lesson_on_the_element() {
        let r = render(
            "```demo git-practice lesson=\"first-workflow\" title=\"Type it\"
1. Run `git init`.
```
",
            RenderOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            r.html
                .contains("<ob-practice-lab data-lesson=\"first-workflow\"><ol>"),
            "{}",
            r.html
        );
        assert_eq!(
            parse_fence_info("demo git-practice lesson=\"A_b\"").demo_lesson,
            None
        );
    }

    #[test]
    fn an_empty_demo_fence_uses_the_kinds_own_description() {
        for (kind, element, words) in [
            ("git-sandbox", "ob-git-sandbox", "in-memory Git"),
            ("git-practice", "ob-practice-lab", "practice terminal"),
            ("fetch-lab", "ob-fetch-lab", "network inspector"),
            ("component-lab", "ob-component-lab", "shadow root"),
            (
                "js-evolution",
                "ob-evolution-lab",
                "Older and newer JavaScript",
            ),
            ("audio-lab", "ob-audio-lab", "Web Audio synth"),
            ("native-lab", "ob-native-lab", "popover attribute"),
        ] {
            let r = render(&format!("```demo {kind}\n```\n"), RenderOptions::default());
            assert!(r.errors.is_empty(), "{kind}: {:?}", r.errors);
            assert!(r.html.contains(&format!("<{element}><p>")), "{}", r.html);
            assert!(r.html.contains(words), "{kind}: {}", r.html);
        }
    }

    #[test]
    fn invalid_demo_fences_report_what_to_write() {
        for (source, expected) in [
            ("```demo\nText\n```\n", "needs a kind"),
            (
                "```demo teleporter\nText\n```\n",
                "unknown kind `teleporter`",
            ),
            (
                "```demo git-sandbox\n<b>raw</b>\n```\n",
                "raw HTML is not supported",
            ),
            (
                "```demo git-sandbox\n![x](https://e.test/a.png)\n```\n",
                "cannot contain images",
            ),
            (
                "```demo git-sandbox\n[x](/relative/)\n```\n",
                "absolute https URLs",
            ),
            (
                "```demo git-sandbox\n[x](javascript:alert(1))\n```\n",
                "absolute https URLs",
            ),
        ] {
            let r = render(source, RenderOptions::default());
            assert!(
                r.errors.iter().any(|error| error.contains(expected)),
                "{source:?}: {:?}",
                r.errors
            );
            assert!(r.html.contains("ob-demo-error"), "{}", r.html);
            assert!(!r.html.contains("<ob-git-sandbox"), "{}", r.html);
            assert_eq!(
                r.capabilities[0].diagnostics[0].code,
                CapabilityDiagnosticCode::MalformedContent
            );
        }
    }

    #[test]
    fn quiz_fences_render_as_accessible_knowledge_checks() {
        let r = render(
            "```quiz\nWhat does `draft: true` do?\n- [ ] Publishes privately\n- [x] Excludes the post from public builds\n- [ ] Schedules it\n> Draft posts remain available in preview.\n```\n",
            RenderOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.html.contains("<ob-quiz data-key=\""), "{}", r.html);
        assert!(r.html.contains("<section class=\"ob-knowledge-check\""));
        assert!(r.html.contains("<fieldset>"), "{}", r.html);
        assert!(r
            .html
            .contains("<legend>What does <code>draft: true</code> do?</legend>"));
        assert_eq!(r.html.matches("type=\"radio\"").count(), 3);
        assert!(r.html.contains("data-correct"));
        assert!(r.html.contains("Draft posts remain available in preview."));
        assert!(!r.code_languages.contains(&"quiz".to_string()));
        assert_eq!(r.capabilities.len(), 1);
        assert_eq!(r.capabilities[0].id, "knowledge-check");
        assert_eq!(r.capabilities[0].native_renderer, Some("ob-quiz"));
        assert_eq!(
            r.capabilities[0].portability,
            crate::capability::PortabilityLevel::GracefullyTransformed
        );
    }

    #[test]
    fn invalid_quiz_fences_report_validation_errors() {
        for (body, problem) in [
            ("Question\n- [ ] A\n", "between two and four"),
            ("Question\n- [x] A\n- [x] B\n", "exactly one"),
            ("Question\n- [ ] A\n- [ ] B\n", "exactly one"),
            ("Question\n- [x] A\n- [ ] B\nextra\n", "unexpected line"),
            (
                "Question\n- [x] A\n- [ ] B\n> One\n> Two\n",
                "one blockquote line",
            ),
        ] {
            let r = render(&format!("```quiz\n{body}```\n"), RenderOptions::default());
            assert!(
                r.errors.iter().any(|e| e.contains(problem)),
                "expected {problem:?} in {:?}",
                r.errors
            );
            assert!(!r.html.contains("<ob-quiz"));
            assert_eq!(r.capabilities.len(), 1);
            assert_eq!(
                r.capabilities[0].diagnostics[0].code,
                CapabilityDiagnosticCode::MalformedContent
            );
        }
    }

    #[test]
    fn consecutive_quizzes_form_one_knowledge_check() {
        let question = "```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```";
        let r = render(
            &format!("{question}\n\n{question}\n"),
            RenderOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.html.matches("class=\"ob-knowledge-check\"").count(), 1);
        assert_eq!(r.html.matches("<ob-quiz ").count(), 2);
        assert_eq!(r.html.matches("</section>").count(), 1);
        assert_eq!(r.capabilities.len(), 2);
        assert!(r
            .capabilities
            .iter()
            .all(|capability| capability.id == "knowledge-check"));
        let keys: Vec<_> = r
            .html
            .split("data-key=\"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[1].strip_suffix("-2"), Some(keys[0]));
    }

    #[test]
    fn capabilities_are_detected_in_nested_containers_and_keep_source_order() {
        let r = render(
            "> ```rust runnable\n> fn main() {}\n> ```\n\n```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```\n",
            RenderOptions::default(),
        );
        assert_eq!(
            r.capabilities
                .iter()
                .map(|capability| capability.id.as_str())
                .collect::<Vec<_>>(),
            ["runnable-code", "knowledge-check"]
        );
        assert!(r.html.contains("<blockquote>"));
        assert!(r.html.contains("<ob-rust-playground>"));
        assert!(r.html.contains("<ob-quiz"));
    }

    #[test]
    fn quizzes_and_web_sandboxes_render_inside_callouts() {
        let r = render(
            "> [!TIP]\n> ```quiz\n> Question?\n> - [x] Yes\n> - [ ] No\n> ```\n>\n> ```web runnable\n> ---html\n> <p>Hi</p>\n> ```\n",
            RenderOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.html.matches("type=\"radio\"").count(), 2, "{}", r.html);
        assert!(r.html.contains("<ob-web-sandbox>"));
        assert!(r
            .capabilities
            .iter()
            .all(|capability| capability.diagnostics.is_empty()));
    }

    #[test]
    fn unknown_markdown_fences_remain_ordinary_content() {
        let source = "```future-capability\nunmodified source\n```\n";
        let r = render(source, RenderOptions::default());
        assert!(r.capabilities.is_empty());
        assert!(r.html.contains(
            "<pre><code class=\"language-future-capability\">unmodified source\n</code></pre>"
        ));
    }

    #[test]
    fn quiz_identity_ignores_insignificant_whitespace() {
        let a = render(
            "```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```",
            RenderOptions::default(),
        );
        let b = render(
            "```quiz\n  Question?  \n\n- [x]  Yes  \n- [ ] No\n\n```",
            RenderOptions::default(),
        );
        let key = |html: &str| {
            html.split("data-key=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap()
                .to_string()
        };
        assert_eq!(key(&a.html), key(&b.html));
    }

    #[test]
    fn lazy_images_and_first_image() {
        let r = render("![alt](/a.png)\n\n![b](/b.png)", RenderOptions::default());
        assert_eq!(r.first_image.as_deref(), Some("/a.png"));
        assert!(r
            .html
            .contains("<img loading=\"lazy\" decoding=\"async\" src=\"/a.png\""));
    }

    #[test]
    fn standalone_codepen_links_become_embeds_but_inline_links_do_not() {
        let md = "Intro.\n\n[https://codepen.io/u/pen/abc](https://codepen.io/u/pen/abc)\n\nSee [this pen](https://codepen.io/u/pen/def) inline.\n\n<https://codepen.io/u/pen/ghi>\n\n%[https://codepen.io/u/pen/jkl]\n\n[docs](https://example.com)\n";
        let r = render(md, RenderOptions::default());
        assert!(r
            .html
            .contains("<iframe src=\"https://codepen.io/u/embed/abc?default-tab=result\""));
        assert!(
            r.html
                .contains("<iframe src=\"https://codepen.io/u/embed/ghi?default-tab=result\""),
            "autolink"
        );
        assert!(
            r.html
                .contains("<iframe src=\"https://codepen.io/u/embed/jkl?default-tab=result\""),
            "Hashnode syntax"
        );
        assert!(
            !r.html.contains("embed/def"),
            "a link inside a sentence stays a link"
        );
        assert!(r
            .html
            .contains("<a href=\"https://codepen.io/u/pen/def\">this pen</a>"));
        assert!(
            r.html.contains("<a href=\"https://example.com\">docs</a>"),
            "other standalone links stay links"
        );
        assert!(
            !r.html.contains("<p><figure"),
            "the embed replaces the paragraph"
        );
        let off = render(
            md,
            RenderOptions {
                embeds: false,
                ..Default::default()
            },
        );
        assert!(!off.html.contains("<iframe"));
    }

    #[test]
    fn excerpt_and_reading_time() {
        assert_eq!(excerpt("one two three four", 9), "one two…");
        assert_eq!(excerpt("short", 100), "short");
        assert_eq!(reading_minutes(0), 1);
        assert_eq!(reading_minutes(226), 2);
    }

    #[test]
    fn tables_footnotes_tasks() {
        let r = render(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\nnote[^1]\n\n[^1]: foot\n",
            RenderOptions::default(),
        );
        assert!(r.html.contains("<table>"));
        assert!(r.html.contains("type=\"checkbox\""));
        assert!(r.html.contains("footnote"));
    }

    #[test]
    fn fence_options_title_line_numbers_and_highlights() {
        let info = parse_fence_info(r#"rust title="src/main.rs" {1,3-4} showLineNumbers=10"#);
        assert_eq!(info.lang, "rust");
        assert_eq!(info.title.as_deref(), Some("src/main.rs"));
        assert_eq!(info.highlight.as_deref(), Some("1,3-4"));
        assert_eq!((info.line_numbers, info.line_start), (Some(true), Some(10)));
        assert_eq!(parse_fence_info("js{2}").highlight.as_deref(), Some("2"));
        assert_eq!(
            parse_fence_info("js showLineNumbers=false").line_numbers,
            Some(false)
        );
        assert_eq!(
            parse_fence_info("js {x<y}").highlight,
            None,
            "only digits, commas and dashes"
        );
        assert_eq!(
            parse_fence_info("title=a.txt").lang,
            "",
            "no language before the title"
        );
        assert!(parse_fence_info("rust runnable").runnable);
        assert_eq!(
            parse_fence_info("rust runnable playgroundLink=false").playground_link,
            Some(false)
        );

        let r = render(
            "```rust runnable playgroundLink=false title=\"a <b>.rs\" {2} showLineNumbers\nfn a() {}\nlet x = 1;\n```\n\n```python runnable\nprint('ordinary block')\n```\n\n```\nplain\n```\n",
            RenderOptions::default(),
        );
        assert!(r.html.contains(
            "<figure class=\"ob-code-block\"><figcaption class=\"ob-code-title\">a &lt;b&gt;.rs</figcaption><ob-rust-playground data-playground-link=\"false\"><pre><code class=\"language-rust\" data-runnable=\"rust\" data-line-numbers=\"true\" data-highlight-lines=\"2\">fn a() {}\nlet x = 1;\n</code></pre></ob-rust-playground></figure>"
        ), "{}", r.html);
        assert!(r
            .html
            .contains("<code class=\"language-python\">print('ordinary block')"));
        assert!(r.html.contains("<pre><code>plain\n</code></pre>"));
        assert_eq!(
            r.code_languages,
            vec!["rust".to_string(), "python".to_string()]
        );
    }

    #[test]
    fn the_site_setting_hides_the_playground_link_unless_a_fence_asks_for_it() {
        let source = "```rust runnable
fn main() {}
```

```rust runnable playgroundLink=true
fn main() {}
```

```rust runnable playgroundLink=false
fn main() {}
```
";
        let shown = render(source, RenderOptions::default());
        assert_eq!(
            shown.html.matches("<ob-rust-playground>").count(),
            2,
            "{}",
            shown.html
        );
        assert_eq!(
            shown.html.matches("data-playground-link=\"false\"").count(),
            1
        );

        let hidden = render(
            source,
            RenderOptions {
                playground_link: false,
                ..Default::default()
            },
        );
        assert_eq!(
            hidden
                .html
                .matches("data-playground-link=\"false\"")
                .count(),
            2,
            "{}",
            hidden.html
        );
        assert_eq!(
            hidden.html.matches("<ob-rust-playground>").count(),
            1,
            "an explicit playgroundLink=true still wins"
        );
    }

    #[test]
    fn configured_runner_enhances_only_rust_and_explicitly_allowed_languages() {
        let languages = vec!["python".to_string(), "go".to_string()];
        let rendered = render(
            "```rust runnable\nfn main() {}\n```\n\n```python runnable\nprint('hi')\n```\n\n```ruby runnable\nputs 'static'\n```\n",
            RenderOptions {
                code_runner: Some(CodeRunnerRenderOptions {
                    endpoint: "https://runner.example/execute",
                    languages: &languages,
                }),
                ..Default::default()
            },
        );
        assert!(rendered.html.contains("<ob-code-runner data-language=\"rust\" data-endpoint=\"https://runner.example/execute\">"));
        assert!(rendered.html.contains("<ob-code-runner data-language=\"python\" data-endpoint=\"https://runner.example/execute\">"));
        assert!(!rendered.html.contains("data-language=\"ruby\""));
        assert!(rendered
            .html
            .contains("<code class=\"language-ruby\">puts 'static'"));
    }

    #[test]
    fn piece_fences_render_pieces_and_report_what_is_wrong() {
        let r = render(
            "Before

```piece video
provider: youtube
video: dQw4w9WgXcQ
title: A <b>tour</b>
```

```piece button
label: Read
href: javascript:alert(1)
```

After
",
            RenderOptions::default(),
        );
        assert!(
            r.html.contains("<div class=\"ob-piece ob-piece-video\">"),
            "{}",
            r.html
        );
        assert!(r
            .html
            .contains("src=\"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ\""));
        assert!(r.html.contains("title=\"A &lt;b&gt;tour&lt;/b&gt;\""));
        assert!(r
            .html
            .contains("<aside class=\"ob-piece-error\" role=\"alert\">Invalid piece:"));
        assert!(!r.html.contains("javascript:alert(1)\""));
        assert!(
            r.errors.iter().any(|e| e.contains("piece button")),
            "{:?}",
            r.errors
        );
        assert!(
            !r.html.contains("<pre"),
            "a piece fence is not shown as code"
        );
    }

    #[test]
    fn code_fences_that_only_mention_piece_are_unchanged() {
        let r = render(
            "```rust
let piece = 1;
```

```pieces
x
```
",
            RenderOptions::default(),
        );
        assert!(!r.html.contains("ob-piece"), "{}", r.html);
        assert_eq!(r.html.matches("<pre").count(), 2);
    }

    #[test]
    fn github_style_callouts() {
        let r = render(
            "> [!TIP]\n> Use **fresh** basil.\n\n> plain quote\n",
            RenderOptions::default(),
        );
        assert!(r.html.contains("<aside class=\"ob-callout ob-callout-tip\" role=\"note\"><p class=\"ob-callout-title\">Tip</p>"), "{}", r.html);
        assert!(r.html.contains("<strong>fresh</strong>"));
        assert!(r.html.contains("</aside>"));
        assert!(r.html.contains("<blockquote>\n<p>plain quote</p>"));
        assert!(!r.text.contains("[!TIP]"));
    }

    /// Every `<section>` opens and closes in the same container: count them per
    /// container by checking that no section boundary falls inside a quote,
    /// callout, list item or `<details>`.
    fn sections_balanced(html: &str) -> bool {
        let mut stack: Vec<&str> = Vec::new();
        let mut rest = html;
        while let Some(at) = rest.find('<') {
            rest = &rest[at..];
            let tag = |t: &str| rest.starts_with(t);
            for (open, close, name) in [
                ("<section", "</section>", "section"),
                ("<blockquote", "</blockquote>", "blockquote"),
                ("<aside", "</aside>", "aside"),
                ("<li", "</li>", "li"),
                ("<details", "</details>", "details"),
            ] {
                if tag(open) && !rest[open.len()..].starts_with(char::is_alphanumeric) {
                    stack.push(name);
                } else if tag(close) && stack.pop() != Some(name) {
                    return false;
                }
            }
            rest = &rest[1..];
        }
        stack.is_empty()
    }

    #[test]
    fn recipe_sections_respect_containers() {
        let opts = RenderOptions {
            recipe: true,
            ..RenderOptions::default()
        };
        let cases = [
            "## Ingredients\n\n- flour\n\n> ## Note\n> keep dry\n\nAfter quote.\n",
            "> [!TIP]\n> ## Ingredients\n> - flour\n\nStory paragraph after.\n",
            "## Ingredients\n\n- flour\n- ## Steps\n- mix\n",
            "<details>\n<summary>Recipe</summary>\n\n## Ingredients\n\n- a\n\n</details>\n\nMore story.\n",
            "## Steps\n\n1. Bake.[^1]\n\n[^1]:\n    - Ovens vary\n    - Check at 20 minutes\n",
        ];
        for md in cases {
            let r = render(md, opts);
            assert!(sections_balanced(&r.html), "{md}\n{}", r.html);
        }
        // A heading inside a quote neither closes nor opens a section.
        let r = render(cases[0], opts);
        assert!(
            r.html.contains("<blockquote>\n<h2 id=\"note\">"),
            "{}",
            r.html
        );
        // Lists in callouts and footnotes are not recipe lists.
        let r = render(
            "## Ingredients\n\n> [!TIP]\n> - Use fresh basil\n\n- 1 cup flour\n",
            opts,
        );
        assert_eq!(r.recipe_ingredients, vec!["1 cup flour"]);
        let r = render(cases[4], opts);
        assert_eq!(
            r.recipe_steps,
            vec!["Bake."],
            "the footnote list is not a step"
        );
        // A Method sub-heading inside Ingredients starts the steps.
        let r = render(
            "## Ingredients\n\n- 1 egg\n\n### Method\n\n1. Crack the egg.\n2. Fry 3 minutes.\n",
            opts,
        );
        assert_eq!(r.recipe_ingredients, vec!["1 egg"]);
        assert_eq!(r.recipe_steps, vec!["Crack the egg.", "Fry 3 minutes."]);
        assert!(r.html.contains("<ol class=\"ob-recipe-list ob-steps\">"));
        // A story heading that merely starts with "Step" is not a section.
        let r = render(
            "## Stephanie's story\n\n- Lyon\n\n## Ingredients\n\n- 1 egg\n",
            opts,
        );
        assert!(r.recipe_steps.is_empty());
        assert_eq!(r.recipe_anchor.as_deref(), Some("ingredients"));
    }

    #[test]
    fn recipe_sections_keep_html_and_footnotes_inside() {
        let opts = RenderOptions {
            recipe: true,
            ..RenderOptions::default()
        };
        let r = render(
            "## Ingredients\n\n<figure>\n  <img src=\"/x.jpg\" alt=\"mise en place\">\n</figure>\n\n- 1 cup flour\n- 2 eggs\n\n## Steps\n\n<video controls>\n<source src=\"/v.mp4\">\n</video>\n\n1. Mix.\n2. Bake 20 minutes.\n",
            opts,
        );
        assert_eq!(r.recipe_ingredients, vec!["1 cup flour", "2 eggs"]);
        assert_eq!(r.recipe_steps, vec!["Mix.", "Bake 20 minutes."]);
        assert!(!r.html.contains("</section>\n</figure>"), "{}", r.html);
        let r = render(
            "## Ingredients\n\n<div class=\"note\">\n\nSome tip\n\n</div>\n\n- a\n- b\n",
            opts,
        );
        assert_eq!(r.recipe_ingredients, vec!["a", "b"]);
        let r = render(
            "## Steps\n\n1. Bake.[^1]\n\n[^1]: Ovens vary.\n\n2. Cool.\n",
            opts,
        );
        assert!(
            r.recipe_steps.contains(&"Cool.".to_string()),
            "{:?}",
            r.recipe_steps
        );
        assert_eq!(html_line_depth("<details>"), 1);
        assert_eq!(html_line_depth("</details>"), -1);
        assert_eq!(html_line_depth("<img src=\"a\">"), 0);
        assert_eq!(html_line_depth("<p>closed</p>"), 0);
        assert_eq!(html_line_depth("<!-- note -->"), 0);
    }

    #[test]
    fn a_switched_sub_section_returns_to_its_parent() {
        let r = render(
            "## Method\n\n### Make the dough\n\n1. Mix.\n\n### Ingredients for the glaze\n\n- 1 cup sugar\n\n### Glaze the cake\n\n1. Pour the glaze.\n2. Chill 1 hour.\n\n## Notes\n\n- not a step\n",
            RenderOptions {
                recipe: true,
                ..RenderOptions::default()
            },
        );
        assert_eq!(r.recipe_ingredients, vec!["1 cup sugar"]);
        assert_eq!(
            r.recipe_steps,
            vec!["Mix.", "Pour the glaze.", "Chill 1 hour."]
        );
        assert!(sections_balanced(&r.html));
    }

    #[test]
    fn recipe_sections_are_wrapped_and_collected() {
        let md = "Intro story.\n\n## Ingredients\n\n### For the sauce\n\n- 2 cups *tomatoes*\n- 1 tsp salt\n\n### Pasta\n\n- 400 g spaghetti\n\n## Steps\n\n1. Boil water for\n   10 minutes.\n2. Toss.\n   - sub step\n\n## Notes\n\nKeeps 3 days.\n";
        let r = render(
            md,
            RenderOptions {
                recipe: true,
                ..RenderOptions::default()
            },
        );
        assert_eq!(
            r.recipe_ingredients,
            vec!["2 cups tomatoes", "1 tsp salt", "400 g spaghetti"]
        );
        assert_eq!(
            r.recipe_steps,
            vec!["Boil water for 10 minutes.", "Toss. sub step"]
        );
        assert_eq!(r.recipe_anchor.as_deref(), Some("ingredients"));
        assert!(r.html.contains(
            "<section class=\"ob-recipe-part ob-recipe-ingredients\">\n<h2 id=\"ingredients\">"
        ));
        assert_eq!(
            r.html
                .matches("<ul class=\"ob-recipe-list ob-ingredients\">")
                .count(),
            2
        );
        assert!(r.html.contains("<ol class=\"ob-recipe-list ob-steps\">"));
        assert!(
            r.html.contains("<ul>\n<li>sub step</li>"),
            "nested lists stay plain: {}",
            r.html
        );
        // Each section closes before the next h2, and Notes is outside both.
        let notes = r.html.find("id=\"notes\"").unwrap();
        assert_eq!(r.html[..notes].matches("</section>").count(), 2);
        assert_eq!(
            r.html.matches("<section").count(),
            r.html.matches("</section>").count()
        );

        let plain = render(md, RenderOptions::default());
        assert!(!plain.html.contains("ob-recipe"));
        assert!(plain.recipe_ingredients.is_empty());
    }
}
