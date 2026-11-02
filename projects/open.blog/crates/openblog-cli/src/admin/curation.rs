//! Admin routes for curating the research context readers are given (#196,
//! ADR 0195, ADR 0196).
//!
//! `GET research/curation` reads the author's view of the selections: each one
//! with its status and the reason it publishes nothing, what readers of one
//! post get (the same `PublicCuration` value the public renderers read, so
//! the preview is not a second rendering), and the public items that can be
//! selected. The changing routes select, select again, withdraw, rescope,
//! order and unselect. Every one sits behind the session, the CSRF token and
//! the deny-by-default router, names the revision of the selections file it
//! was based on (a stale one is a `409` that changes nothing), takes the
//! content lock first and then the store locks in their one order, resolves
//! against the saved site exactly as a build does, and replaces the file by
//! atomic rename or not at all. None of them writes the research a selection
//! points at, and none approves anything: selecting a private item is refused.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::curated_selection::{
    curation_view, validate, Basis, Code, Diagnostic, NewSelection, Provenance, SelectionKind,
    SelectionSet, SELECTIONS_FILE,
};
use serde::Deserialize;
use serde_json::{json, Value as Json};

use super::{clock, content_transaction, lock, require_json, AppState, Request, Response};
use crate::boundary::{CurationBasis, Shared, Stores};
use crate::selection_store::{self, Locks, StoreError};
use crate::site;

/// A change is a small JSON object.
const MAX_BODY: usize = 64 * 1024;
/// The most selections one ordering may name.
const MAX_ORDER: usize = 500;

/// How a selection arrives. Unknown fields are refused, so a client cannot
/// smuggle a private or unpublished field into the stored record.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectRequest {
    #[serde(default)]
    id: Option<String>,
    kind: SelectionKind,
    target: String,
    #[serde(default)]
    optional_fields: Vec<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    by: Option<String>,
    #[serde(default)]
    locator: Option<String>,
    #[serde(default)]
    provenance: Provenance,
    #[serde(default)]
    requires: Vec<String>,
    #[serde(default)]
    posts: Option<Vec<String>>,
    #[serde(default)]
    positions: BTreeMap<String, u32>,
}

impl From<SelectRequest> for NewSelection {
    fn from(request: SelectRequest) -> Self {
        Self {
            id: request.id,
            kind: Some(request.kind),
            target: request.target,
            optional_fields: request.optional_fields,
            text: request.text,
            by: request.by,
            locator: request.locator,
            provenance: request.provenance,
            requires: request.requires,
            posts: request.posts,
            positions: request.positions,
        }
    }
}

/// What a change does to the set. It sees the set as stored and what the
/// build publishes, and returns the id the author's next view should focus.
type Change<'a> =
    dyn Fn(&mut SelectionSet, &Basis<'_>) -> Result<Option<String>, Vec<Diagnostic>> + 'a;

/// A change as a boxed closure, with the types the router gives it.
fn boxed<F>(apply: F) -> Box<Change<'static>>
where
    F: Fn(&mut SelectionSet, &Basis<'_>) -> Result<Option<String>, Vec<Diagnostic>> + 'static,
{
    Box::new(apply)
}

enum Failure {
    Store(StoreError),
    Refused(Vec<Diagnostic>),
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// A post slug as `slugify` writes one; anything else is not a post.
fn post_slug(text: &str) -> Option<&str> {
    let valid = !text.is_empty()
        && text.chars().count() <= 200
        && text.chars().all(|c| c.is_alphanumeric() || c == '-')
        && !text.starts_with('-');
    valid.then_some(text)
}

fn failure_response(state: &AppState, failure: Failure) -> Response {
    match failure {
        Failure::Store(StoreError::Conflict) => Response::json(
            409,
            &json!({
                "error": StoreError::Conflict.to_string(),
                "conflict": true,
                "revision": selection_store::load(&state.root).ok().map(|snapshot| snapshot.revision),
            }),
        ),
        Failure::Store(StoreError::Invalid(diagnostics)) => Response::json(
            422,
            &json!({
                "error": diagnostics.first().map_or_else(
                    || "The curated selections cannot be read.".to_string(),
                    |first| format!("{} Nothing was changed.", first.message),
                ),
                "file": SELECTIONS_FILE,
                "diagnostics": diagnostics,
            }),
        ),
        Failure::Store(StoreError::Storage(message)) => {
            Response::json(500, &json!({ "error": message, "file": SELECTIONS_FILE }))
        }
        Failure::Refused(diagnostics) => {
            let unknown = diagnostics
                .first()
                .is_some_and(|first| first.code == Code::UnknownSelection);
            Response::json(
                if unknown { 404 } else { 422 },
                &json!({
                    "error": diagnostics.first().map_or_else(
                        || "The change is not allowed.".to_string(),
                        |first| format!("{} Nothing was changed.", first.message),
                    ),
                    "file": SELECTIONS_FILE,
                    "diagnostics": diagnostics,
                }),
            )
        }
    }
}

/// Load the saved site as the server builds it. The build lock covers the
/// content snapshot only, as for the other previews.
fn load_saved_site(
    state: &AppState,
) -> Result<(openblog_core::Site, openblog_core::theme::ThemeSet), Response> {
    site::load_site(&state.root, state.include_drafts, Some(clock::now())).map_err(|error| {
        Response::json(
            422,
            &json!({
                "error": format!(
                    "The site could not be loaded, so nothing can be curated: {} Nothing was changed.",
                    error.lines().next().unwrap_or_default()
                ),
            }),
        )
    })
}

/// Read the stores a selection resolves against, attach the projections the
/// build attaches, and hand the basis to `with`. The curated switch is forced
/// on for the read so that the library is read for a site that has not yet
/// turned curation on: the author prepares it before publishing it.
///
/// `preview_post` is the post being edited. When it is not published yet, it
/// is added to the published set for this read alone (the way Admin's
/// production preview renders a draft as published), so its own selections
/// can be previewed and ordered; `with` is told whether that happened. The
/// build never does this.
fn with_basis<R>(
    state: &AppState,
    site: &mut openblog_core::Site,
    preview_post: Option<&str>,
    with: impl FnOnce(&openblog_core::Site, &Basis<'_>, bool) -> R,
) -> R {
    let mut config = site.config.clone();
    config.curated_context.publish = true;
    let shared = Shared::read(&state.root, &config);
    crate::boundary::project_with(&state.root, site, &shared);
    let stores = Stores::read(&state.root, &shared);
    let mut owned = CurationBasis::of(site, &stores);
    let assumed = preview_post.is_some_and(|slug| owned.assume_published(slug));
    with(site, &owned.basis(site, &stores), assumed)
}

/// The author's view of `set` against one basis.
fn view_value(
    set: &SelectionSet,
    basis: &Basis<'_>,
    post: Option<&str>,
    revision: &str,
    publish: bool,
    assumed: bool,
) -> Json {
    let resolution = openblog_core::curated_selection::resolve(set, basis);
    serde_json::to_value(curation_view(
        set,
        &resolution,
        basis,
        post,
        revision,
        publish,
        assumed,
    ))
    .unwrap_or_else(|_| json!({}))
}

fn view_json(
    state: &AppState,
    site: &mut openblog_core::Site,
    set: &SelectionSet,
    revision: &str,
    post: Option<&str>,
) -> Json {
    let publish = site.config.curated_context.publish;
    with_basis(state, site, post, |_, basis, assumed| {
        view_value(set, basis, post, revision, publish, assumed)
    })
}

/// `GET research/curation[?post=<slug>]`: the author's view. Read-only.
pub(super) fn view(state: &AppState, req: &Request) -> Response {
    let post = match req.query.get("post").map(String::as_str) {
        None | Some("") => None,
        Some(text) => match post_slug(text) {
            Some(slug) => Some(slug.to_string()),
            None => return Response::error(400, "That is not a post slug"),
        },
    };
    let guard = lock(&state.build);
    let loaded = load_saved_site(state);
    drop(guard);
    let (mut site, _) = match loaded {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let snapshot = match selection_store::load(&state.root) {
        Ok(snapshot) => snapshot,
        Err(error) => return failure_response(state, error.into()),
    };
    let mut view = view_json(
        state,
        &mut site,
        &snapshot.selections,
        &snapshot.revision,
        post.as_deref(),
    );
    // An ordering saved with its rebuild deferred has not reached the served
    // site yet: the view says so, so the Admin never claims otherwise.
    if lock(&state.build).curation_rebuild_pending {
        view["build"] = json!({ "ok": true, "pending": true });
    }
    Response::json(200, &view)
}

/// What an attempted change leaves: the set as written, its revision and the
/// id the next view should focus. The view is computed from it after the
/// locks are dropped, so no lock is held across the projections.
struct Attempted {
    focus: Option<String>,
    /// The author's view of the set as written, computed from the one read of
    /// the research stores the change was resolved against (the revision is
    /// filled in once the file is written).
    view: Json,
}

/// One attempt at a change: read the set, check the revision, apply the
/// change against what the build publishes, and either write it (under the
/// locks) or only check it (without them).
fn attempt(
    state: &AppState,
    site: &mut openblog_core::Site,
    expected: &str,
    post: Option<&str>,
    change: &Change<'_>,
    locks: Option<&Locks>,
) -> Result<Attempted, Failure> {
    let snapshot = selection_store::load(&state.root)?;
    if snapshot.revision != expected {
        return Err(Failure::Store(StoreError::Conflict));
    }
    let mut set = snapshot.selections.clone();
    let publish = site.config.curated_context.publish;
    let (focus, view) = with_basis(state, site, post, |_, basis, assumed| {
        let focus = change(&mut set, basis)?;
        Ok((
            focus,
            view_value(&set, basis, post, expected, publish, assumed),
        ))
    })
    .map_err(Failure::Refused)?;
    let revision = match locks {
        Some(locks) => selection_store::commit(&state.root, locks, &set, expected)?.revision,
        None => expected.to_string(),
    };
    let mut view = view;
    view["revision"] = json!(revision);
    Ok(Attempted { focus, view })
}

/// Apply one change under the content lock first and then the store locks.
fn change(
    state: &AppState,
    req: &Request,
    status: u16,
    deferrable: bool,
    prepare: impl FnOnce(&Json) -> Result<(Option<String>, Box<Change<'static>>), Response>,
) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    if req.body.len() > MAX_BODY {
        return Response::error(413, "A curation change is limited to 64 KiB");
    }
    let body: Json = match serde_json::from_slice::<Json>(&req.body) {
        Ok(body) if body.is_object() => body,
        _ => return Response::error(400, "Invalid JSON"),
    };
    let Some(revision) = body["revision"].as_str().map(str::to_string) else {
        return Response::error(400, "Missing curated selections revision");
    };
    // A client that is ordering step by step may say `"rebuild": false`: the
    // change is written, the served site is marked as behind, and one
    // `POST research/curation/rebuild` after the last step brings it up to
    // date. Only an ordering can be deferred.
    let defer = deferrable && body["rebuild"] == json!(false);
    let (post, apply) = match prepare(&body) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };
    // The locks are held for the change only: the content lock first (the
    // posts a selection is resolved against cannot change while it is
    // written), then the stores in their order. They are dropped before the
    // view is computed, so the projections never run under them.
    let written = {
        let mut content = lock(&state.build);
        let _filesystem = match content_transaction(state) {
            Ok(guard) => guard,
            Err(response) => return response,
        };
        let (mut site, _) = match load_saved_site(state) {
            Ok(loaded) => loaded,
            Err(response) => return response,
        };
        // While nothing is stored the change is first tried without the
        // locks, so a refused change never creates the private directory.
        if !selection_store::directory_exists(&state.root) {
            if let Err(failure) =
                attempt(state, &mut site, &revision, post.as_deref(), &*apply, None)
            {
                return failure_response(state, failure);
            }
        }
        let locks = match selection_store::lock(&state.root) {
            Ok(locks) => locks,
            Err(error) => return failure_response(state, error.into()),
        };
        match attempt(
            state,
            &mut site,
            &revision,
            post.as_deref(),
            &*apply,
            Some(&locks),
        ) {
            Ok(attempted) => {
                // The stores are released before the (long) build; the content
                // lock is kept, as every other publishing save keeps it.
                drop(locks);
                // While the site publishes curated context, the served site
                // follows the change at once, as it does for an atlas change
                // (#197), so what an author previews is what the next build
                // writes. The build's outcome travels as `build`.
                let build = site.config.curated_context.publish.then(|| {
                    if defer {
                        content.curation_rebuild_pending = true;
                        return json!({ "ok": true, "pending": true });
                    }
                    rebuild_report(state, &mut content)
                });
                (attempted, build)
            }
            Err(failure) => return failure_response(state, failure),
        }
    };
    let (attempted, build) = written;
    let mut view = attempted.view;
    if let Some(id) = attempted.focus {
        view["changed"] = json!(id);
    }
    if let Some(build) = build {
        view["build"] = build;
    }
    Response::json(status, &view)
}

/// Rebuild the served site and say how it went. A rebuild that follows a
/// change always clears the pending mark, whether or not it succeeded: the
/// outcome is what the Admin shows.
fn rebuild_report(state: &AppState, content: &mut super::BuildStatus) -> Json {
    content.curation_rebuild_pending = false;
    match state.rebuild_locked(content) {
        Ok(report) => json!({ "ok": true, "files": report.files }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// `POST research/curation/rebuild`: bring the served site up to date after
/// deferred orderings. It changes no selection and reads no private file.
pub(super) fn rebuild(state: &AppState, req: &Request) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    let mut content = lock(&state.build);
    let _filesystem = match content_transaction(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let (site, _) = match load_saved_site(state) {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    if !site.config.curated_context.publish {
        content.curation_rebuild_pending = false;
        return Response::json(200, &json!({ "build": { "ok": true, "pending": false } }));
    }
    let build = rebuild_report(state, &mut content);
    Response::json(200, &json!({ "build": build }))
}

fn post_of(body: &Json) -> Result<Option<String>, Response> {
    match body["post"].as_str() {
        None | Some("") => Ok(None),
        Some(text) => post_slug(text)
            .map(|slug| Some(slug.to_string()))
            .ok_or_else(|| Response::error(400, "That is not a post slug")),
    }
}

/// A selection id as the store writes one. Checked before an id is named in
/// any message or looked up, so a hostile one is never echoed.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn id_of(body: &Json) -> Result<String, Response> {
    body["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .map(str::to_string)
        // Checked before it is named in any message, so a hostile id is never echoed.
        .ok_or_else(|| Response::error(400, "Name the id of the selection"))
}

fn unknown(id: &str) -> Vec<Diagnostic> {
    vec![Diagnostic {
        code: Code::UnknownSelection,
        id: Some(id.to_string()),
        field: None,
        message: format!("There is no selection `{id}`."),
    }]
}

/// `POST research/curation/selections`: select something the build publishes.
pub(super) fn select(state: &AppState, req: &Request) -> Response {
    change(state, req, 201, false, |body| {
        let post = post_of(body)?;
        let request: SelectRequest = serde_json::from_value(body["selection"].clone())
            .map_err(|error| Response::error(422, &format!("Invalid selection: {error}")))?;
        let new = NewSelection::from(request);
        Ok((
            post,
            boxed(move |set, basis| set.select(new.clone(), basis).map(Some)),
        ))
    })
}

/// `PUT research/curation/selections`: `{ action: "reselect" | "withdraw" |
/// "scope", id, ... }`.
pub(super) fn update(state: &AppState, req: &Request) -> Response {
    change(state, req, 200, false, |body| {
        let post = post_of(body)?;
        let id = id_of(body)?;
        let action = body["action"].as_str().unwrap_or("").to_string();
        match action.as_str() {
            "reselect" => Ok((
                post,
                boxed(move |set, basis| {
                    set.reselect(&id, basis)?;
                    Ok(Some(id.clone()))
                }),
            )),
            "withdraw" => {
                let reason = body["reason"].as_str().map(str::to_string);
                Ok((
                    post,
                    boxed(move |set, _| {
                        if !set.withdraw(&id, reason.clone()) {
                            return Err(unknown(&id));
                        }
                        let problems = set.get(&id).map(validate).unwrap_or_default();
                        if problems.is_empty() {
                            Ok(Some(id.clone()))
                        } else {
                            Err(problems)
                        }
                    }),
                ))
            }
            "scope" => {
                let posts = match &body["posts"] {
                    Json::Null => None,
                    value => Some(
                        serde_json::from_value::<Vec<String>>(value.clone()).map_err(|_| {
                            Response::error(
                                422,
                                "`posts` is a list of post slugs, or null for the whole site",
                            )
                        })?,
                    ),
                };
                Ok((
                    post,
                    boxed(move |set, basis| {
                        set.rescope(&id, posts.clone(), basis)?;
                        Ok(Some(id.clone()))
                    }),
                ))
            }
            _ => Err(Response::error(
                422,
                "`action` is reselect, withdraw or scope",
            )),
        }
    })
}

/// `PUT research/curation/order`: `{ post, order: [ids] }`. The listed
/// selections take places 1..n among the items of that post, and of no other.
/// All or nothing: a stale or unknown selection refuses the whole ordering.
pub(super) fn order(state: &AppState, req: &Request) -> Response {
    change(state, req, 200, true, |body| {
        let post = post_of(body)?.ok_or_else(|| Response::error(400, "Name the post to order"))?;
        let ids: Vec<String> = serde_json::from_value(body["order"].clone())
            .map_err(|_| Response::error(422, "`order` is a list of selection ids"))?;
        let distinct: BTreeSet<&String> = ids.iter().collect();
        if ids.is_empty() || ids.len() > MAX_ORDER || distinct.len() != ids.len() {
            return Err(Response::error(
                422,
                "`order` names 1 to 500 different selections",
            ));
        }
        // Every id is checked before any is named in a message.
        if !ids.iter().all(|id| valid_id(id)) {
            return Err(Response::error(422, "`order` is a list of selection ids"));
        }
        let scope = post.clone();
        Ok((
            Some(post),
            boxed(move |set, basis| {
                set.order_for_post(&scope, &ids, basis)?;
                Ok(ids.first().cloned())
            }),
        ))
    })
}

/// `DELETE research/curation/selections`: remove the record. The research it
/// selected is untouched.
pub(super) fn unselect(state: &AppState, req: &Request) -> Response {
    change(state, req, 200, false, |body| {
        let post = post_of(body)?;
        let id = id_of(body)?;
        Ok((
            post,
            boxed(move |set, _| {
                if set.unselect(&id) {
                    Ok(None)
                } else {
                    Err(unknown(&id))
                }
            }),
        ))
    })
}
