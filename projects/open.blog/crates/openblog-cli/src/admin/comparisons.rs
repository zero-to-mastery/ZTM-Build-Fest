//! Admin routes for interpretation comparisons (ADR 0231, #89).
//!
//! Every route sits behind the session, and every write behind the CSRF check
//! (`api`), and an unknown name is a 404 (deny by default). A write takes the
//! build lock and the content transaction lock, names the revision it is based
//! on, is checked by the core before a byte is written and is applied by
//! atomic rename, so a stale, refused or failed save leaves the stored file
//! as it was.
//!
//! An approval is only ever made by the `approve` route, which stamps the
//! signed-in user, the time and the digest of the exact text the author was
//! shown. A save, a form or source text, can keep an approval the stored file
//! already has but can never add or change one (ADR 0231), and an approval
//! whose text was edited is dropped, never kept stale.

use openblog_core::scholarly_comparison::{
    Approval, Attribution, Certainty, Comparison, ComparisonProblem, Level, PublicComparison,
    References, RelationKind, Standing, Status, COMPARISONS_DIR, COMPARISON_FORMAT,
    COMPARISON_VERSION, MAX_EVIDENCE, MAX_EXPLANATIONS, MAX_EXPLANATION_CHARS, MAX_FILE_BYTES,
    MAX_INTERPRETATIONS, MAX_NOTE_CHARS, MAX_RELATIONS, MAX_SHORT_CHARS, MAX_STATEMENT_CHARS,
    MAX_TITLE_CHARS,
};

use super::*;
use crate::comparison_store::{self as store, StoreError as ComparisonError};

/// Largest request body: a comparison file plus room for the wrapper.
const MAX_REQUEST_BYTES: usize = MAX_FILE_BYTES * 2;

/// What a comparison may point at: everything the author holds (to tell a
/// typo from a private reference) and what the build publishes (for the
/// preview and the evidence state).
struct Context {
    content: String,
    /// Every source and evidence link of the library, or `None` when the
    /// research files could not be read.
    held: Option<References>,
    /// The sources and links a build publishes today.
    public: References,
    /// Titles of the library's sources, for the author's pickers only.
    source_titles: Vec<(String, String)>,
    /// Evidence links for the author's pickers: id, claim id, relation, source.
    links: Vec<(String, String, String, String)>,
    /// Why the research files could not be read, shown to the author.
    problem: Option<String>,
}

fn context(state: &AppState) -> Context {
    let config = match site::load_config(&state.root) {
        Ok(config) => config,
        Err(error) => {
            return Context {
                content: SiteConfig::default().paths.content,
                held: None,
                public: References::default(),
                source_titles: Vec::new(),
                links: Vec::new(),
                problem: Some(error),
            }
        }
    };
    let content = config.paths.content.clone();
    match claims_store::load(&state.root, &config.contributors) {
        Ok(snapshot) => {
            let held = References::of(&snapshot.library, &snapshot.claims);
            // Public means what the build publishes: an approved link of an
            // approved claim, and the source it cites, and only while the site
            // publishes claim evidence at all. Conservative on purpose: a
            // source nothing public cites is not offered to readers (#90).
            let mut public = References::default();
            if config.claim_evidence.publish {
                for link in snapshot.claims.projected_links() {
                    public.evidence_links.insert(link.id.clone());
                    public.sources.insert(link.evidence.source.clone());
                }
            }
            Context {
                content,
                held: Some(held),
                public,
                source_titles: snapshot
                    .library
                    .sources
                    .iter()
                    .map(|s| (s.id.clone(), s.title.clone().unwrap_or_else(|| s.id.clone())))
                    .collect(),
                links: snapshot
                    .claims
                    .links
                    .iter()
                    .map(|l| {
                        (
                            l.id.clone(),
                            l.claim.clone(),
                            format!("{:?}", l.relation).to_lowercase(),
                            l.evidence.source.clone(),
                        )
                    })
                    .collect(),
                problem: None,
            }
        }
        Err(error) => Context {
            content,
            held: None,
            public: References::default(),
            source_titles: Vec::new(),
            links: Vec::new(),
            problem: Some(format!(
                "The research library and evidence could not be read, so evidence cannot be checked. {error}"
            )),
        },
    }
}

fn problems_json(problems: &[ComparisonProblem]) -> Json {
    Json::Array(
        problems
            .iter()
            .map(|p| json!({ "item": p.item, "message": p.message, "text": p.to_string() }))
            .collect(),
    )
}

fn comparison_json(comparison: &Comparison) -> Json {
    serde_json::from_str(&comparison.to_canonical_json()).unwrap_or(Json::Null)
}

fn standing_word(standing: Standing) -> &'static str {
    match standing {
        Standing::Authored => "authored",
        Standing::Approved => "approved",
        Standing::AwaitingApproval => "awaiting-approval",
        Standing::Stale => "stale",
    }
}

/// Where each item stands and what its evidence is, for the author only:
/// `standing`, the digest an approval would bind, and one state per evidence
/// reference (`public`, `private`, `missing`, or `unchecked` when the research
/// files could not be read). Missing evidence is shown, never blocking.
fn item_states(comparison: &Comparison, ctx: &Context) -> Vec<Json> {
    let evidence_state = |e: &openblog_core::scholarly_comparison::EvidenceRef| {
        use openblog_core::scholarly_comparison::EvidenceRef;
        let (held, public, label) = match e {
            EvidenceRef::Link { link, .. } => (
                ctx.held.as_ref().map(|h| h.evidence_links.contains(link)),
                ctx.public.evidence_links.contains(link),
                link.as_str(),
            ),
            EvidenceRef::Source { source, .. } => (
                ctx.held.as_ref().map(|h| h.sources.contains(source)),
                ctx.public.sources.contains(source),
                source.as_str(),
            ),
        };
        let state = match held {
            None => "unchecked",
            Some(false) => "missing",
            Some(true) if public => "public",
            Some(true) => "private",
        };
        json!({ "ref": label, "kind": if matches!(e, EvidenceRef::Link { .. }) { "link" } else { "source" }, "state": state })
    };
    let mut out = Vec::new();
    for i in &comparison.interpretations {
        let attribution_state = match &i.attribution {
            Attribution::Source { source, .. } => Some(match ctx.held.as_ref() {
                None => "unchecked",
                Some(h) if h.sources.contains(source) => "held",
                Some(_) => "missing",
            }),
            _ => None,
        };
        out.push(json!({
            "id": i.id, "kind": "interpretation",
            "standing": standing_word(i.standing()),
            "ai": i.origin.is_ai(),
            "digest": i.digest(),
            "evidence": i.evidence.iter().map(evidence_state).collect::<Vec<_>>(),
            "noEvidence": i.evidence.is_empty(),
            "attributionSource": attribution_state,
        }));
    }
    for x in &comparison.explanations {
        out.push(json!({
            "id": x.id, "kind": "explanation",
            "standing": standing_word(x.standing()),
            "ai": x.origin.is_ai(),
            "digest": x.digest(),
            "evidence": x.evidence.iter().map(evidence_state).collect::<Vec<_>>(),
            "noEvidence": x.evidence.is_empty(),
        }));
    }
    out
}

/// The public projection `comparison` would have if it were published now,
/// and what would be left out and why, for the author only.
fn projection(comparison: &Comparison, ctx: &Context) -> Json {
    let mut candidate = comparison.clone();
    candidate.status = Status::Published;
    let (public, withheld) = PublicComparison::project(&candidate, &ctx.public);
    json!({
        "public": public.as_ref().and_then(|p| serde_json::to_value(p).ok()),
        "withheld": public.is_none(),
        "asPublished": comparison.status != Status::Published,
        "leftOut": withheld,
    })
}

/// References that do not exist in the library, as notes (never blocking).
fn reference_notes(comparison: &Comparison, ctx: &Context) -> Vec<ComparisonProblem> {
    ctx.held
        .as_ref()
        .map(|held| comparison.check_references(held))
        .unwrap_or_default()
}

/// One comparison as the editor needs it.
fn view(stored: &store::Stored, ctx: &Context) -> Json {
    match &stored.parsed {
        Ok(comparison) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": true,
            "source": comparison.to_canonical_json(),
            "canonical": comparison.to_canonical_json() == stored.text,
            "comparison": comparison_json(comparison),
            "problems": [],
            "notes": problems_json(&reference_notes(comparison, ctx)),
            "states": item_states(comparison, ctx),
            "projection": projection(comparison, ctx),
            "researchProblem": ctx.problem,
        }),
        Err(problems) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": false,
            "source": stored.text,
            "comparison": Json::Null,
            "problems": problems_json(problems),
            "notes": [],
            "states": [],
            "projection": Json::Null,
            "researchProblem": ctx.problem,
        }),
    }
}

fn store_error(state: &AppState, error: ComparisonError, slug: Option<&str>) -> Response {
    match error {
        ComparisonError::Conflict => {
            let ctx = context(state);
            let latest =
                slug.and_then(|slug| store::read(&state.root, &ctx.content, slug).ok().flatten());
            Response::json(
                409,
                &json!({
                    "error": error.to_string(),
                    "conflict": true,
                    "revision": latest.as_ref().map(|s| s.revision.as_str()),
                    "current": latest.as_ref().map(|s| view(s, &ctx)),
                }),
            )
        }
        ComparisonError::Exists => {
            Response::json(409, &json!({ "error": error.to_string(), "exists": true }))
        }
        ComparisonError::Missing => {
            Response::json(404, &json!({ "error": error.to_string(), "missing": true }))
        }
        ComparisonError::Invalid(problems) => Response::json(
            422,
            &json!({
                "error": problems.first().map_or_else(
                    || "The comparison is not valid".to_string(),
                    ToString::to_string,
                ),
                "problems": problems_json(&problems),
            }),
        ),
        ComparisonError::Storage(message) => Response::error(500, &message),
    }
}

fn body(req: &Request) -> Result<Json, Response> {
    require_json(req)?;
    if req.body.len() > MAX_REQUEST_BYTES {
        return Err(Response::error(413, "A comparison is limited to 1 MiB"));
    }
    match serde_json::from_slice::<Json>(&req.body) {
        Ok(body) if body.is_object() => Ok(body),
        _ => Err(Response::error(400, "Invalid JSON")),
    }
}

/// The comparison a request carries, as `source` text (source mode) or as a
/// file-shaped `comparison` object, for the slug it names. Reads nothing from
/// disk and never echoes a value.
fn requested(request: &Json, slug: &str) -> Result<Comparison, Vec<ComparisonProblem>> {
    let file = format!("{COMPARISONS_DIR}/{slug}.json");
    let text = match (request["source"].as_str(), request.get("comparison")) {
        (Some(source), None | Some(Json::Null)) => source.to_string(),
        (None, Some(Json::Object(object))) => {
            let mut object = object.clone();
            object.insert("format".into(), json!(COMPARISON_FORMAT));
            object.insert("version".into(), json!(COMPARISON_VERSION));
            Json::Object(object).to_string()
        }
        _ => {
            return Err(vec![ComparisonProblem {
                file,
                item: None,
                message:
                    "send the comparison as `comparison` (an object) or `source` (text), not both"
                        .into(),
            }])
        }
    };
    Comparison::parse(&file, &text)
}

fn slug_of(request: &Json) -> Result<&str, Response> {
    request["slug"]
        .as_str()
        .filter(|slug| openblog_core::scholarly_comparison::valid_comparison_slug(slug))
        .ok_or_else(|| {
            Response::error(
                400,
                "Name the comparison by its slug (lowercase letters, digits and single hyphens)",
            )
        })
}

/// Approvals are made only by the approve route. An incoming approval must be
/// exactly the one the stored file already has for that item; anything else
/// (an invented approval, a changed name, time or digest) is refused, naming
/// the item. Then an approval whose text was edited is dropped, because the
/// text it approved is gone; the dropped ids are returned for the author.
fn settle_approvals(
    stored: Option<&Comparison>,
    incoming: &mut Comparison,
) -> Result<Vec<String>, Vec<ComparisonProblem>> {
    let file = format!("{COMPARISONS_DIR}/{}.json", incoming.slug);
    let mut problems = Vec::new();
    let mut refuse = |id: &str| {
        problems.push(ComparisonProblem {
            file: file.clone(),
            item: Some(id.to_string()),
            message: "an approval is given only by the Approve action, never by saving; remove the `approval` or keep the one already stored".into(),
        })
    };
    let before_i = |id: &str| -> Option<&Approval> {
        stored?
            .interpretations
            .iter()
            .find(|i| i.id == id)?
            .approval
            .as_ref()
    };
    let before_x = |id: &str| -> Option<&Approval> {
        stored?
            .explanations
            .iter()
            .find(|x| x.id == id)?
            .approval
            .as_ref()
    };
    for i in &incoming.interpretations {
        if i.approval.is_some() && i.approval.as_ref() != before_i(&i.id) {
            refuse(&i.id);
        }
    }
    for x in &incoming.explanations {
        if x.approval.is_some() && x.approval.as_ref() != before_x(&x.id) {
            refuse(&x.id);
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut dropped = Vec::new();
    for i in &mut incoming.interpretations {
        let digest = i.digest();
        if i.approval.as_ref().is_some_and(|a| a.digest != digest) {
            i.approval = None;
            dropped.push(i.id.clone());
        }
    }
    for x in &mut incoming.explanations {
        let digest = x.digest();
        if x.approval.as_ref().is_some_and(|a| a.digest != digest) {
            x.approval = None;
            dropped.push(x.id.clone());
        }
    }
    Ok(dropped)
}

fn listed(stored: &store::Stored, ctx: &Context) -> Json {
    match &stored.parsed {
        Ok(c) => {
            let awaiting = c
                .interpretations
                .iter()
                .map(|i| i.standing())
                .chain(c.explanations.iter().map(|x| x.standing()))
                .filter(|s| !s.publishable())
                .count();
            let mut candidate = c.clone();
            candidate.status = Status::Published;
            let (public, _) = PublicComparison::project(&candidate, &ctx.public);
            json!({
                "slug": stored.slug,
                "revision": stored.revision,
                "valid": true,
                "title": c.title,
                "status": c.status,
                "interpretations": c.interpretations.len(),
                "explanations": c.explanations.len(),
                "awaitingApproval": awaiting,
                "shown": public.is_some(),
                "problems": 0,
            })
        }
        Err(problems) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": false,
            "title": stored.slug,
            "status": Json::Null,
            "problems": problems.len(),
            "firstProblem": problems.first().map(ToString::to_string),
        }),
    }
}

/// `GET comparisons`: every comparison with its status.
pub(super) fn list(state: &AppState) -> Response {
    let _content = lock(&state.build);
    let ctx = context(state);
    let stored = match store::list(&state.root, &ctx.content) {
        Ok(stored) => stored,
        Err(error) => return store_error(state, error, None),
    };
    let items: Vec<Json> = stored.iter().map(|s| listed(s, &ctx)).collect();
    Response::json(
        200,
        &json!({ "items": items, "limit": store::MAX_LISTED, "researchProblem": ctx.problem }),
    )
}

/// `GET comparisons/references`: what an author may point at, and the fixed
/// vocabularies and limits of the form.
pub(super) fn references(state: &AppState) -> Response {
    let _content = lock(&state.build);
    let ctx = context(state);
    Response::json(
        200,
        &json!({
            "sources": ctx.source_titles.iter().map(|(id, title)| json!({"id": id, "title": title})).collect::<Vec<_>>(),
            "links": ctx.links.iter().map(|(id, claim, relation, source)| json!({"id": id, "claim": claim, "relation": relation, "source": source})).collect::<Vec<_>>(),
            "problem": ctx.problem,
            "levels": Level::ALL.iter().map(|l| l.value()).collect::<Vec<_>>(),
            "relations": RelationKind::ALL.iter().map(|k| json!({"value": k.value(), "symmetric": k.symmetric()})).collect::<Vec<_>>(),
            "certainties": Certainty::ALL.iter().map(|c| c.value()).collect::<Vec<_>>(),
            "limits": {
                "interpretations": MAX_INTERPRETATIONS,
                "explanations": MAX_EXPLANATIONS,
                "relations": MAX_RELATIONS,
                "evidence": MAX_EVIDENCE,
                "title": MAX_TITLE_CHARS,
                "short": MAX_SHORT_CHARS,
                "note": MAX_NOTE_CHARS,
                "statement": MAX_STATEMENT_CHARS,
                "explanation": MAX_EXPLANATION_CHARS,
            },
        }),
    )
}

/// `GET comparisons/item?slug=`: one comparison, as a form model, as
/// canonical source, with item standings, evidence states, reference notes
/// and the public projection.
pub(super) fn get(state: &AppState, req: &Request) -> Response {
    let _content = lock(&state.build);
    let Some(slug) = req
        .query
        .get("slug")
        .filter(|slug| openblog_core::scholarly_comparison::valid_comparison_slug(slug))
    else {
        return Response::error(400, "Name the comparison by ?slug=");
    };
    let ctx = context(state);
    match store::read(&state.root, &ctx.content, slug) {
        Ok(Some(stored)) => Response::json(200, &view(&stored, &ctx)),
        Ok(None) => Response::error(404, "No such comparison"),
        Err(error) => store_error(state, error, Some(slug)),
    }
}

/// `POST comparisons/preview`: check an unsaved comparison (a form model or
/// source text) and show its projection. Reads only; never writes.
pub(super) fn preview(state: &AppState, req: &Request) -> Response {
    let request = match body(req) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let slug = match slug_of(&request) {
        Ok(slug) => slug.to_string(),
        Err(response) => return response,
    };
    let _content = lock(&state.build);
    let ctx = context(state);
    match requested(&request, &slug) {
        Err(problems) => Response::json(
            200,
            &json!({ "valid": false, "problems": problems_json(&problems), "states": [],
                "notes": [], "projection": Json::Null }),
        ),
        Ok(mut comparison) => {
            let stored = store::read(&state.root, &ctx.content, &slug)
                .ok()
                .flatten()
                .and_then(|s| s.parsed.ok());
            let mut problems = match settle_approvals(stored.as_ref(), &mut comparison) {
                Ok(_) => Vec::new(),
                Err(problems) => problems,
            };
            problems.extend(comparison.validate());
            Response::json(
                200,
                &json!({
                    "valid": problems.is_empty(),
                    "problems": problems_json(&problems),
                    "source": comparison.to_canonical_json(),
                    "comparison": comparison_json(&comparison),
                    "notes": problems_json(&reference_notes(&comparison, &ctx)),
                    "states": item_states(&comparison, &ctx),
                    "projection": projection(&comparison, &ctx),
                    "researchProblem": ctx.problem,
                }),
            )
        }
    }
}

fn saved_view(slug: &str, saved: store::Saved, ctx: &Context) -> Json {
    let stored = store::Stored {
        slug: slug.to_string(),
        revision: saved.revision,
        text: saved.text,
        parsed: Ok(saved.comparison),
    };
    view(&stored, ctx)
}

/// `POST comparisons` (create) and `PUT comparisons` (replace, naming the
/// revision read). The body is `comparison` or `source`; what is written is
/// always the canonical form, and the response carries it.
pub(super) fn save(state: &AppState, req: &Request, create: bool) -> Response {
    let request = match body(req) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let slug = match slug_of(&request) {
        Ok(slug) => slug.to_string(),
        Err(response) => return response,
    };
    let revision = request["revision"].as_str().map(str::to_string);
    if !create && revision.is_none() {
        return Response::error(400, "Missing the comparison's revision");
    }
    let mut comparison = match requested(&request, &slug) {
        Ok(comparison) => comparison,
        Err(problems) => return store_error(state, ComparisonError::Invalid(problems), None),
    };
    let _build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let ctx = context(state);
    let stored = if create {
        None
    } else {
        match store::read(&state.root, &ctx.content, &slug) {
            Ok(Some(current)) => {
                if Some(current.revision.as_str()) != revision.as_deref() {
                    return store_error(state, ComparisonError::Conflict, Some(&slug));
                }
                current.parsed.ok()
            }
            Ok(None) => return store_error(state, ComparisonError::Missing, None),
            Err(error) => return store_error(state, error, Some(&slug)),
        }
    };
    let dropped = match settle_approvals(stored.as_ref(), &mut comparison) {
        Ok(dropped) => dropped,
        Err(problems) => return store_error(state, ComparisonError::Invalid(problems), None),
    };
    let result = if create {
        store::create(&state.root, &ctx.content, &comparison)
    } else {
        store::update(
            &state.root,
            &ctx.content,
            revision.as_deref().unwrap_or_default(),
            &comparison,
        )
    };
    match result {
        Ok(saved) => {
            let mut v = saved_view(&slug, saved, &ctx);
            v["approvalsWithdrawn"] = json!(dropped);
            Response::json(if create { 201 } else { 200 }, &v)
        }
        Err(error) => store_error(state, error, Some(&slug)),
    }
}

/// `POST comparisons/approve` and `POST comparisons/revoke`: give or withdraw
/// a person's approval of one AI-drafted item. Approving names the digest of
/// the text the author was shown, so text that changed since is never
/// approved by mistake; the approval is stamped with the signed-in user and
/// the time. Revoking a published comparison also needs `unpublish: true`,
/// because a published comparison cannot hold unapproved AI text.
pub(super) fn decide(state: &AppState, req: &Request, user: &str, approve: bool) -> Response {
    let request = match body(req) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let slug = match slug_of(&request) {
        Ok(slug) => slug.to_string(),
        Err(response) => return response,
    };
    let (Some(revision), Some(kind), Some(id)) = (
        request["revision"].as_str(),
        request["kind"].as_str(),
        request["id"].as_str(),
    ) else {
        return Response::error(400, "Name the revision, the kind and the id of the item");
    };
    if kind != "interpretation" && kind != "explanation" {
        return Response::error(400, "`kind` is `interpretation` or `explanation`");
    }
    let digest = request["digest"].as_str().map(str::to_string);
    if approve && digest.is_none() {
        return Response::error(400, "Name the digest of the text you read");
    }
    let unpublish = request["unpublish"].as_bool().unwrap_or(false);
    let _build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let ctx = context(state);
    let current = match store::read(&state.root, &ctx.content, &slug) {
        Ok(Some(current)) => current,
        Ok(None) => return store_error(state, ComparisonError::Missing, None),
        Err(error) => return store_error(state, error, Some(&slug)),
    };
    if current.revision != revision {
        return store_error(state, ComparisonError::Conflict, Some(&slug));
    }
    let Ok(mut comparison) = current.parsed.clone() else {
        return Response::error(
            422,
            "This comparison has problems; repair it in source mode first",
        );
    };
    let refuse = |message: &str, extra: Json| {
        let mut v = json!({ "error": message });
        if let (Some(v), Some(extra)) = (v.as_object_mut(), extra.as_object()) {
            v.extend(extra.clone());
        }
        Response::json(422, &v)
    };
    let (is_ai, text_digest, approval) = if kind == "interpretation" {
        match comparison.interpretations.iter_mut().find(|i| i.id == id) {
            Some(i) => (i.origin.is_ai(), i.digest(), &mut i.approval),
            None => return Response::error(404, "No such interpretation"),
        }
    } else {
        match comparison.explanations.iter_mut().find(|x| x.id == id) {
            Some(x) => (x.origin.is_ai(), x.digest(), &mut x.approval),
            None => return Response::error(404, "No such explanation"),
        }
    };
    if !is_ai {
        return refuse(
            "Only text drafted by an AI tool is approved here; text you wrote needs no approval",
            json!({ "notAi": true }),
        );
    }
    if approve {
        if digest.as_deref() != Some(text_digest.as_str()) {
            return refuse(
                "The text changed since you read it. Nothing was approved; read it again and approve what you see",
                json!({ "stale": true, "digest": text_digest }),
            );
        }
        *approval = Some(Approval {
            by: user.to_string(),
            at: clock::now().rfc3339(),
            digest: text_digest,
            extra: Default::default(),
        });
    } else {
        if approval.is_none() {
            return refuse("There is no approval to withdraw", json!({}));
        }
        *approval = None;
        if comparison.status == Status::Published {
            if !unpublish {
                return refuse(
                    "A published comparison cannot hold AI text nobody has approved. Withdraw the approval and return the whole comparison to draft, or leave it approved",
                    json!({ "needsUnpublish": true }),
                );
            }
            comparison.status = Status::Draft;
        }
    }
    match store::update(&state.root, &ctx.content, revision, &comparison) {
        Ok(saved) => Response::json(200, &saved_view(&slug, saved, &ctx)),
        Err(error) => store_error(state, error, Some(&slug)),
    }
}

/// `DELETE comparisons?slug=&revision=`: move the file to the trash folder.
/// Never destroys it, and refuses a stale revision.
pub(super) fn remove(state: &AppState, req: &Request) -> Response {
    let Some(slug) = req
        .query
        .get("slug")
        .filter(|slug| openblog_core::scholarly_comparison::valid_comparison_slug(slug))
    else {
        return Response::error(400, "Name the comparison by ?slug=");
    };
    let Some(revision) = req.query.get("revision") else {
        return Response::error(400, "Missing ?revision=");
    };
    let _build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let ctx = context(state);
    let stamp = clock::now().rfc3339().replace(':', "");
    match store::delete(&state.root, &ctx.content, slug, revision, &stamp) {
        Ok(name) => Response::json(200, &json!({ "ok": true, "trashedTo": name })),
        Err(error) => store_error(state, error, Some(slug)),
    }
}
