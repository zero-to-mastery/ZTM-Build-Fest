//! Admin routes for reading-path curation (ADR 0213, #77).
//!
//! Every route sits behind the session, and every write behind the CSRF check
//! (`api`), and an unknown name is a 404 (deny by default). A write takes the
//! build lock and the content transaction lock, names the revision it is based
//! on, is checked by the core before a byte is written and is applied by
//! atomic rename, so a stale, refused or failed save leaves the stored file
//! as it was. The author sees draft and unpublished steps flagged, the
//! diagnostics the build would give, and the public projection a published
//! path would have, all from the one core resolution.

use std::collections::BTreeMap;

use openblog_core::reading_path::{
    Difficulty, PathProblem, PublicPaths, PublishedTargets, ReadingPath, Relationship, Status,
    Step, Target, MAX_FILE_BYTES, MAX_PATHS, MAX_PREREQUISITE_CHARS, MAX_STEPS, MAX_TEXT_CHARS,
    MAX_TITLE_CHARS, PATHS_DIR, READING_PATH_FORMAT, READING_PATH_VERSION,
};
use openblog_core::{LoadOptions, SiteConfig};

use super::*;
use crate::reading_path_store::{self as store, StoreError as PathError};

/// Largest request body: a path file plus room for the wrapper.
const MAX_REQUEST_BYTES: usize = MAX_FILE_BYTES * 2;

/// What a path may point at now, and what the author's own drafts are.
struct Context {
    targets: PublishedTargets,
    /// Every post of the site by slug: its title and where it stands now.
    posts: BTreeMap<String, (String, &'static str)>,
    /// Why the targets could not be read, shown to the author.
    problem: Option<String>,
    /// Whether the site publishes paths (`readingPaths.publish`).
    switch: bool,
    content: String,
}

fn context(state: &AppState) -> Context {
    let config = match site::load_config(&state.root) {
        Ok(config) => config,
        Err(error) => return failed_context(error, SiteConfig::default()),
    };
    let switch = config.reading_paths.publish;
    let content = config.paths.content.clone();
    let sources = match site::read_sources(&state.root, &config) {
        Ok(sources) => sources,
        Err(error) => return failed_context(error, config),
    };
    let now = clock::now();
    let (site, _themes) = match site::load_site_from_sources(
        &state.root,
        config.clone(),
        sources,
        LoadOptions {
            include_drafts: true,
            now: Some(now),
            preview_source: None,
        },
    ) {
        Ok(loaded) => loaded,
        Err(error) => return failed_context(error, config),
    };
    let mut targets = PublishedTargets::from_site(&site);
    let mut problem = None;
    let mut warnings = Vec::new();
    match site::published_atlas(&state.root, &config, &mut warnings) {
        Ok(Some(atlas)) => targets.add_atlas(&atlas),
        Ok(None) => {}
        Err(error) => problem = Some(error),
    }
    let posts = site
        .posts
        .iter()
        .map(|post| {
            let status = if post.draft {
                "draft"
            } else if post.date > now {
                "scheduled"
            } else {
                "published"
            };
            (post.slug.clone(), (post.title.clone(), status))
        })
        .collect();
    Context {
        targets,
        posts,
        problem,
        switch,
        content,
    }
}

fn failed_context(error: String, config: SiteConfig) -> Context {
    Context {
        targets: PublishedTargets::default(),
        posts: BTreeMap::new(),
        problem: Some(error),
        switch: config.reading_paths.publish,
        content: config.paths.content,
    }
}

fn problems_json(problems: &[PathProblem]) -> Json {
    Json::Array(
        problems
            .iter()
            .map(|p| json!({ "step": p.step, "message": p.message, "text": p.to_string() }))
            .collect(),
    )
}

fn path_json(path: &ReadingPath) -> Json {
    serde_json::from_str(&path.to_canonical_json()).unwrap_or(Json::Null)
}

/// Where each step stands now, for the author only (the public value names
/// none of this): `published`, `draft`, `scheduled`, `missing` for a post, and
/// `published` or `unpublished` for an atlas entry.
fn step_states(path: &ReadingPath, ctx: &Context) -> Vec<Json> {
    path.steps
        .iter()
        .map(|step| step_state(step, ctx))
        .collect()
}

fn step_state(step: &Step, ctx: &Context) -> Json {
    match &step.target {
        Target::Post { slug, .. } => {
            let (title, state) = match ctx.posts.get(slug) {
                Some((title, state)) => (Some(title.as_str()), *state),
                None => (None, "missing"),
            };
            json!({ "id": step.id, "kind": "post", "target": slug, "state": state,
                "published": state == "published", "title": title })
        }
        Target::Atlas { id, .. } => {
            let label = ctx.targets.entry_label(id);
            json!({ "id": step.id, "kind": "atlas", "target": id,
                "state": if label.is_some() { "published" } else { "unpublished" },
                "published": label.is_some(), "title": label })
        }
    }
}

/// The public projection `path` would have if it were published now, and the
/// author's diagnostics for it. A draft is resolved as if published, which is
/// what "preview" means, and the view says so.
fn projection(path: &ReadingPath, ctx: &Context) -> Json {
    let mut candidate = path.clone();
    candidate.status = Status::Published;
    let resolution = PublicPaths::resolve(&[candidate], &ctx.targets);
    let public = resolution
        .paths
        .paths
        .first()
        .and_then(|p| serde_json::to_value(p).ok());
    json!({
        "public": public,
        "withheld": public.is_none(),
        "asPublished": path.status != Status::Published,
        "diagnostics": resolution.diagnostics.iter().map(|d| json!({
            "step": d.step, "kind": format!("{:?}", d.kind), "message": d.message,
            "text": d.to_string(),
        })).collect::<Vec<_>>(),
    })
}

/// One path as the editor needs it.
fn view(stored: &store::Stored, ctx: &Context) -> Json {
    match &stored.parsed {
        Ok(path) => {
            let mut v = json!({
                "slug": stored.slug,
                "revision": stored.revision,
                "valid": true,
                "source": path.to_canonical_json(),
                "canonical": path.to_canonical_json() == stored.text,
                "path": path_json(path),
                "problems": [],
                "states": step_states(path, ctx),
            });
            v["projection"] = projection(path, ctx);
            v
        }
        Err(problems) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": false,
            "source": stored.text,
            "path": Json::Null,
            "problems": problems_json(problems),
            "states": [],
            "projection": Json::Null,
        }),
    }
}

fn store_error(state: &AppState, error: PathError, slug: Option<&str>) -> Response {
    match error {
        PathError::Conflict => {
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
        PathError::Exists => {
            Response::json(409, &json!({ "error": error.to_string(), "exists": true }))
        }
        PathError::Missing => {
            Response::json(404, &json!({ "error": error.to_string(), "missing": true }))
        }
        PathError::Invalid(problems) => Response::json(
            422,
            &json!({
                "error": problems.first().map_or_else(
                    || "The reading path is not valid".to_string(),
                    ToString::to_string,
                ),
                "problems": problems_json(&problems),
            }),
        ),
        PathError::Storage(message) => Response::error(500, &message),
    }
}

fn body(req: &Request) -> Result<Json, Response> {
    require_json(req)?;
    if req.body.len() > MAX_REQUEST_BYTES {
        return Err(Response::error(413, "A reading path is limited to 256 KiB"));
    }
    match serde_json::from_slice::<Json>(&req.body) {
        Ok(body) if body.is_object() => Ok(body),
        _ => Err(Response::error(400, "Invalid JSON")),
    }
}

/// The path a request carries, as `source` text (source mode) or as a
/// file-shaped `path` object, for the slug it names. Reads nothing from disk
/// and never echoes a value.
fn requested_path(request: &Json, slug: &str) -> Result<ReadingPath, Vec<PathProblem>> {
    let file = format!("{PATHS_DIR}/{slug}.json");
    let text = match (request["source"].as_str(), request.get("path")) {
        (Some(source), None | Some(Json::Null)) => source.to_string(),
        (None, Some(Json::Object(object))) => {
            let mut object = object.clone();
            object.insert("format".into(), json!(READING_PATH_FORMAT));
            object.insert("version".into(), json!(READING_PATH_VERSION));
            Json::Object(object).to_string()
        }
        _ => {
            return Err(vec![PathProblem {
                file,
                step: None,
                message: "send the path as `path` (an object) or `source` (text), not both".into(),
            }])
        }
    };
    ReadingPath::parse(&file, &text)
}

fn slug_of(request: &Json) -> Result<&str, Response> {
    request["slug"]
        .as_str()
        .filter(|slug| openblog_core::reading_path::valid_path_slug(slug))
        .ok_or_else(|| {
            Response::error(
                400,
                "Name the path by its slug (lowercase letters, digits and single hyphens)",
            )
        })
}

fn listed(stored: &store::Stored) -> Json {
    match &stored.parsed {
        Ok(path) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": true,
            "title": path.title,
            "status": path.status,
            "listed": path.listed,
            "steps": path.steps.len(),
            "problems": 0,
        }),
        Err(problems) => json!({
            "slug": stored.slug,
            "revision": stored.revision,
            "valid": false,
            "title": stored.slug,
            "status": Json::Null,
            "listed": Json::Null,
            "steps": 0,
            "problems": problems.len(),
            "firstProblem": problems.first().map(ToString::to_string),
        }),
    }
}

/// `GET reading-paths`: every path with its status, and whether the site
/// publishes paths at all.
pub(super) fn list(state: &AppState) -> Response {
    let _content = lock(&state.build);
    let ctx = context(state);
    let stored = match store::list(&state.root, &ctx.content) {
        Ok(stored) => stored,
        Err(error) => return store_error(state, error, None),
    };
    // Whether each valid path is shown whole if published now, so the list
    // says which are withheld without opening each.
    let resolved: Vec<ReadingPath> = stored
        .iter()
        .filter_map(|s| s.parsed.as_ref().ok().cloned())
        .collect();
    let mut as_published = resolved.clone();
    for path in &mut as_published {
        path.status = Status::Published;
    }
    let shown: Vec<String> = PublicPaths::resolve(&as_published, &ctx.targets)
        .paths
        .paths
        .into_iter()
        .map(|p| p.slug)
        .collect();
    let items: Vec<Json> = stored
        .iter()
        .map(|s| {
            let mut item = listed(s);
            item["shown"] = json!(shown.contains(&s.slug));
            item
        })
        .collect();
    Response::json(
        200,
        &json!({
            "items": items,
            "publish": ctx.switch,
            "limit": MAX_PATHS,
            "targetsProblem": ctx.problem,
        }),
    )
}

/// `GET reading-paths/targets`: what an author may pick as a step. Only what
/// production publishes: published posts and public atlas entries.
pub(super) fn targets(state: &AppState) -> Response {
    let _content = lock(&state.build);
    let ctx = context(state);
    let posts: Vec<Json> = ctx
        .targets
        .posts()
        .map(|(slug, title)| json!({ "slug": slug, "title": title }))
        .collect();
    let entries: Vec<Json> = ctx
        .targets
        .entries()
        .map(|(id, label, kind)| json!({ "id": id, "label": label, "kind": kind }))
        .collect();
    let relationships: Vec<Json> = Relationship::ALL
        .iter()
        .map(|r| json!({ "value": r.value(), "label": r.label() }))
        .collect();
    Response::json(
        200,
        &json!({
            "posts": posts,
            "entries": entries,
            "problem": ctx.problem,
            "relationships": relationships,
            "difficulties": Difficulty::ALL.iter().map(|d| d.value()).collect::<Vec<_>>(),
            "limits": {
                "steps": MAX_STEPS,
                "title": MAX_TITLE_CHARS,
                "text": MAX_TEXT_CHARS,
                "prerequisites": MAX_PREREQUISITE_CHARS,
            },
        }),
    )
}

/// `GET reading-paths/path?slug=`: one path, as a form model, as canonical
/// source, with its step states, diagnostics and public projection.
pub(super) fn get(state: &AppState, req: &Request) -> Response {
    let _content = lock(&state.build);
    let Some(slug) = req
        .query
        .get("slug")
        .filter(|slug| openblog_core::reading_path::valid_path_slug(slug))
    else {
        return Response::error(400, "Name the path by ?slug=");
    };
    let ctx = context(state);
    match store::read(&state.root, &ctx.content, slug) {
        Ok(Some(stored)) => {
            let mut v = view(&stored, &ctx);
            v["targetsProblem"] = json!(ctx.problem);
            v["publish"] = json!(ctx.switch);
            Response::json(200, &v)
        }
        Ok(None) => Response::error(404, "No such reading path"),
        Err(error) => store_error(state, error, Some(slug)),
    }
}

/// `POST reading-paths/preview`: check an unsaved path (a form model or
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
    match requested_path(&request, &slug) {
        Err(problems) => Response::json(
            200,
            &json!({ "valid": false, "problems": problems_json(&problems), "states": [],
                "projection": Json::Null }),
        ),
        Ok(path) => {
            let mut problems = path.validate();
            problems.extend(store::requirements(&path));
            let mut v = json!({
                "valid": problems.is_empty(),
                "problems": problems_json(&problems),
                "source": path.to_canonical_json(),
                "path": path_json(&path),
                "states": step_states(&path, &ctx),
                "projection": projection(&path, &ctx),
                "publish": ctx.switch,
            });
            v["targetsProblem"] = json!(ctx.problem);
            Response::json(200, &v)
        }
    }
}

/// `POST reading-paths` (create) and `PUT reading-paths` (replace, naming the
/// revision read). The body is `path` or `source`; what is written is always
/// the canonical form, and the response carries it.
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
        return Response::error(400, "Missing the path's revision");
    }
    let path = match requested_path(&request, &slug) {
        Ok(path) => path,
        Err(problems) => return store_error(state, PathError::Invalid(problems), None),
    };
    let _build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let ctx = context(state);
    let saved = if create {
        store::create(&state.root, &ctx.content, &path)
    } else {
        store::update(
            &state.root,
            &ctx.content,
            revision.as_deref().unwrap_or_default(),
            &path,
        )
    };
    match saved {
        Ok(saved) => {
            let stored = store::Stored {
                slug: slug.clone(),
                revision: saved.revision,
                text: saved.text,
                parsed: Ok(saved.path),
            };
            let mut v = view(&stored, &ctx);
            v["publish"] = json!(ctx.switch);
            v["targetsProblem"] = json!(ctx.problem);
            Response::json(if create { 201 } else { 200 }, &v)
        }
        Err(error) => store_error(state, error, Some(&slug)),
    }
}

/// `POST reading-paths/reorder`: move the steps into the order named by
/// `order` (every step id exactly once). A step that would become first has
/// no step to follow, so its transition would have to go; that is refused
/// unless the author confirms (`clearTransition`), so no written text is lost
/// by a reorder. A step that moves off the front needs one it never had, which
/// the request supplies in `transitions` (step id to `{relationship, why}`).
pub(super) fn reorder(state: &AppState, req: &Request) -> Response {
    let request = match body(req) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let slug = match slug_of(&request) {
        Ok(slug) => slug.to_string(),
        Err(response) => return response,
    };
    let Some(revision) = request["revision"].as_str().map(str::to_string) else {
        return Response::error(400, "Missing the path's revision");
    };
    let Some(order) = request["order"].as_array().map(|ids| {
        ids.iter()
            .map(|id| id.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()
    }) else {
        return Response::error(400, "`order` is the list of step ids in their new order");
    };
    let Some(order) = order else {
        return Response::error(400, "`order` holds step ids as text");
    };
    let clear = request["clearTransition"].as_bool().unwrap_or(false);
    let _build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let ctx = context(state);
    let current = match store::read(&state.root, &ctx.content, &slug) {
        Ok(Some(current)) => current,
        Ok(None) => return store_error(state, PathError::Missing, None),
        Err(error) => return store_error(state, error, Some(&slug)),
    };
    if current.revision != revision {
        return store_error(state, PathError::Conflict, Some(&slug));
    }
    let Ok(mut path) = current.parsed.clone() else {
        return Response::error(
            422,
            "This path has problems; repair it in source mode before reordering",
        );
    };
    let mut ids: Vec<&str> = path.steps.iter().map(|s| s.id.as_str()).collect();
    let mut wanted: Vec<&str> = order.iter().map(String::as_str).collect();
    ids.sort_unstable();
    wanted.sort_unstable();
    if ids != wanted {
        return Response::error(422, "`order` must name every step of the path exactly once");
    }
    let mut steps: Vec<Step> = Vec::new();
    for id in &order {
        let Some(step) = path.steps.iter().find(|s| &s.id == id) else {
            return Response::error(422, "`order` must name every step of the path exactly once");
        };
        steps.push(step.clone());
    }
    let mut cleared = Vec::new();
    if let Some(first) = steps.first_mut() {
        if first.transition.is_some() {
            if !clear {
                return Response::json(
                    422,
                    &json!({
                        "error": format!("Step `{}` would become the first step, which follows nothing, so its transition would be removed. Confirm to remove it, or choose another order.", first.id),
                        "needsConfirmation": true,
                        "step": first.id,
                    }),
                );
            }
            first.transition = None;
            cleared.push(first.id.clone());
        }
    }
    // A step that moves off the front now follows something, so the author
    // supplies the transition it never had: `transitions` maps a step id to
    // `{relationship, why}`. Nothing is invented for it.
    if let Some(given) = request["transitions"].as_object() {
        for step in &mut steps {
            if step.transition.is_some() {
                continue;
            }
            let Some(value) = given.get(&step.id) else {
                continue;
            };
            let file = format!("{PATHS_DIR}/{slug}.json");
            let wrapped = json!({"format": READING_PATH_FORMAT, "version": READING_PATH_VERSION,
                "title": "t", "steps": [
                    {"id": "first", "target": {"kind": "post", "slug": "x"}},
                    {"id": step.id, "target": {"kind": "post", "slug": "y"}, "transition": value}]});
            match ReadingPath::parse(&file, &wrapped.to_string()) {
                Ok(parsed) => step.transition = parsed.steps[1].transition.clone(),
                Err(problems) => {
                    return store_error(state, PathError::Invalid(problems), None);
                }
            }
        }
    }
    path.steps = steps;
    match store::update(&state.root, &ctx.content, &revision, &path) {
        Ok(saved) => {
            let stored = store::Stored {
                slug: slug.clone(),
                revision: saved.revision,
                text: saved.text,
                parsed: Ok(saved.path),
            };
            let mut v = view(&stored, &ctx);
            v["clearedTransitions"] = json!(cleared);
            Response::json(200, &v)
        }
        Err(error) => store_error(state, error, Some(&slug)),
    }
}

/// `DELETE reading-paths?slug=&revision=`: move the file to the trash folder.
/// Never destroys it, and refuses a stale revision.
pub(super) fn remove(state: &AppState, req: &Request) -> Response {
    let Some(slug) = req
        .query
        .get("slug")
        .filter(|slug| openblog_core::reading_path::valid_path_slug(slug))
    else {
        return Response::error(400, "Name the path by ?slug=");
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
