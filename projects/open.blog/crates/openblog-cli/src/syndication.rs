//! Safe, provider-neutral cross-posting from an open.blog source post.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use blake2::{Blake2b512, Digest};
use hmac::{Hmac, Mac};
use html5ever::serialize::{SerializeOpts, TraversalScope};
use html5ever::tendril::TendrilSink;
use html5ever::{local_name, ns, QualName};
use markup5ever_rcdom::{Handle, NodeData, RcDom, SerializableHandle};
use openblog_core::config::{SyndicationProvider, SyndicationTargetConfig};
use openblog_core::frontmatter;
use openblog_core::model::SeriesContext;
use openblog_core::portability::{
    destination_content_plan, destination_payload_plan, destination_policies, destination_policy,
    destination_tag_plan, DestinationContentPlan, DestinationPayloadPlan,
    DestinationRepresentation, PortableProjection,
};
use openblog_core::{Post, SiteConfig};
use pulldown_cmark::{Event, Options as MarkdownOptions, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sha2::Sha256;
use ureq::config::Config;
use url::Url;

use crate::{fsutil, safe_http, site, url_context};

const MAX_RESPONSE_BYTES: u64 = 1_048_576;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HASHNODE_ENDPOINT: &str = "https://gql-beta.hashnode.com";

#[derive(Clone, Debug)]
pub struct Options {
    pub target_names: Vec<String>,
    pub write: bool,
    pub publish: bool,
    pub json: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SyndicationPost {
    source_id: String,
    source_path: String,
    slug: String,
    title: String,
    subtitle: Option<String>,
    description: String,
    source_markdown: String,
    pub(crate) markdown: String,
    pub(crate) html: String,
    tags: Vec<String>,
    canonical_url: String,
    pub(crate) revision: String,
    portable_diagnostics: Vec<openblog_core::portability::PortabilityDiagnostic>,
    content_plans: Vec<DestinationContentPlan>,
}

#[derive(Clone, Debug, PartialEq)]
struct Request {
    method: &'static str,
    url: String,
    headers: Vec<(String, String)>,
    body: Json,
}

#[derive(Clone, Debug)]
struct Response {
    status: u16,
    body: Vec<u8>,
}

trait Transport {
    fn send(&self, request: &Request) -> Result<Response, String>;
}

#[derive(Default)]
struct NetworkTransport {
    resolver: safe_http::PublicResolver,
}

impl Transport for NetworkTransport {
    fn send(&self, request: &Request) -> Result<Response, String> {
        let config = network_config();
        let agent = safe_http::public_agent(config, self.resolver.clone());
        let result = match request.method {
            "GET" => {
                let mut builder = agent.get(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            "POST" | "PUT" => {
                let mut builder = if request.method == "POST" {
                    agent.post(&request.url)
                } else {
                    agent.put(&request.url)
                };
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(request.body.to_string())
            }
            _ => return Err("unsupported syndication HTTP method".into()),
        };
        let mut response = match result {
            Ok(response) => response,
            Err(ureq::Error::Timeout(_)) => return Err("request timed out after 30 seconds".into()),
            Err(_) => return Err("request failed before the provider returned a response".into()),
        };
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(|_| "provider response exceeded 1 MiB or could not be read".to_string())?;
        Ok(Response { status, body })
    }
}

fn network_config() -> Config {
    Config::builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .user_agent(concat!("open.blog-syndication/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn status_error(status: u16) -> String {
    match status {
        401 => "authentication failed; check the target's environment credential".into(),
        402 => "the provider requires billing or an eligible plan".into(),
        403 => {
            "the credential lacks permission or the provider plan does not allow publishing".into()
        }
        404 => "the configured publication, site, or stored remote item was not found".into(),
        409 => "the provider rejected the write because the remote item changed".into(),
        422 => "the provider rejected the post or target configuration".into(),
        429 => "the provider rate limit was reached; retry later".into(),
        500..=599 => "the provider is temporarily unavailable; retry later".into(),
        _ => format!("provider returned HTTP {status}"),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct State {
    schema_version: u32,
    records: BTreeMap<String, BTreeMap<String, StateRecord>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: 2,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StateRecord {
    source_path: String,
    remote_id: String,
    remote_url: String,
    remote_revision: String,
    revision: String,
    publication_state: String,
    updated_at_unix: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyState {
    schema_version: u32,
    records: BTreeMap<String, LegacyStateRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStateRecord {
    source_id: String,
    source_path: String,
    target: String,
    remote_id: String,
    remote_url: String,
    #[serde(default)]
    remote_revision: String,
    revision: String,
    publication_state: String,
    updated_at_unix: u64,
}

impl State {
    fn load(path: &Path) -> Result<Self, String> {
        match fs::read_to_string(path) {
            Ok(json) => Self::from_json(&json)
                .map_err(|e| format!("invalid private syndication state {}: {e}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                schema_version: 2,
                records: BTreeMap::new(),
            }),
            Err(error) => Err(format!("cannot read {}: {error}", path.display())),
        }
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        fsutil::write_file(path, &bytes)
    }

    fn from_json(json: &str) -> Result<Self, String> {
        let value: Json = serde_json::from_str(json).map_err(|error| error.to_string())?;
        match value["schemaVersion"].as_u64() {
            Some(2) => serde_json::from_value(value).map_err(|error| error.to_string()),
            Some(1) => {
                let legacy: LegacyState =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                if legacy.schema_version != 1 {
                    return Err("unsupported syndication state schema".into());
                }
                let mut state = Self {
                    schema_version: 2,
                    records: BTreeMap::new(),
                };
                for record in legacy.records.into_values() {
                    state.insert(
                        &record.source_id,
                        &record.target,
                        StateRecord {
                            source_path: record.source_path,
                            remote_id: record.remote_id,
                            remote_url: record.remote_url,
                            remote_revision: record.remote_revision,
                            revision: record.revision,
                            publication_state: record.publication_state,
                            updated_at_unix: record.updated_at_unix,
                        },
                    );
                }
                Ok(state)
            }
            _ => Err("unsupported syndication state schema".into()),
        }
    }

    fn record(&self, source_id: &str, target: &str) -> Option<&StateRecord> {
        self.records.get(source_id)?.get(target)
    }

    fn insert(&mut self, source_id: &str, target: &str, record: StateRecord) {
        self.records
            .entry(source_id.to_string())
            .or_default()
            .insert(target.to_string(), record);
    }
}

pub fn run(root: &Path, slug: &str, options: Options) -> Result<(), String> {
    run_with_transport(root, slug, options, &NetworkTransport::default())
}

fn run_with_transport(
    root: &Path,
    slug: &str,
    options: Options,
    transport: &dyn Transport,
) -> Result<(), String> {
    if options.json && options.write {
        return Err("--json is available for dry runs only; no request was sent".into());
    }
    let config = site::load_config(root)?;
    let sources = site::read_sources(root, &config)?;
    let (mut loaded, _) = site::load_site(root, false, Some(crate::clock::now()))?;
    // The public curated context, while the site publishes it, so the copy sent to a
    // destination carries it and links back to the canonical page (ADR 0202).
    crate::boundary::attach_public_curation(root, &mut loaded)?;
    let post = match loaded.posts.iter().find(|post| post.slug == slug) {
        Some(post) => post,
        None => return Err(unavailable_post_error(root, slug)?),
    };
    let source = sources
        .posts
        .iter()
        .find(|source| source.path == post.source)
        .ok_or_else(|| format!("cannot find source `{}`", post.source))?;
    let syndication_post = syndication_post(
        post,
        &source.contents,
        &config,
        loaded.series_context(post),
        loaded.curated_context_for(post),
    )?;

    let selected = select_targets(&config, &options.target_names)?;
    let state_path = private_state_path(root, &config.syndication.state_file)?;
    let mut state = State::load(&state_path)?;
    validate_source_identity(&state, &syndication_post)?;
    validate_plan(&selected, options.publish)?;
    if options.write {
        for (name, target) in &selected {
            for plan in syndication_post
                .content_plans
                .iter()
                .filter(|plan| plan.policy.provider == target.provider)
            {
                plan.validate()?;
            }
            destination_tag_plan(
                target.provider,
                &syndication_post.source_path,
                &syndication_post.tags,
            )
            .validate()?;
            if target.provider == SyndicationProvider::Hashnode {
                hashnode_payload_plan(
                    &target.publication_id,
                    &syndication_post,
                    state.record(&syndication_post.source_id, name),
                )?
                .validate()?;
            }
        }
    }
    if options.json {
        let plan = dry_run_json_plan(&syndication_post, &selected, &state, options.publish);
        println!(
            "{}",
            serde_json::to_string_pretty(&plan)
                .map_err(|error| format!("could not serialize syndication plan: {error}"))?
        );
        return Ok(());
    }
    println!(
        "Syndication {} for `{}` ({})",
        if options.write { "write" } else { "dry run" },
        syndication_post.title,
        syndication_post.canonical_url
    );
    let mut canonical_verified = false;
    for (name, target) in selected {
        let adapter = match provider_adapter(target) {
            DestinationAdapter::Manual(adapter) => {
                println!("- {name}: {}", adapter.instruction(&syndication_post));
                print_portable_plan(target.provider, &syndication_post);
                continue;
            }
            DestinationAdapter::Remote(adapter) => adapter,
        };
        let existing = state.record(&syndication_post.source_id, name);
        let public = options.publish && target.allow_publish;
        let action = if existing.is_some() {
            "update"
        } else {
            "create"
        };
        println!(
            "- {name}: {action} {} via {}{}",
            if public { "public copy" } else { "draft" },
            adapter.name(),
            if options.write {
                ""
            } else {
                " (no request sent)"
            }
        );
        if let Some(warning) = adapter.warning() {
            println!("  warning: {warning}");
        }
        print_portable_plan(target.provider, &syndication_post);
        if target.provider == SyndicationProvider::Hashnode {
            match hashnode_payload_plan(&target.publication_id, &syndication_post, existing) {
                Ok(plan) => {
                    println!("  request body: {} UTF-8 bytes", plan.body_bytes);
                    if let Some(limit) = plan.policy.max_request_body_bytes {
                        println!("  request body limit: {limit} bytes");
                    }
                    for diagnostic in plan.diagnostics {
                        println!(
                            "  error: {} [{}] {} Action: {}",
                            diagnostic.source_path,
                            diagnostic.code,
                            diagnostic.message,
                            diagnostic.recommended_action
                        );
                    }
                }
                Err(error) => println!("  request body unavailable: {error}"),
            }
        }
        if !options.write {
            continue;
        }
        if !canonical_verified {
            verify_live_canonical(transport, &syndication_post.canonical_url)?;
            canonical_verified = true;
        }
        let credential = adapter.credential()?;
        let request = adapter.request(&syndication_post, existing, public, &credential)?;
        let outcome = execute(adapter.as_ref(), transport, &request)?;
        state.insert(
            &syndication_post.source_id,
            name,
            StateRecord {
                source_path: syndication_post.source_path.clone(),
                remote_id: outcome.id,
                remote_url: outcome.url,
                remote_revision: outcome.remote_revision,
                revision: syndication_post.revision.clone(),
                publication_state: if public { "published" } else { "draft" }.into(),
                updated_at_unix: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            },
        );
        state.save(&state_path)?;
    }
    if !options.write {
        println!("No remote content or private state was changed. Re-run with --write after reviewing this plan.");
    }
    Ok(())
}

fn validate_plan(
    selected: &[(&String, &SyndicationTargetConfig)],
    publish: bool,
) -> Result<(), String> {
    for (name, target) in selected {
        let adapter = provider_adapter(target);
        adapter.validate()?;
        if publish && !target.allow_publish {
            return Err(format!(
                "target `{name}` does not permit publishing; set allowPublish to true as a second explicit opt-in"
            ));
        }
        if publish
            && destination_policy(target.provider).publication
                == openblog_core::portability::DestinationPublication::RemoteDraftOnly
        {
            return Err(format!(
                "target `{name}` uses {}, whose adapter is draft-only; omit --publish and publish the saved draft in {}",
                adapter.name(), adapter.name()
            ));
        }
    }
    Ok(())
}

fn unavailable_post_error(root: &Path, slug: &str) -> Result<String, String> {
    let (preview, _) = site::load_site(root, true, None)?;
    if preview.posts.iter().any(|post| post.slug == slug) {
        Ok(format!(
            "post `{slug}` is not production-visible; publish the draft or wait for its scheduled date and deploy open.blog before syndicating"
        ))
    } else {
        Ok(format!("no post has slug `{slug}`"))
    }
}

fn validate_source_identity(state: &State, post: &SyndicationPost) -> Result<(), String> {
    if let Some(targets) = state.records.get(&post.source_id) {
        if let Some((target, record)) = targets
            .iter()
            .find(|(_, record)| record.source_path != post.source_path)
        {
            return Err(format!(
                "syndicationId `{}` is already used by `{}` for target `{target}`",
                post.source_id, record.source_path
            ));
        }
    }
    Ok(())
}

fn verify_live_canonical(transport: &dyn Transport, canonical_url: &str) -> Result<(), String> {
    let request = Request {
        method: "GET",
        url: canonical_url.to_string(),
        headers: vec![("Accept".into(), "text/html".into())],
        body: Json::Null,
    };
    let response = transport
        .send(&request)
        .map_err(|error| format!("canonical preflight failed: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "canonical preflight failed: {} returned HTTP {}",
            canonical_url, response.status
        ));
    }
    let html = String::from_utf8_lossy(&response.body);
    let expected = Url::parse(canonical_url)
        .map_err(|_| "canonical preflight received an invalid source URL".to_string())?;
    let head = head_link_metadata(&html);
    let document_base = head
        .base_href
        .as_deref()
        .map(|href| expected.join(href))
        .transpose()
        .ok()
        .flatten()
        .unwrap_or_else(|| expected.clone());
    let matches = head.canonical_hrefs.into_iter().any(|href| {
        document_base
            .join(&href)
            .map(|mut actual| {
                actual.set_fragment(None);
                let mut expected = expected.clone();
                expected.set_fragment(None);
                actual == expected
            })
            .unwrap_or(false)
    });
    if !matches {
        return Err(format!(
            "canonical preflight failed: {canonical_url} is reachable but does not declare itself in a <link rel=\"canonical\">"
        ));
    }
    Ok(())
}

#[derive(Default)]
struct HeadLinkMetadata {
    base_href: Option<String>,
    canonical_hrefs: Vec<String>,
}

fn head_link_metadata(html: &str) -> HeadLinkMetadata {
    let dom = html5ever::parse_document(RcDom::default(), Default::default()).one(html);
    let mut metadata = HeadLinkMetadata::default();
    collect_head_link_metadata(&dom.document, false, &mut metadata);
    metadata
}

fn collect_head_link_metadata(node: &Handle, inside_head: bool, metadata: &mut HeadLinkMetadata) {
    let mut inside_head = inside_head;
    if let NodeData::Element { name, attrs, .. } = &node.data {
        inside_head = inside_head || name.local.as_ref().eq_ignore_ascii_case("head");
        if inside_head && name.local.as_ref().eq_ignore_ascii_case("base") {
            if metadata.base_href.is_none() {
                metadata.base_href = attrs
                    .borrow()
                    .iter()
                    .find(|attr| attr.name.local.as_ref().eq_ignore_ascii_case("href"))
                    .map(|attr| attr.value.to_string());
            }
        } else if inside_head && name.local.as_ref().eq_ignore_ascii_case("link") {
            let attrs = attrs.borrow();
            let rel = attrs
                .iter()
                .find(|attr| attr.name.local.as_ref().eq_ignore_ascii_case("rel"))
                .map(|attr| attr.value.as_ref());
            if rel.is_some_and(|value| {
                value
                    .split_ascii_whitespace()
                    .any(|token| token.eq_ignore_ascii_case("canonical"))
            }) {
                if let Some(href) = attrs
                    .iter()
                    .find(|attr| attr.name.local.as_ref().eq_ignore_ascii_case("href"))
                {
                    metadata.canonical_hrefs.push(href.value.to_string());
                }
            }
        }
    }
    for child in node.children.borrow().iter() {
        collect_head_link_metadata(child, inside_head, metadata);
    }
}

fn select_targets<'a>(
    config: &'a SiteConfig,
    names: &[String],
) -> Result<Vec<(&'a String, &'a SyndicationTargetConfig)>, String> {
    if config.syndication.targets.is_empty() {
        return Err("no syndication targets are configured in openblog.json".into());
    }
    let mut selected = Vec::new();
    for (name, target) in &config.syndication.targets {
        if (!names.is_empty() && !names.iter().any(|wanted| wanted == name)) || !target.enabled {
            continue;
        }
        selected.push((name, target));
    }
    for name in names {
        if !config.syndication.targets.contains_key(name) {
            return Err(format!("unknown syndication target `{name}`"));
        }
    }
    if selected.is_empty() {
        return Err("no enabled syndication targets were selected".into());
    }
    Ok(selected)
}

fn private_state_path(root: &Path, configured: &str) -> Result<std::path::PathBuf, String> {
    let relative = Path::new(configured);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("syndication.stateFile must be a project-relative path without `..`".into());
    }
    Ok(root.join(relative))
}

pub(crate) fn syndication_post(
    post: &Post,
    source: &str,
    config: &SiteConfig,
    series: Option<SeriesContext>,
    curated: Option<std::sync::Arc<openblog_core::curated_context::CuratedContext>>,
) -> Result<SyndicationPost, String> {
    let document = frontmatter::parse(source)?;
    let source_id = document
        .front_matter
        .get("syndicationId")
        .or_else(|| document.front_matter.get("syndication_id"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("source:{}", post.source.replace('\\', "/")));
    // A part of a collaborative series links its canonical series page in the copy (ADR 0041).
    let projection = PortableProjection::from_post(post, config)?
        .with_series(series)
        .with_curated(curated);
    let canonical_url = projection.canonical_url().to_string();
    let canonical = url_context::validate_public_url(&canonical_url)
        .map_err(|error| format!("canonical URL is not public: {error}"))?;
    if canonical.scheme() != "https" {
        return Err("canonical URL must use HTTPS before syndication".into());
    }
    if canonical
        .host_str()
        .is_some_and(|host| host == "example.com" || host.ends_with(".example.com"))
    {
        return Err("set the site's real public URL before syndication".into());
    }
    let portable_html = projection.portable_html()?;
    let content_plans = destination_policies()
        .into_iter()
        .map(|policy| destination_content_plan(policy.provider, &post.source, &portable_html))
        .collect();
    let markdown = absolutize_markdown(&projection.portable_markdown()?, config)?;
    let portable_diagnostics = portable_html.diagnostics.clone();
    let mut hasher = Blake2b512::new();
    hasher.update(post.title.as_bytes());
    // Posts without a subtitle keep the revision they had before subtitles existed.
    if let Some(subtitle) = &post.subtitle {
        hasher.update(b"\0subtitle\0");
        hasher.update(subtitle.as_bytes());
    }
    hasher.update(markdown.as_bytes());
    hasher.update(canonical_url.as_bytes());
    let revision = hasher
        .finalize()
        .iter()
        .take(20)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(SyndicationPost {
        source_id,
        source_path: post.source.clone(),
        slug: post.slug.clone(),
        title: post.title.clone(),
        subtitle: post.subtitle.clone(),
        description: post.description.clone(),
        source_markdown: post.authored_markdown().to_string(),
        markdown,
        html: absolutize_html(&portable_html.html, config),
        tags: post.tags.iter().map(|tag| tag.name.clone()).collect(),
        canonical_url,
        revision,
        portable_diagnostics,
        content_plans,
    })
}

fn print_portable_plan(provider: SyndicationProvider, post: &SyndicationPost) {
    let policy = destination_policy(provider);
    let representation = match policy.representation {
        DestinationRepresentation::PortableMarkdown => "portable Markdown",
        DestinationRepresentation::PortableHtml => "portable HTML",
        DestinationRepresentation::ManualMarkdown => "portable Markdown for manual import",
    };
    println!(
        "  projection: {representation}; {}",
        policy.canonical_behavior
    );
    println!("  workflow: {}", policy.workflow);
    println!("  content policy: {}", policy.conversion_review);
    if let Some(plan) = post
        .content_plans
        .iter()
        .find(|plan| plan.policy.provider == provider)
    {
        for diagnostic in &plan.diagnostics {
            println!(
                "  {:?}: {} [{}] {} Action: {}",
                diagnostic.severity,
                diagnostic.source_path,
                diagnostic.code,
                diagnostic.message,
                diagnostic.recommended_action
            );
        }
    }
    for diagnostic in &post.portable_diagnostics {
        println!(
            "  portability: {} [{}] {} Action: {}",
            diagnostic.source_path,
            diagnostic.code,
            diagnostic.message,
            diagnostic.recommended_action
        );
    }
    {
        let tags = destination_tag_plan(provider, &post.source_path, &post.tags);
        println!(
            "  tags: selected {:?}; omitted {:?}",
            tags.tags, tags.omitted_tags
        );
        for diagnostic in tags.diagnostics {
            println!(
                "  {:?}: {} [{}] {} Action: {}",
                diagnostic.severity,
                diagnostic.source_path,
                diagnostic.code,
                diagnostic.message,
                diagnostic.recommended_action,
            );
        }
    }
}

fn dry_run_json_plan(
    post: &SyndicationPost,
    selected: &[(&String, &SyndicationTargetConfig)],
    state: &State,
    publish: bool,
) -> Json {
    let targets = selected
        .iter()
        .map(|(name, target)| {
            let policy = destination_policy(target.provider);
            let (format, content) = match policy.representation {
                DestinationRepresentation::PortableMarkdown => {
                    ("portable-markdown", post.markdown.as_str())
                }
                DestinationRepresentation::PortableHtml => ("portable-html", post.html.as_str()),
                DestinationRepresentation::ManualMarkdown => {
                    ("manual-markdown", post.markdown.as_str())
                }
            };
            let manual = target.provider == SyndicationProvider::Medium;
            let tag_plan = destination_tag_plan(target.provider, &post.source_path, &post.tags);
            let (payload_plan, payload_plan_error) =
                if target.provider == SyndicationProvider::Hashnode {
                    match hashnode_payload_plan(
                        &target.publication_id,
                        post,
                        state.record(&post.source_id, name),
                    ) {
                        Ok(plan) => (Some(plan), None),
                        Err(error) => (None, Some(error)),
                    }
                } else {
                    (None, None)
                };
            json!({
                "name": name,
                "provider": target.provider,
                "operation": if manual {
                    "manual-import"
                } else if state.record(&post.source_id, name).is_some() {
                    "update"
                } else {
                    "create"
                },
                "publicationIntent": if manual {
                    "manual"
                } else if publish && target.allow_publish {
                    "published"
                } else {
                    "draft"
                },
                "remoteRequestSent": false,
                "policy": policy,
                "contentPlan": post.content_plans.iter().find(|plan| plan.policy.provider == target.provider),
                "tagPlan": tag_plan,
                "payloadPlan": payload_plan,
                "payloadPlanError": payload_plan_error,
                "conversion": {
                    "from": {
                        "format": "authored-markdown",
                        "content": &post.source_markdown
                    },
                    "to": {
                        "format": format,
                        "content": content
                    }
                },
                "diagnostics": post.portable_diagnostics.iter().map(|diagnostic| diagnostic.scoped(format, match target.provider {
                    SyndicationProvider::Dev => "dev",
                    SyndicationProvider::Hashnode => "hashnode",
                    SyndicationProvider::Ghost => "ghost",
                    SyndicationProvider::Wordpress => "wordpress",
                    SyndicationProvider::Medium => "medium",
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "sourcePath": post.source_path,
        "sourceId": post.source_id,
        "slug": post.slug,
        "canonicalUrl": post.canonical_url,
        "revision": post.revision,
        "targets": targets,
    })
}

fn absolutize_markdown(markdown: &str, config: &SiteConfig) -> Result<String, String> {
    Url::parse(&format!("{}/", config.url.trim_end_matches('/')))
        .map_err(|_| "site url must be a complete public URL".to_string())?;
    let base = config.url.trim_end_matches('/');
    let mut spans = Vec::new();
    let mut code_block = false;
    let mut raw_inline_element = None;
    let mut parser = Parser::new_ext(markdown, MarkdownOptions::all()).into_offset_iter();
    let events: Vec<_> = parser.by_ref().collect();
    spans.extend(
        parser
            .reference_definitions()
            .iter()
            .map(|(_, definition)| {
                (
                    definition.span.clone(),
                    MarkdownSpanKind::ReferenceDefinition,
                )
            }),
    );
    for (event, range) in events {
        let kind = match event {
            Event::Start(Tag::CodeBlock(_)) => {
                code_block = true;
                Some(MarkdownSpanKind::Protected)
            }
            Event::End(TagEnd::CodeBlock) => {
                code_block = false;
                Some(MarkdownSpanKind::Protected)
            }
            _ if code_block => Some(MarkdownSpanKind::Protected),
            Event::Code(_) => Some(MarkdownSpanKind::Protected),
            Event::Html(_) => Some(MarkdownSpanKind::BlockHtml),
            Event::InlineHtml(html) => {
                let lower = html.trim_start().to_ascii_lowercase();
                let kind = if raw_inline_element.is_some() {
                    MarkdownSpanKind::Protected
                } else {
                    MarkdownSpanKind::InlineHtml
                };
                if raw_inline_element.is_some_and(|name| lower.starts_with(&format!("</{name}"))) {
                    raw_inline_element = None;
                } else if lower.starts_with("<script") {
                    raw_inline_element = Some("script");
                } else if lower.starts_with("<style") {
                    raw_inline_element = Some("style");
                }
                Some(kind)
            }
            _ if raw_inline_element.is_some() => Some(MarkdownSpanKind::Protected),
            _ => None,
        };
        if let Some(kind) = kind {
            spans.push((range, kind));
        }
    }
    spans.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for (range, kind) in spans {
        if range.start < cursor {
            continue;
        }
        out.push_str(&rewrite_plain_markdown(
            &markdown[cursor..range.start],
            base,
        ));
        let source = &markdown[range.clone()];
        match kind {
            MarkdownSpanKind::Protected => out.push_str(source),
            MarkdownSpanKind::InlineHtml => out.push_str(&rewrite_inline_html(source, base)),
            MarkdownSpanKind::BlockHtml => out.push_str(&absolutize_html(source, config)),
            MarkdownSpanKind::ReferenceDefinition => {
                out.push_str(&rewrite_reference_definition(source, base))
            }
        }
        cursor = range.end;
    }
    out.push_str(&rewrite_plain_markdown(&markdown[cursor..], base));
    Ok(out)
}

#[derive(Clone, Copy)]
enum MarkdownSpanKind {
    Protected,
    InlineHtml,
    BlockHtml,
    ReferenceDefinition,
}

fn rewrite_reference_definition(definition: &str, base: &str) -> String {
    let bytes = definition.as_bytes();
    let Some(closing_bracket) = bytes
        .iter()
        .enumerate()
        .find(|(index, byte)| **byte == b']' && !is_escaped(bytes, *index))
        .map(|(index, _)| index)
    else {
        return definition.to_string();
    };
    let mut cursor = closing_bracket + 1;
    if bytes.get(cursor) != Some(&b':') {
        return definition.to_string();
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'<') {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'/') || bytes.get(cursor + 1) == Some(&b'/') {
        return definition.to_string();
    }
    format!("{}{base}{}", &definition[..cursor], &definition[cursor..])
}

fn rewrite_plain_markdown(markdown: &str, base: &str) -> String {
    markdown
        .split_inclusive('\n')
        .map(|line| rewrite_markdown_line(line, base))
        .collect()
}

fn rewrite_inline_html(html: &str, base: &str) -> String {
    let trimmed = html.trim_start();
    if trimmed.starts_with('<')
        && trimmed
            .as_bytes()
            .get(1)
            .is_some_and(u8::is_ascii_alphabetic)
    {
        rewrite_html_attributes(html, base)
    } else {
        html.to_string()
    }
}

fn absolutize_html(html: &str, config: &SiteConfig) -> String {
    let base = config.url.trim_end_matches('/');
    let dom = html5ever::parse_fragment(
        RcDom::default(),
        Default::default(),
        QualName::new(None, ns!(html), local_name!("div")),
        Vec::new(),
        false,
    )
    .one(html);
    rewrite_element_urls(&dom.document, base);
    let Some(fragment_root) = find_element(&dom.document, "html") else {
        return html.to_string();
    };
    let mut output = Vec::with_capacity(html.len());
    let serializable = SerializableHandle::from(fragment_root);
    let options = SerializeOpts {
        traversal_scope: TraversalScope::ChildrenOnly(None),
        ..Default::default()
    };
    if html5ever::serialize(&mut output, &serializable, options).is_err() {
        return html.to_string();
    }
    String::from_utf8(output).unwrap_or_else(|_| html.to_string())
}

fn rewrite_element_urls(node: &Handle, base: &str) {
    if let NodeData::Element { attrs, .. } = &node.data {
        for attr in attrs.borrow_mut().iter_mut() {
            let name = attr.name.local.as_ref();
            let value = attr.value.as_ref();
            if matches!(name, "href" | "src") && value.starts_with('/') && !value.starts_with("//")
            {
                attr.value = format!("{base}{value}").into();
            }
        }
    }
    for child in node.children.borrow().iter() {
        rewrite_element_urls(child, base);
    }
}

fn find_element(node: &Handle, wanted: &str) -> Option<Handle> {
    if let NodeData::Element { name, .. } = &node.data {
        if name.local.as_ref().eq_ignore_ascii_case(wanted) {
            return Some(node.clone());
        }
    }
    node.children
        .borrow()
        .iter()
        .find_map(|child| find_element(child, wanted))
}

fn rewrite_markdown_line(line: &str, base: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut index = 0;
    let mut code_ticks = None;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let count = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if code_ticks.is_none() {
                code_ticks = Some(count);
            } else if code_ticks == Some(count) {
                code_ticks = None;
            }
            out.push_str(&line[index..index + count]);
            index += count;
            continue;
        }
        if code_ticks.is_none() && bytes[index] == b']' && !is_escaped(bytes, index) {
            let mut cursor = index + 1;
            let destination_marker = bytes.get(cursor) == Some(&b'(')
                || (bytes.get(cursor) == Some(&b':') && is_reference_definition(bytes, index));
            if destination_marker {
                cursor += 1;
                while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                    cursor += 1;
                }
                let root = if bytes.get(cursor) == Some(&b'<') {
                    cursor += 1;
                    bytes.get(cursor) == Some(&b'/') && bytes.get(cursor + 1) != Some(&b'/')
                } else {
                    bytes.get(cursor) == Some(&b'/') && bytes.get(cursor + 1) != Some(&b'/')
                };
                if root {
                    out.push_str(&line[index..cursor]);
                    out.push_str(base);
                    index = cursor;
                    continue;
                }
            }
        }
        let length = line[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        out.push_str(&line[index..index + length]);
        index += length;
    }
    out
}

fn rewrite_html_attributes(html: &str, base: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut index = 0;
    while index < html.len() {
        if let Some((value_start, next)) = root_html_attribute(html, index) {
            out.push_str(&html[index..value_start]);
            out.push_str(base);
            index = next;
            continue;
        }
        let length = html[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        out.push_str(&html[index..index + length]);
        index += length;
    }
    out
}

fn root_html_attribute(input: &str, index: usize) -> Option<(usize, usize)> {
    let bytes = input.as_bytes();
    let remaining = &input[index..];
    let name = if remaining
        .get(..4)
        .is_some_and(|value| value.eq_ignore_ascii_case("href"))
    {
        "href"
    } else if remaining
        .get(..3)
        .is_some_and(|value| value.eq_ignore_ascii_case("src"))
    {
        "src"
    } else {
        return None;
    };
    if index > 0 && !bytes[index - 1].is_ascii_whitespace() && bytes[index - 1] != b'<' {
        return None;
    }
    let mut cursor = index + name.len();
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'=') {
        return None;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if matches!(bytes.get(cursor), Some(b'\'' | b'"')) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'/') || bytes.get(cursor + 1) == Some(&b'/') {
        return None;
    }
    Some((cursor, cursor))
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let slashes = bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    slashes % 2 == 1
}

fn is_reference_definition(line: &[u8], closing_bracket: usize) -> bool {
    let indentation = line.iter().take_while(|byte| **byte == b' ').count();
    indentation <= 3
        && line.get(indentation) == Some(&b'[')
        && line.get(indentation + 1) != Some(&b'^')
        && closing_bracket > indentation + 1
}

trait ProviderAdapter {
    fn name(&self) -> &'static str;
    fn validate(&self) -> Result<(), String>;
    fn credential(&self) -> Result<String, String>;
    fn request(
        &self,
        post: &SyndicationPost,
        existing: Option<&StateRecord>,
        publish: bool,
        credential: &str,
    ) -> Result<Request, String>;
    fn outcome(&self, body: &Json) -> Result<Outcome, String>;
    fn warning(&self) -> Option<&'static str> {
        None
    }
}

struct DevAdapter;
struct HashnodeAdapter<'a> {
    publication_id: &'a str,
}
struct GhostAdapter<'a> {
    endpoint: &'a str,
}
struct WordpressAdapter<'a> {
    endpoint: &'a str,
    publication_id: &'a str,
}
struct MediumAdapter;

enum DestinationAdapter<'a> {
    Remote(Box<dyn ProviderAdapter + 'a>),
    Manual(MediumAdapter),
}

impl DestinationAdapter<'_> {
    fn name(&self) -> &'static str {
        match self {
            Self::Remote(adapter) => adapter.name(),
            Self::Manual(_) => "Medium",
        }
    }

    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Remote(adapter) => adapter.validate(),
            Self::Manual(_) => Ok(()),
        }
    }
}

fn provider_adapter(target: &SyndicationTargetConfig) -> DestinationAdapter<'_> {
    match target.provider {
        SyndicationProvider::Dev => DestinationAdapter::Remote(Box::new(DevAdapter)),
        SyndicationProvider::Hashnode => DestinationAdapter::Remote(Box::new(HashnodeAdapter {
            publication_id: &target.publication_id,
        })),
        SyndicationProvider::Ghost => DestinationAdapter::Remote(Box::new(GhostAdapter {
            endpoint: &target.endpoint,
        })),
        SyndicationProvider::Wordpress => DestinationAdapter::Remote(Box::new(WordpressAdapter {
            endpoint: &target.endpoint,
            publication_id: &target.publication_id,
        })),
        SyndicationProvider::Medium => DestinationAdapter::Manual(MediumAdapter),
    }
}

fn environment_credential(variable: &str, provider: &str) -> Result<String, String> {
    std::env::var(variable)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{provider} requires {variable} in the server environment"))
}

impl ProviderAdapter for DevAdapter {
    fn name(&self) -> &'static str {
        "DEV"
    }
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
    fn credential(&self) -> Result<String, String> {
        environment_credential("DEVTO_API_KEY", self.name())
    }
    fn request(
        &self,
        post: &SyndicationPost,
        existing: Option<&StateRecord>,
        publish: bool,
        credential: &str,
    ) -> Result<Request, String> {
        dev_request(post, existing, publish, credential)
    }
    fn outcome(&self, body: &Json) -> Result<Outcome, String> {
        outcome_from_fields(self.name(), &body["id"], &body["url"], "")
    }
}

impl ProviderAdapter for HashnodeAdapter<'_> {
    fn name(&self) -> &'static str {
        "Hashnode"
    }
    fn validate(&self) -> Result<(), String> {
        if self.publication_id.trim().is_empty() {
            Err("Hashnode target requires publicationId (and an eligible Pro publication)".into())
        } else {
            Ok(())
        }
    }
    fn credential(&self) -> Result<String, String> {
        environment_credential("HASHNODE_PAT", self.name())
    }
    fn request(
        &self,
        post: &SyndicationPost,
        existing: Option<&StateRecord>,
        publish: bool,
        credential: &str,
    ) -> Result<Request, String> {
        let request = hashnode_request(self.publication_id, post, existing, publish, credential)?;
        destination_payload_plan(
            SyndicationProvider::Hashnode,
            &post.source_path,
            request.body.to_string().len(),
        )
        .validate()?;
        Ok(request)
    }
    fn outcome(&self, body: &Json) -> Result<Outcome, String> {
        if let Some(errors) = body.get("errors").filter(|errors| !errors.is_null()) {
            let errors = errors
                .as_array()
                .ok_or("Hashnode returned a malformed GraphQL errors field")?;
            if let Some(error) = errors.first() {
                let reason = match error["extensions"]["code"].as_str() {
                    Some("UNAUTHENTICATED") => status_error(401),
                    Some("FORBIDDEN") => status_error(403),
                    Some("NOT_FOUND") => status_error(404),
                    Some("BAD_USER_INPUT") => status_error(422),
                    Some("INTERNAL_SERVER_ERROR") => status_error(500),
                    _ => {
                        "GraphQL returned an error; inspect the provider dashboard before retrying"
                            .into()
                    }
                };
                return Err(format!("Hashnode rejected the request: {reason}"));
            }
        }
        let draft = if body["data"]["createDraft"]["draft"].is_object() {
            &body["data"]["createDraft"]["draft"]
        } else {
            &body["data"]["updateDraft"]["draft"]
        };
        outcome_from_fields(self.name(), &draft["id"], &draft["slug"], "")
    }
}

impl ProviderAdapter for GhostAdapter<'_> {
    fn name(&self) -> &'static str {
        "Ghost"
    }
    fn validate(&self) -> Result<(), String> {
        validated_endpoint(self.endpoint, "Ghost endpoint").map(|_| ())
    }
    fn credential(&self) -> Result<String, String> {
        environment_credential("GHOST_ADMIN_API_KEY", self.name())
    }
    fn request(
        &self,
        post: &SyndicationPost,
        existing: Option<&StateRecord>,
        publish: bool,
        credential: &str,
    ) -> Result<Request, String> {
        ghost_request(self.endpoint, post, existing, publish, credential)
    }
    fn outcome(&self, body: &Json) -> Result<Outcome, String> {
        let revision = body["posts"][0]["updated_at"].as_str()
            .filter(|revision| !revision.trim().is_empty())
            .ok_or("Ghost response did not contain an updated_at revision; inspect the remote draft before retrying")?;
        outcome_from_fields(
            self.name(),
            &body["posts"][0]["id"],
            &body["posts"][0]["url"],
            revision,
        )
    }
}

impl ProviderAdapter for WordpressAdapter<'_> {
    fn name(&self) -> &'static str {
        "WordPress"
    }
    fn validate(&self) -> Result<(), String> {
        if self.publication_id.trim().is_empty() {
            validated_endpoint(self.endpoint, "WordPress endpoint").map(|_| ())
        } else {
            Ok(())
        }
    }
    fn credential(&self) -> Result<String, String> {
        if self.publication_id.trim().is_empty() {
            let username = std::env::var("WORDPRESS_USERNAME").unwrap_or_default();
            let password = std::env::var("WORDPRESS_APPLICATION_PASSWORD").unwrap_or_default();
            if username.trim().is_empty() || password.trim().is_empty() {
                return Err("self-hosted WordPress requires WORDPRESS_USERNAME and WORDPRESS_APPLICATION_PASSWORD".into());
            }
            Ok(format!(
                "Basic {}",
                STANDARD.encode(format!("{username}:{password}"))
            ))
        } else {
            environment_credential("WORDPRESS_ACCESS_TOKEN", self.name())
        }
    }
    fn request(
        &self,
        post: &SyndicationPost,
        existing: Option<&StateRecord>,
        publish: bool,
        credential: &str,
    ) -> Result<Request, String> {
        wordpress_request(
            self.endpoint,
            self.publication_id,
            post,
            existing,
            publish,
            credential,
        )
    }
    fn outcome(&self, body: &Json) -> Result<Outcome, String> {
        outcome_from_fields(self.name(), &body["id"], &body["link"], "")
    }
    fn warning(&self) -> Option<&'static str> {
        Some("core WordPress cannot set an external canonical URL; verify your SEO plugin or use WordPress as the original publisher")
    }
}

impl MediumAdapter {
    fn instruction(&self, post: &SyndicationPost) -> String {
        format!(
            "manual import only — open Medium's Import a story and paste {}",
            post.canonical_url
        )
    }
}

fn common_headers(authorization: (&str, String)) -> Vec<(String, String)> {
    vec![
        ("Content-Type".into(), "application/json".into()),
        (authorization.0.into(), authorization.1),
    ]
}

fn dev_request(
    post: &SyndicationPost,
    existing: Option<&StateRecord>,
    publish: bool,
    credential: &str,
) -> Result<Request, String> {
    let tags = destination_tag_plan(SyndicationProvider::Dev, &post.source_path, &post.tags);
    tags.validate()?;
    let (method, url) = match existing {
        Some(record) if !record.remote_id.is_empty() => (
            "PUT",
            format!("https://dev.to/api/articles/{}", record.remote_id),
        ),
        _ => ("POST", "https://dev.to/api/articles".into()),
    };
    let mut headers = common_headers(("api-key", credential.into()));
    headers.push(("Accept".into(), "application/vnd.forem.api-v1+json".into()));
    Ok(Request {
        method,
        url,
        headers,
        body: json!({"article": {
            "title": post.title,
            "body_markdown": post.markdown,
            "published": publish,
            "canonical_url": post.canonical_url,
            "description": post.description,
            "tags": tags.tags.join(",")
        }}),
    })
}

fn hashnode_payload_plan(
    publication_id: &str,
    post: &SyndicationPost,
    existing: Option<&StateRecord>,
) -> Result<DestinationPayloadPlan, String> {
    let request = hashnode_request(publication_id, post, existing, false, "")?;
    Ok(destination_payload_plan(
        SyndicationProvider::Hashnode,
        &post.source_path,
        request.body.to_string().len(),
    ))
}

fn hashnode_request(
    publication_id: &str,
    post: &SyndicationPost,
    existing: Option<&StateRecord>,
    publish: bool,
    credential: &str,
) -> Result<Request, String> {
    if publication_id.trim().is_empty() {
        return Err(
            "Hashnode target requires publicationId (and an eligible Pro publication)".into(),
        );
    }
    let tag_plan =
        destination_tag_plan(SyndicationProvider::Hashnode, &post.source_path, &post.tags);
    tag_plan.validate()?;
    let tags: Vec<Json> = tag_plan
        .tags
        .iter()
        .map(|name| json!({"name": name, "slug": slug(name)}))
        .collect();
    let input = json!({
        "title": post.title,
        "subtitle": post.subtitle.as_deref().unwrap_or(&post.description),
        "slug": post.slug,
        "contentMarkdown": post.markdown, "originalArticleURL": post.canonical_url, "tags": tags
    });
    let (query, variables) = if let Some(record) = existing {
        ("mutation Update($input: UpdateDraftInput!) { updateDraft(input: $input) { draft { id slug } } }",
         json!({"input": merge_object(input, json!({"draftId": record.remote_id}))}))
    } else {
        ("mutation Create($input: CreateDraftInput!) { createDraft(input: $input) { draft { id slug } } }",
         json!({"input": merge_object(input, json!({"publicationId": publication_id}))}))
    };
    // Hashnode requires a separate publishDraft mutation. A first stable iteration
    // deliberately keeps this adapter draft-only rather than risking a second write.
    if publish {
        return Err("Hashnode public publishing is not yet automated; create/update a draft and publish it in Hashnode".into());
    }
    Ok(Request {
        method: "POST",
        url: HASHNODE_ENDPOINT.into(),
        headers: common_headers(("Authorization", format!("Bearer {credential}"))),
        body: json!({"query": query, "variables": variables}),
    })
}

fn merge_object(mut left: Json, right: Json) -> Json {
    if let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object()) {
        left.extend(right.clone());
    }
    left
}

fn ghost_request(
    endpoint: &str,
    post: &SyndicationPost,
    existing: Option<&StateRecord>,
    publish: bool,
    credential: &str,
) -> Result<Request, String> {
    let base = validated_endpoint(endpoint, "Ghost endpoint")?;
    let token = ghost_token(credential)?;
    let url = match existing {
        Some(record) if !record.remote_id.is_empty() => format!(
            "{}/ghost/api/admin/posts/{}/?source=html",
            base.trim_end_matches('/'),
            record.remote_id
        ),
        _ => format!(
            "{}/ghost/api/admin/posts/?source=html",
            base.trim_end_matches('/')
        ),
    };
    let mut payload = json!({"title": post.title, "slug": post.slug, "html": post.html, "custom_excerpt": post.description, "canonical_url": post.canonical_url, "status": if publish {"published"} else {"draft"}});
    if let Some(record) = existing {
        if record.remote_revision.is_empty() {
            return Err("saved Ghost state has no updated_at revision; create a fresh draft state before updating".into());
        }
        payload["updated_at"] = Json::String(record.remote_revision.clone());
    }
    Ok(Request {
        method: if existing.is_some() { "PUT" } else { "POST" },
        url,
        headers: common_headers(("Authorization", format!("Ghost {token}"))),
        body: json!({"posts": [payload]}),
    })
}

fn ghost_token(key: &str) -> Result<String, String> {
    let (id, secret) = key
        .split_once(':')
        .ok_or("GHOST_ADMIN_API_KEY must have id:hex-secret form")?;
    let secret = decode_hex(secret).ok_or("GHOST_ADMIN_API_KEY has an invalid hex secret")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let header = URL_SAFE_NO_PAD.encode(json!({"alg":"HS256","typ":"JWT","kid":id}).to_string());
    let claims =
        URL_SAFE_NO_PAD.encode(json!({"iat":now,"exp":now + 300,"aud":"/admin/"}).to_string());
    let unsigned = format!("{header}.{claims}");
    let mut mac = Hmac::<Sha256>::new_from_slice(&secret).map_err(|_| "invalid Ghost key")?;
    mac.update(unsigned.as_bytes());
    Ok(format!(
        "{unsigned}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect()
}

fn wordpress_request(
    endpoint: &str,
    publication_id: &str,
    post: &SyndicationPost,
    existing: Option<&StateRecord>,
    publish: bool,
    credential: &str,
) -> Result<Request, String> {
    let base = if publication_id.trim().is_empty() {
        validated_endpoint(endpoint, "WordPress endpoint")?
    } else {
        format!(
            "https://public-api.wordpress.com/wp/v2/sites/{}",
            publication_id.trim()
        )
    };
    let suffix = existing
        .filter(|record| !record.remote_id.is_empty())
        .map(|record| format!("/posts/{}", record.remote_id))
        .unwrap_or_else(|| "/posts".into());
    Ok(Request {
        method: "POST",
        url: format!("{}{suffix}", base.trim_end_matches('/')),
        headers: common_headers((
            "Authorization",
            if credential.starts_with("Basic ") {
                credential.to_string()
            } else {
                format!("Bearer {credential}")
            },
        )),
        body: json!({"title": post.title, "content": post.html, "excerpt": post.description, "slug": post.slug, "status": if publish {"publish"} else {"draft"}}),
    })
}

fn validated_endpoint(value: &str, label: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| format!("{label} must be a complete HTTPS URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{label} must be HTTPS without credentials, query, or fragment"
        ));
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn slug(value: &str) -> String {
    openblog_core::slug::slugify(value)
}

struct Outcome {
    id: String,
    url: String,
    remote_revision: String,
}

fn execute(
    adapter: &dyn ProviderAdapter,
    transport: &dyn Transport,
    request: &Request,
) -> Result<Outcome, String> {
    let response = transport.send(request)?;
    if response.body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("provider response exceeded 1 MiB or could not be read".into());
    }
    if !(200..300).contains(&response.status) {
        return Err(status_error(response.status));
    }
    let body: Json = serde_json::from_slice(&response.body)
        .map_err(|_| format!("{} returned invalid JSON", adapter.name()))?;
    adapter.outcome(&body)
}

fn outcome_from_fields(
    provider: &str,
    id: &Json,
    url: &Json,
    remote_revision: &str,
) -> Result<Outcome, String> {
    let id = id
        .as_str()
        .map(str::to_string)
        .or_else(|| id.as_u64().map(|id| id.to_string()))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| format!("{provider} response did not contain a remote ID"))?;
    Ok(Outcome {
        id,
        url: url.as_str().unwrap_or_default().to_string(),
        remote_revision: remote_revision.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post_fixture() -> SyndicationPost {
        SyndicationPost {
            source_id: "post-1".into(),
            source_path: "posts/a.md".into(),
            slug: "a".into(),
            title: "A".into(),
            subtitle: None,
            description: "D".into(),
            markdown: "Body".into(),
            html: "<p>Body</p>".into(),
            tags: vec!["Rust".into()],
            canonical_url: "https://blog.example/posts/a/".into(),
            revision: "abc".into(),
            source_markdown: "Body".into(),
            portable_diagnostics: Vec::new(),
            content_plans: Vec::new(),
        }
    }

    #[test]
    fn hashnode_drafts_use_the_documented_canonical_input_on_create_and_update() {
        let post = post_fixture();
        let record = StateRecord {
            remote_id: "draft-id".into(),
            ..Default::default()
        };
        for existing in [None, Some(&record)] {
            let request =
                hashnode_request("publication", &post, existing, false, "unused").unwrap();
            let input = &request.body["variables"]["input"];
            assert_eq!(input["originalArticleURL"], post.canonical_url);
            assert!(input.get("canonicalUrl").is_none());
        }
    }

    #[test]
    fn hashnode_payload_budget_counts_the_serialized_envelope_on_create_and_update() {
        let adapter = HashnodeAdapter {
            publication_id: "publication",
        };
        let record = StateRecord {
            remote_id: "draft".into(),
            ..Default::default()
        };
        for existing in [None, Some(&record)] {
            let mut post = post_fixture();
            post.markdown.clear();
            let overhead = hashnode_request("publication", &post, existing, false, "unused")
                .unwrap()
                .body
                .to_string()
                .len();
            post.markdown = "a".repeat(100_000 - overhead);
            let request = adapter.request(&post, existing, false, "unused").unwrap();
            assert_eq!(request.body.to_string().len(), 100_000);
            post.markdown.push('a');
            assert!(adapter
                .request(&post, existing, false, "unused")
                .unwrap_err()
                .contains("100001 UTF-8 bytes"));
            post.markdown = "é\n\"".repeat(20_000);
            let request =
                hashnode_request("publication", &post, existing, false, "unused").unwrap();
            let bytes = request.body.to_string().len();
            assert!(
                bytes > post.markdown.len(),
                "JSON escaping and the envelope must count"
            );
            let target = SyndicationTargetConfig {
                provider: SyndicationProvider::Hashnode,
                publication_id: "publication".into(),
                ..Default::default()
            };
            let mut state = State::default();
            if let Some(record) = existing {
                state.insert(&post.source_id, "hashnode", record.clone());
            }
            let name = "hashnode".to_string();
            let plan = dry_run_json_plan(&post, &[(&name, &target)], &state, false);
            assert_eq!(plan["targets"][0]["payloadPlan"]["bodyBytes"], bytes);
            assert_eq!(
                plan["targets"][0]["payloadPlan"]["diagnostics"][0]["code"],
                "destination-payload-limit"
            );
            assert!(plan["targets"][0]["payloadPlanError"].is_null());
        }
    }

    #[test]
    fn destination_tag_plans_match_create_and_update_payloads_and_keep_source_unchanged() {
        let mut post = post_fixture();
        post.tags = (0..16).map(|index| format!("tag{index}")).collect();
        let before = post.clone();
        let record = StateRecord {
            remote_id: "remote".into(),
            ..Default::default()
        };
        let selected = [
            (
                "dev".to_string(),
                SyndicationTargetConfig {
                    provider: SyndicationProvider::Dev,
                    ..Default::default()
                },
            ),
            (
                "hashnode".to_string(),
                SyndicationTargetConfig {
                    provider: SyndicationProvider::Hashnode,
                    publication_id: "publication".into(),
                    ..Default::default()
                },
            ),
        ];
        let targets = selected
            .iter()
            .map(|(name, target)| (name, target))
            .collect::<Vec<_>>();
        let plan = dry_run_json_plan(&post, &targets, &State::default(), false);
        for existing in [None, Some(&record)] {
            let dev = dev_request(&post, existing, false, "unused").unwrap();
            let hashnode =
                hashnode_request("publication", &post, existing, false, "unused").unwrap();
            for (index, count) in [(0, 4), (1, 15)] {
                let tags = &plan["targets"][index]["tagPlan"];
                assert_eq!(tags["tags"].as_array().unwrap().len(), count);
                assert_eq!(tags["omittedTags"].as_array().unwrap().len(), 16 - count);
                assert_eq!(tags["diagnostics"][0]["code"], "destination-tag-limit");
                assert_eq!(
                    tags["policy"]["provider"],
                    plan["targets"][index]["provider"]
                );
            }
            assert_eq!(dev.body["article"]["tags"], post.tags[..4].join(","));
            let hashnode_tags = hashnode.body["variables"]["input"]["tags"]
                .as_array()
                .unwrap();
            assert_eq!(hashnode_tags.len(), 15);
            for (tag, name) in hashnode_tags.iter().zip(&post.tags) {
                assert_eq!(tag["name"], *name);
                assert_eq!(tag["slug"], *name);
            }
        }
        assert_eq!(post, before);
        post.tags = vec!["invalid-dev".into()];
        assert!(dev_request(&post, None, false, "unused").is_err());
        post.tags = vec!["Same Tag".into(), "same-tag".into()];
        assert!(hashnode_request("publication", &post, None, false, "unused").is_err());
    }

    #[test]
    fn portability_fixtures_cover_syndication_payload_surfaces() {
        use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};

        let manifest: Json = serde_json::from_str(include_str!(
            "../../../tests/fixtures/portability-contract.json"
        ))
        .unwrap();
        for fixture in manifest["fixtures"].as_array().unwrap() {
            if fixture["expected"]["public"] == false {
                continue;
            }

            let path = fixture["path"].as_str().unwrap();
            let source = fixture["source"].as_str().unwrap();
            let config = SiteConfig::from_json(&fixture["config"].to_string()).unwrap();
            let credits = fixture
                .get("credits")
                .map(|sidecar| SourceFile {
                    path: path
                        .strip_suffix(".md")
                        .map(|stem| format!("{stem}.credits.json"))
                        .unwrap(),
                    contents: sidecar.to_string(),
                })
                .into_iter()
                .collect();
            let site = Site::load(
                config.clone(),
                Sources {
                    posts: vec![SourceFile {
                        path: path.into(),
                        contents: source.into(),
                    }],
                    credits,
                    ..Default::default()
                },
                LoadOptions::default(),
            )
            .unwrap_or_else(|errors| panic!("{}: {errors:?}", fixture["name"]));
            let post = syndication_post(&site.posts[0], source, &config, None, None)
                .unwrap_or_else(|error| panic!("{}: {error}", fixture["name"]));

            let dev = dev_request(&post, None, false, "test").unwrap();
            assert_eq!(dev.body["article"]["body_markdown"], post.markdown);
            let hashnode = hashnode_request("publication", &post, None, false, "test").unwrap();
            assert_eq!(
                hashnode.body["variables"]["input"]["contentMarkdown"],
                post.markdown
            );
            let ghost = ghost_request(
                "https://ghost.example",
                &post,
                None,
                false,
                "abc:00112233445566778899aabbccddeeff",
            )
            .unwrap();
            assert_eq!(ghost.body["posts"][0]["html"], post.html);
            let wordpress = wordpress_request(
                "https://wordpress.example/wp-json/wp/v2",
                "",
                &post,
                None,
                false,
                "test",
            )
            .unwrap();
            assert_eq!(wordpress.body["content"], post.html);
            assert!(MediumAdapter
                .instruction(&post)
                .contains(&post.canonical_url));

            if fixture["name"] == "knowledge-check" {
                assert!(post.markdown.contains("**Question:**"));
                assert!(!post.markdown.contains("```quiz"));
                assert!(!post.html.contains("<ob-quiz"));
            }
        }
    }

    #[test]
    fn a_part_of_a_collaborative_series_links_its_series_in_every_payload() {
        use openblog_core::contributor::Contributor;
        use openblog_core::{LoadOptions, Site, SourceFile, Sources};

        let mut config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://blog.example.org","postPath":"/{slug}/","author":{"name":"Site Owner"}}"#,
        )
        .unwrap();
        for (id, name) in [("ann", "Ann"), ("bo", "Bo")] {
            config.contributors.insert(
                id.into(),
                Contributor {
                    name: name.into(),
                    ..Contributor::default()
                },
            );
        }
        let file = |path: &str, contents: &str| SourceFile {
            path: path.into(),
            contents: contents.into(),
        };
        let source = "---
title: Two
date: 2026-02-01
series: letters
---
Body of two.
";
        let loaded = Site::load(
            config.clone(),
            Sources {
                posts: vec![
                    file(
                        "posts/one.md",
                        "---
title: One
date: 2026-01-01
series: letters
---
Body of one.
",
                    ),
                    file("posts/two.md", source),
                ],
                credits: vec![file(
                    "posts/two.credits.json",
                    r#"{"version":1,"credits":[{"contributor":"ann","roles":[{"vocabulary":"crossref","role":"author"}]},{"contributor":"bo","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
                )],
                series: vec![file(
                    "series/letters.md",
                    "---
name: Letters
---
A recurring premise.
",
                )],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let part = loaded.posts.iter().find(|post| post.slug == "two").unwrap();
        let context = loaded.series_context(part);
        assert!(context.is_some());
        let post = syndication_post(part, source, &config, context, None).unwrap();
        let series_url = "https://blog.example.org/series/letters/";
        assert!(
            post.markdown.contains(&format!(
                "## Series

Part 2 in the series [Letters]({series_url}). This part is by Ann and Bo. Series contributors: Site Owner, Ann, and Bo."
            )),
            "{}",
            post.markdown
        );
        assert!(
            post.html.contains(&format!(
                "<p class=\"ob-series-context\">Part 2 in the series <a href=\"{series_url}\">Letters</a>. This part is by Ann and Bo."
            )),
            "{}",
            post.html
        );
        // The copy with its series is a different revision from one without, so a syndicated
        // part is updated when its context first appears.
        let plain = syndication_post(part, source, &config, None, None).unwrap();
        assert!(!plain.markdown.contains(series_url) && !plain.html.contains(series_url));
        assert_ne!(post.revision, plain.revision);
    }

    #[test]
    fn universal_publishing_example_uses_exact_portable_artifacts_for_every_destination() {
        use openblog_core::{LoadOptions, Site, SourceFile, Sources};

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("portable-publishing");
        let config = site::load_config(&root).unwrap();
        let source =
            include_str!("../../../examples/portable-publishing/content/posts/portable-lesson.md");
        let loaded = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/portable-lesson.md".into(),
                    contents: source.into(),
                }],
                credits: vec![SourceFile {
                    path: "posts/portable-lesson.credits.json".into(),
                    contents: include_str!(
                        "../../../examples/portable-publishing/content/posts/portable-lesson.credits.json"
                    ).into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        ).unwrap();
        let post = syndication_post(&loaded.posts[0], source, &config, None, None).unwrap();
        let selected = select_targets(&config, &[]).unwrap();
        let plan = dry_run_json_plan(&post, &selected, &State::default(), false);
        assert_eq!(plan["targets"].as_array().unwrap().len(), 5);
        for target in plan["targets"].as_array().unwrap() {
            let content_plan = &target["contentPlan"];
            assert_eq!(content_plan["policy"], target["policy"]);
            assert_eq!(content_plan["policy"]["mediaDelivery"], "hosted-urls-only");
            assert!(!content_plan["images"].as_array().unwrap().is_empty());
            assert!(content_plan["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == "destination-media-unverified"
                    && finding["destination"] == target["provider"]));
            let artifact = &target["conversion"]["to"];
            let expected = if target["provider"] == "ghost" || target["provider"] == "wordpress" {
                &post.html
            } else {
                &post.markdown
            };
            assert_eq!(artifact["content"], *expected);
            let content = artifact["content"].as_str().unwrap();
            for essential in [
                "Alex Example",
                "Supporting study",
                "Open in Rust Playground",
                "Join the discussion",
            ] {
                assert!(content.contains(essential), "{essential}: {artifact}");
            }
            for private in [
                "PRIVATE_",
                "runner.example.org",
                "discussion.example.org",
                "<ob-",
            ] {
                assert!(!content.contains(private), "{private}: {artifact}");
            }
            assert_eq!(target["remoteRequestSent"], false);
            assert_eq!(
                target["publicationIntent"],
                if target["provider"] == "medium" {
                    "manual"
                } else {
                    "draft"
                }
            );
        }
        assert_eq!(
            dev_request(&post, None, false, "fixture").unwrap().body["article"]["body_markdown"],
            post.markdown
        );
        assert_eq!(
            hashnode_request("fixture", &post, None, false, "fixture")
                .unwrap()
                .body["variables"]["input"]["contentMarkdown"],
            post.markdown
        );
        assert_eq!(
            ghost_request(
                "https://ghost.example.org",
                &post,
                None,
                false,
                "abc:00112233445566778899aabbccddeeff"
            )
            .unwrap()
            .body["posts"][0]["html"],
            post.html
        );
        assert_eq!(
            wordpress_request(
                "https://wordpress.example.org/wp-json/wp/v2",
                "",
                &post,
                None,
                false,
                "fixture"
            )
            .unwrap()
            .body["content"],
            post.html
        );
        assert!(MediumAdapter
            .instruction(&post)
            .contains(&post.canonical_url));

        struct NoRequests;
        impl Transport for NoRequests {
            fn send(&self, _: &Request) -> Result<Response, String> {
                panic!("a dry-run plan must not send a request");
            }
        }
        for json in [false, true] {
            run_with_transport(
                &root,
                "portable-lesson",
                Options {
                    json,
                    target_names: Vec::new(),
                    write: false,
                    publish: false,
                },
                &NoRequests,
            )
            .unwrap();
        }
        assert!(!root.join(".openblog/syndication.json").exists());
    }

    #[test]
    fn json_dry_run_plan_contains_deterministic_before_and_after_without_remote_intent() {
        let post = post_fixture();
        let state = State::default();
        let name = "dev".to_string();
        let target = SyndicationTargetConfig {
            provider: SyndicationProvider::Dev,
            ..Default::default()
        };
        let selected = [(&name, &target)];
        let plan = dry_run_json_plan(&post, &selected, &state, false);
        let serialized = serde_json::to_string(&plan).unwrap();
        assert_eq!(
            serialized,
            serde_json::to_string(&dry_run_json_plan(&post, &selected, &state, false)).unwrap()
        );
        assert_eq!(plan["targets"][0]["operation"], "create");
        assert_eq!(plan["targets"][0]["publicationIntent"], "draft");
        assert_eq!(plan["targets"][0]["remoteRequestSent"], false);
        assert_eq!(plan["targets"][0]["conversion"]["from"]["content"], "Body");
        assert_eq!(
            plan["targets"][0]["conversion"]["to"]["format"],
            "portable-markdown"
        );
        assert_eq!(plan["targets"][0]["conversion"]["to"]["content"], "Body");
    }

    #[test]
    fn dev_create_is_a_draft_with_canonical_and_update_uses_remote_id() {
        let post = post_fixture();
        let create = dev_request(&post, None, false, "secret").unwrap();
        assert_eq!(create.method, "POST");
        assert_eq!(create.body["article"]["published"], false);
        assert_eq!(create.body["article"]["canonical_url"], post.canonical_url);
        let state = StateRecord {
            remote_id: "42".into(),
            ..Default::default()
        };
        let update = dev_request(&post, Some(&state), false, "secret").unwrap();
        assert_eq!(update.method, "PUT");
        assert!(update.url.ends_with("/42"));
    }

    #[test]
    fn wordpress_and_ghost_default_to_drafts() {
        let post = post_fixture();
        assert_eq!(
            wordpress_request(
                "https://wp.example/wp-json/wp/v2",
                "",
                &post,
                None,
                false,
                "x",
            )
            .unwrap()
            .body["status"],
            "draft"
        );
        let request = ghost_request(
            "https://ghost.example",
            &post,
            None,
            false,
            "abc:00112233445566778899aabbccddeeff",
        )
        .unwrap();
        assert_eq!(request.body["posts"][0]["status"], "draft");
        assert_eq!(
            request.body["posts"][0]["canonical_url"],
            post.canonical_url
        );
        let state = StateRecord {
            remote_id: "post-id".into(),
            remote_revision: "2026-10-24T12:00:00.000Z".into(),
            ..Default::default()
        };
        let update = ghost_request(
            "https://ghost.example",
            &post,
            Some(&state),
            false,
            "abc:00112233445566778899aabbccddeeff",
        )
        .unwrap();
        assert_eq!(update.method, "PUT");
        assert_eq!(update.body["posts"][0]["updated_at"], state.remote_revision);
    }

    #[test]
    fn hashnode_subtitle_prefers_the_post_subtitle_over_the_description() {
        let mut post = post_fixture();
        let request = hashnode_request("pub-id", &post, None, false, "pat").unwrap();
        assert_eq!(request.body["variables"]["input"]["subtitle"], "D");
        post.subtitle = Some("S".into());
        let request = hashnode_request("pub-id", &post, None, false, "pat").unwrap();
        assert_eq!(request.body["variables"]["input"]["subtitle"], "S");
    }

    #[test]
    fn subtitle_changes_revise_the_syndication_revision() {
        use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};

        let config = SiteConfig::from_json(r#"{"url":"https://blog.openblog.dev"}"#).unwrap();
        let revision = |front: &str| {
            let source =
                format!("---\ntitle: Post\nslug: post\ndate: 2020-01-01\n{front}---\n\nBody\n");
            let site = Site::load(
                config.clone(),
                Sources {
                    posts: vec![SourceFile {
                        path: "posts/post.md".into(),
                        contents: source.clone(),
                    }],
                    ..Default::default()
                },
                LoadOptions::default(),
            )
            .unwrap();
            syndication_post(&site.posts[0], &source, &config, None, None)
                .unwrap()
                .revision
        };
        let plain = revision("");
        assert_eq!(plain, revision("subtitle: \"\"\n"));
        assert_ne!(plain, revision("subtitle: A new angle\n"));
    }

    #[test]
    fn hashnode_request_is_draft_only_and_updates_by_saved_id() {
        let post = post_fixture();
        let create = hashnode_request("pub-id", &post, None, false, "pat").unwrap();
        assert!(create.body["query"]
            .as_str()
            .unwrap()
            .contains("createDraft"));
        assert_eq!(create.body["variables"]["input"]["publicationId"], "pub-id");
        let state = StateRecord {
            remote_id: "draft-id".into(),
            ..Default::default()
        };
        let update = hashnode_request("pub-id", &post, Some(&state), false, "pat").unwrap();
        assert!(update.body["query"]
            .as_str()
            .unwrap()
            .contains("updateDraft"));
        assert_eq!(update.body["variables"]["input"]["draftId"], "draft-id");
        assert!(hashnode_request("pub-id", &post, None, true, "pat").is_err());
    }

    #[test]
    fn state_uses_nested_source_and_target_identities_without_delimiter_collisions() {
        let mut state = State::default();
        state.insert("a\nb", "c", StateRecord::default());
        state.insert("a", "b\nc", StateRecord::default());
        assert!(state.record("a\nb", "c").is_some());
        assert!(state.record("a", "b\nc").is_some());
        assert_eq!(state.records.len(), 2);
    }

    #[test]
    fn version_one_state_migrates_to_nested_version_two_records() {
        let state = State::from_json(
            r#"{"schemaVersion":1,"records":{"opaque legacy key":{"sourceId":"post-1","sourcePath":"posts/a.md","target":"dev","remoteId":"42","remoteUrl":"https://dev.to/a","revision":"abc","publicationState":"draft","updatedAtUnix":1}}}"#,
        )
        .unwrap();
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.record("post-1", "dev").unwrap().remote_id, "42");
    }

    #[test]
    fn source_identity_collision_is_rejected_across_different_targets() {
        let post = post_fixture();
        let mut state = State::default();
        state.insert(
            &post.source_id,
            "old-target",
            StateRecord {
                source_path: "posts/a-renamed.md".into(),
                ..Default::default()
            },
        );
        let error = validate_source_identity(&state, &post).unwrap_err();
        assert!(error.contains("old-target"));
        assert!(error.contains("posts/a-renamed.md"));
    }

    #[test]
    fn hashnode_public_intent_fails_during_planning() {
        let name = "hashnode".to_string();
        let target = SyndicationTargetConfig {
            provider: SyndicationProvider::Hashnode,
            allow_publish: true,
            publication_id: "pub-id".into(),
            ..Default::default()
        };
        let error = validate_plan(&[(&name, &target)], true).unwrap_err();
        assert!(error.contains("draft-only"));
    }

    #[test]
    fn endpoints_reject_insecure_or_credentialed_urls() {
        assert!(validated_endpoint("http://ghost.example", "endpoint").is_err());
        assert!(validated_endpoint("https://a:b@ghost.example", "endpoint").is_err());
        assert!(validated_endpoint("https://ghost.example", "endpoint").is_ok());
    }

    #[test]
    fn root_relative_markdown_destinations_and_html_attributes_become_absolute() {
        let config: SiteConfig =
            serde_json::from_str(r#"{"url":"https://blog.example/base"}"#).unwrap();
        let markdown = r#"[inline](/one)
![angle](</images/pic.png> "Picture")

[reference]: /reference "Reference"
[multiline-reference]:
/multiline-reference "Multiline reference"

<a href = '/raw'>raw</a><img SRC="/raw.png">
<a href=/bare>bare</a>
<!-- href="/comment" --><script>const value = 'src="/script"';</script>
ordinary href="/prose"
[cdn](//cdn.example/file)
`[code](/unchanged)`
`multiline [code](/unchanged)
still code`
[^note]: /plain-footnote-text

    [indented](/unchanged)
<a
 href=/multiline>multiline</a>

<script>
const markdown = "[script](/unchanged)";
const attribute = 'href="/script"';
</script>
```md
[fenced](/unchanged)
```
"#;
        let rewritten = absolutize_markdown(markdown, &config).unwrap();
        for expected in [
            "[inline](https://blog.example/base/one)",
            "![angle](<https://blog.example/base/images/pic.png>",
            "[reference]: https://blog.example/base/reference",
            "[multiline-reference]:\nhttps://blog.example/base/multiline-reference",
            "href = 'https://blog.example/base/raw'",
            "SRC=\"https://blog.example/base/raw.png\"",
            "href=https://blog.example/base/bare",
            "href=https://blog.example/base/multiline",
        ] {
            assert!(
                rewritten.contains(expected),
                "missing {expected}: {rewritten}"
            );
        }
        assert!(rewritten.contains("[cdn](//cdn.example/file)"));
        assert!(rewritten.contains("`[code](/unchanged)`"));
        assert!(rewritten.contains("[code](/unchanged)\nstill code`"));
        assert!(rewritten.contains("[^note]: /plain-footnote-text"));
        assert!(
            rewritten.contains("    [indented](/unchanged)"),
            "{rewritten}"
        );
        assert!(rewritten.contains("[fenced](/unchanged)"));
        assert!(rewritten.contains("<!-- href=\"/comment\" -->"));
        assert!(rewritten.contains("src=\"/script\""));
        assert!(rewritten.contains("ordinary href=\"/prose\""));
        assert!(rewritten.contains("[script](/unchanged)"));
        assert!(rewritten.contains("href=\"/script\""));

        let html = absolutize_html(
            "<a HREF='/one'>one</a><img src=/two.png><!-- href='/comment' --><script>const value = 'src=\"/script\"';</script><p>ordinary href=\"/prose\"</p>",
            &config,
        );
        assert!(html.contains("href=\"https://blog.example/base/one\""));
        assert!(html.contains("src=\"https://blog.example/base/two.png\""));
        assert!(html.contains("<!-- href='/comment' -->"));
        assert!(html.contains("src=\"/script\""));
        assert!(html.contains("ordinary href=\"/prose\""));
    }

    #[test]
    fn multiline_reference_definition_destination_becomes_absolute() {
        let config: SiteConfig =
            serde_json::from_str(r#"{"url":"https://blog.example/base"}"#).unwrap();
        let markdown = "[guide]:\n/guide\n\nRead the [guide].\n";

        assert_eq!(
            absolutize_markdown(markdown, &config).unwrap(),
            "[guide]:\nhttps://blog.example/base/guide\n\nRead the [guide].\n"
        );
    }

    struct FakeTransport(Response);
    impl Transport for FakeTransport {
        fn send(&self, _: &Request) -> Result<Response, String> {
            Ok(self.0.clone())
        }
    }

    struct NoNetwork;
    impl Transport for NoNetwork {
        fn send(&self, _: &Request) -> Result<Response, String> {
            panic!("destination validation must finish before any network access");
        }
    }

    #[test]
    fn invalid_destination_metadata_blocks_all_selected_writes_without_source_or_state_changes() {
        let root = std::env::temp_dir().join(format!(
            "openblog-destination-tags-{}",
            crate::auth::random_token().unwrap(),
        ));
        let posts = root.join("content/posts");
        fs::create_dir_all(&posts).unwrap();
        fs::write(
            root.join("openblog.json"),
            r#"{
            "url":"https://blog.openblog.dev",
            "syndication":{"targets":{
                "a-ghost":{"provider":"ghost","endpoint":"https://ghost.example"},
                "b-dev":{"provider":"dev"},
                "c-hashnode":{"provider":"hashnode","publicationId":"publication"}
            }}
        }"#,
        )
        .unwrap();
        let source =
            "---\ntitle: Post\nslug: post\ndate: 2020-01-01\ntags: [invalid-dev]\n---\n\nBody\n";
        fs::write(posts.join("post.md"), source).unwrap();
        let error = run_with_transport(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: true,
                publish: false,
                json: false,
            },
            &NoNetwork,
        )
        .unwrap_err();
        assert!(
            error.contains("posts/post.md: DEV [destination-tag-invalid]"),
            "{error}"
        );
        assert_eq!(fs::read_to_string(posts.join("post.md")).unwrap(), source);
        assert!(!root.join(".openblog").exists());
        let invalid_image = "---\ntitle: Post\nslug: post\ndate: 2020-01-01\ntags: [rust]\n---\n\n![Not an image](mailto:author@example.test)\n";
        fs::write(posts.join("post.md"), invalid_image).unwrap();
        let error = run_with_transport(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: true,
                publish: false,
                json: false,
            },
            &NoNetwork,
        )
        .unwrap_err();
        assert!(error.contains("destination-image-url-invalid"), "{error}");
        assert_eq!(
            fs::read_to_string(posts.join("post.md")).unwrap(),
            invalid_image
        );
        assert!(!root.join(".openblog").exists());
        run_with_transport(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: false,
                publish: false,
                json: true,
            },
            &NoNetwork,
        )
        .unwrap();
        fs::write(posts.join("post.md"), source).unwrap();
        run_with_transport(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: false,
                publish: false,
                json: true,
            },
            &NoNetwork,
        )
        .unwrap();
        assert!(!root.join(".openblog").exists());
        let source = format!(
            "---\ntitle: Post\nslug: post\ndate: 2020-01-01\ntags: [rust]\n---\n\n{}\n",
            "a".repeat(100_000),
        );
        fs::write(posts.join("post.md"), &source).unwrap();
        let error = run_with_transport(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: true,
                publish: false,
                json: false,
            },
            &NoNetwork,
        )
        .unwrap_err();
        assert!(
            error.contains("posts/post.md: Hashnode [destination-payload-limit]"),
            "{error}"
        );
        assert_eq!(fs::read_to_string(posts.join("post.md")).unwrap(), source);
        assert!(!root.join(".openblog").exists());
        fs::remove_file(posts.join("post.md")).unwrap();
        fs::remove_file(root.join("openblog.json")).unwrap();
        fs::remove_dir(posts).unwrap();
        fs::remove_dir(root.join("content")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn malformed_success_outcomes_cannot_lose_remote_identity_or_ghost_revision() {
        for id in [Json::Null, json!(""), json!("   "), json!({})] {
            let error = outcome_from_fields("Provider", &id, &Json::Null, "")
                .err()
                .expect("remote IDs must be present and nonempty");
            assert!(error.contains("remote ID"));
        }
        for id in [json!("remote-id"), json!(42)] {
            assert!(outcome_from_fields("Provider", &id, &Json::Null, "").is_ok());
        }
        let ghost = GhostAdapter {
            endpoint: "https://ghost.example",
        };
        for revision in [Json::Null, json!(""), json!("  ")] {
            let error = ghost
                .outcome(&json!({ "posts": [{
                "id": "remote-id", "updated_at": revision,
            }] }))
                .err()
                .expect("Ghost success must retain an update revision");
            assert!(error.contains("updated_at revision"));
        }
        let outcome = ghost
            .outcome(&json!({ "posts": [{
            "id": "remote-id", "url": "https://ghost.example/post",
            "updated_at": "2026-10-25T00:00:00.000Z",
        }] }))
            .unwrap();
        assert_eq!(outcome.id, "remote-id");
        assert_eq!(outcome.remote_revision, "2026-10-25T00:00:00.000Z");
    }

    #[test]
    fn provider_http_errors_are_actionable_without_echoing_response_bodies() {
        let adapters: [&dyn ProviderAdapter; 4] = [
            &DevAdapter,
            &HashnodeAdapter {
                publication_id: "publication",
            },
            &GhostAdapter {
                endpoint: "https://ghost.example",
            },
            &WordpressAdapter {
                endpoint: "https://wordpress.example",
                publication_id: "",
            },
        ];
        let request = dev_request(&post_fixture(), None, false, "unused").unwrap();
        for adapter in adapters {
            for (status, expected) in [
                (401, "authentication failed"),
                (402, "billing"),
                (403, "lacks permission"),
                (404, "not found"),
                (409, "remote item changed"),
                (422, "rejected the post"),
                (429, "rate limit"),
                (503, "temporarily unavailable"),
            ] {
                let error = execute(
                    adapter,
                    &FakeTransport(Response {
                        status,
                        body: b"PRIVATE_provider_response".to_vec(),
                    }),
                    &request,
                )
                .err()
                .expect("provider errors cannot become outcomes");
                assert!(error.contains(expected), "{status}: {error}");
                assert!(!error.contains("PRIVATE_"));
            }
            let error = execute(
                adapter,
                &FakeTransport(Response {
                    status: 200,
                    body: b"PRIVATE_invalid_json".to_vec(),
                }),
                &request,
            )
            .err()
            .expect("invalid JSON cannot become an outcome");
            assert!(error.contains("invalid JSON"), "{error}");
            assert!(!error.contains("PRIVATE_"));
        }
    }

    #[test]
    fn ghost_revision_and_wordpress_endpoint_contracts_preserve_update_intent() {
        let post = post_fixture();
        let mut record = StateRecord {
            remote_id: "42".into(),
            ..Default::default()
        };
        let error = ghost_request(
            "https://ghost.example",
            &post,
            Some(&record),
            false,
            "abc:00112233445566778899aabbccddeeff",
        )
        .unwrap_err();
        assert!(error.contains("no updated_at revision"), "{error}");
        record.remote_revision = "2026-10-25T00:00:00.000Z".into();
        let request = ghost_request(
            "https://ghost.example",
            &post,
            Some(&record),
            false,
            "abc:00112233445566778899aabbccddeeff",
        )
        .unwrap();
        assert_eq!(request.method, "PUT");
        assert!(request.url.ends_with("/posts/42/?source=html"));
        assert_eq!(
            request.body["posts"][0]["updated_at"],
            record.remote_revision
        );
        let error = execute(
            &GhostAdapter {
                endpoint: "https://ghost.example",
            },
            &FakeTransport(Response {
                status: 409,
                body: br#"{"errors":[{"message":"stale revision"}]}"#.to_vec(),
            }),
            &request,
        )
        .err()
        .expect("stale remote revision must fail");
        assert!(error.contains("remote item changed"));
        assert_eq!(record.remote_revision, "2026-10-25T00:00:00.000Z");
        for (endpoint, publication, url) in [
            (
                "https://wp.example/wp-json/wp/v2",
                "",
                "https://wp.example/wp-json/wp/v2/posts/42",
            ),
            (
                "",
                "12345",
                "https://public-api.wordpress.com/wp/v2/sites/12345/posts/42",
            ),
        ] {
            let request =
                wordpress_request(endpoint, publication, &post, Some(&record), false, "unused")
                    .unwrap();
            assert_eq!(request.method, "POST");
            assert_eq!(request.url, url);
            assert_eq!(request.body["status"], "draft");
            assert_eq!(request.body["content"], post.html);
            assert!(
                request.body.get("canonical_url").is_none(),
                "do not invent core external canonical support"
            );
        }
    }

    #[test]
    fn provider_response_bounds_apply_to_every_transport_before_success_is_recorded() {
        let request = dev_request(&post_fixture(), None, false, "unused").unwrap();
        let mut body = br#"{"id":42,"url":"https://dev.to/example"}"#.to_vec();
        body.resize(MAX_RESPONSE_BYTES as usize, b' ');
        assert_eq!(
            execute(
                &DevAdapter,
                &FakeTransport(Response {
                    status: 201,
                    body: body.clone(),
                }),
                &request
            )
            .unwrap()
            .id,
            "42"
        );
        body.push(b' ');
        let error = execute(
            &DevAdapter,
            &FakeTransport(Response { status: 201, body }),
            &request,
        )
        .err()
        .expect("oversized responses must fail");
        assert!(error.contains("exceeded 1 MiB"), "{error}");
    }

    #[test]
    fn hashnode_partial_or_malformed_graphql_errors_never_count_as_success() {
        let adapter = HashnodeAdapter {
            publication_id: "publication",
        };
        let request =
            hashnode_request("publication", &post_fixture(), None, false, "unused").unwrap();
        for errors in [
            json!([{}]),
            json!({"message": "invalid shape"}),
            json!([{
                "message": "PRIVATE_provider_echo",
                "extensions": { "code": "FORBIDDEN" },
            }]),
        ] {
            let body = json!({
                "errors": errors,
                "data": { "createDraft": { "draft": { "id": "partial-id", "slug": "partial" } } },
            });
            let error = execute(
                &adapter,
                &FakeTransport(Response {
                    status: 200,
                    body: body.to_string().into_bytes(),
                }),
                &request,
            )
            .err()
            .expect("GraphQL errors must fail even alongside partial data");
            assert!(error.contains("Hashnode"), "{error}");
            assert!(
                !error.contains("PRIVATE_"),
                "provider responses must not echo private content"
            );
        }
        for (code, expected) in [
            ("UNAUTHENTICATED", "authentication failed"),
            ("FORBIDDEN", "lacks permission"),
            ("NOT_FOUND", "not found"),
            ("BAD_USER_INPUT", "rejected the post"),
            ("INTERNAL_SERVER_ERROR", "temporarily unavailable"),
            ("UNKNOWN_FUTURE_CODE", "inspect the provider dashboard"),
        ] {
            let error = adapter
                .outcome(&json!({ "errors": [{
                "message": "PRIVATE_provider_echo",
                "extensions": { "code": code },
            }] }))
                .err()
                .expect("GraphQL error codes must fail explicitly");
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("PRIVATE_"));
        }
    }

    #[test]
    fn response_parsing_uses_provider_remote_id() {
        let response = Response {
            status: 201,
            body: br#"{"id":42,"url":"https://dev.to/me/a"}"#.to_vec(),
        };
        let request = dev_request(&post_fixture(), None, false, "x").unwrap();
        let outcome = execute(&DevAdapter, &FakeTransport(response), &request).unwrap();
        assert_eq!(outcome.id, "42");
    }

    #[test]
    fn canonical_preflight_requires_a_matching_page_canonical() {
        let valid = Response {
            status: 200,
            body: br#"<html><head>
              <!-- <link rel="canonical" href="https://wrong.example/"> -->
              <script>"<link rel='canonical' href='https://wrong.example/'>"</script>
              <link href="/posts/a/" rel="alternate canonical">
              </head><body><link rel="canonical" href="https://wrong.example/"></body></html>"#
                .to_vec(),
        };
        verify_live_canonical(&FakeTransport(valid), "https://blog.example/posts/a/").unwrap();

        let wrong = Response {
            status: 200,
            body: br#"<link rel='canonical' href='https://other.example/a'>"#.to_vec(),
        };
        let error = verify_live_canonical(&FakeTransport(wrong), "https://blog.example/posts/a/")
            .unwrap_err();
        assert!(error.contains("does not declare itself"));

        let decoys = Response {
            status: 200,
            body: br#"<html><head><!-- <link rel='canonical' href='/posts/a/'> --><script>const fake = '<link rel="canonical" href="/posts/a/">';</script></head><body><link rel='canonical' href='/posts/a/'></body></html>"#.to_vec(),
        };
        assert!(
            verify_live_canonical(&FakeTransport(decoys), "https://blog.example/posts/a/").is_err()
        );

        let foreign_base = Response {
            status: 200,
            body: br#"<head><base href="https://other.example/"><link rel="canonical" href="/posts/a/"></head>"#.to_vec(),
        };
        assert!(verify_live_canonical(
            &FakeTransport(foreign_base),
            "https://blog.example/posts/a/"
        )
        .is_err());
    }

    #[test]
    fn canonical_transport_rejects_dns_that_resolves_to_non_public_addresses() {
        assert!(network_config().proxy().is_none());
        for address in ["127.0.0.1:443", "203.0.113.10:443"] {
            let transport = NetworkTransport {
                resolver: safe_http::PublicResolver::mapped_for_policy_test(
                    "canonical-policy.test",
                    address.parse().unwrap(),
                ),
            };
            let error = verify_live_canonical(&transport, "https://canonical-policy.test/posts/a/")
                .unwrap_err();
            assert!(error.contains("could not be retrieved") || error.contains("request failed"));
        }
    }

    #[test]
    fn draft_and_scheduled_sources_are_rejected_before_syndication() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("openblog-syndication-draft-{unique}"));
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::write(
            root.join("openblog.json"),
            r#"{
              "url":"https://blog.openblog.dev",
              "syndication":{"targets":{"medium":{"provider":"medium"}}}
            }"#,
        )
        .unwrap();
        fs::write(
            root.join("content/posts/post.md"),
            "---\ntitle: Post\nslug: post\ndate: 2020-01-01\ndraft: true\n---\n\nBody\n",
        )
        .unwrap();
        fs::write(
            root.join("content/posts/scheduled.md"),
            "---\ntitle: Scheduled\nslug: scheduled\ndate: 2999-01-01\n---\n\nBody\n",
        )
        .unwrap();
        for slug in ["post", "scheduled"] {
            let error = run(
                &root,
                slug,
                Options {
                    target_names: Vec::new(),
                    write: false,
                    publish: false,
                    json: false,
                },
            )
            .unwrap_err();
            assert!(error.contains("not production-visible"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dry_run_is_secretless_and_does_not_create_private_state() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("openblog-syndication-{unique}"));
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::write(
            root.join("openblog.json"),
            r#"{
              "url":"https://blog.openblog.dev",
              "syndication":{"targets":{"medium":{"provider":"medium"}}}
            }"#,
        )
        .unwrap();
        fs::write(
            root.join("content/posts/post.md"),
            "---\ntitle: Post\nslug: post\ndate: 2020-01-01\nsyndicationId: durable-post\n---\n\nBody\n",
        )
        .unwrap();
        run(
            &root,
            "post",
            Options {
                target_names: Vec::new(),
                write: false,
                publish: false,
                json: true,
            },
        )
        .unwrap();
        assert!(!root.join(".openblog/syndication.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
