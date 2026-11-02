//! The voice-guide route (ADR 0279, #456): propose a guide from selected samples, fold it into the
//! saved guide (ADR 0288, #423), show it as a diff against the saved guide, and write nothing.
//! Saving is the ordinary context save the author triggers afterwards.

use super::*;

/// The skill the task runs under: the project's `voice-guide` skill if it has one, else the
/// built-in. It must be a voice-guide skill, not a review skill.
fn resolve_guide_skill(root: &Path) -> Result<ReviewSkill, Response> {
    const ID: &str = "voice-guide";
    let projects = read_project_skills(root).map_err(|error| Response::error(500, &error))?;
    let id_counts = project_skill_id_counts(&projects);
    let builtins = builtin_skills();
    let builtin = builtins.iter().find(|skill| skill.id == ID);
    let project = active_project_skill(&projects, &id_counts, ID, builtin.is_some())
        .map_err(|message| Response::error(409, message))?;
    let skill = match (builtin, project) {
        (Some(_), Some(project)) | (None, Some(project)) => project.clone(),
        (Some(builtin), None) => builtin.clone(),
        (None, None) => return Err(Response::error(400, "The voice-guide skill is unavailable")),
    };
    if skill.output != SkillOutputKind::VoiceGuide {
        return Err(Response::error(
            400,
            "The voice-guide skill must have output: voice-guide",
        ));
    }
    Ok(ReviewSkill {
        id: skill.id,
        version: skill.version,
        instructions: skill.body,
    })
}

/// What the Admin needs to save a guide: whether each file exists and the revision to send back.
fn guide_target(doc: &Json) -> Json {
    json!({
        "exists": doc["exists"],
        "valid": doc["valid"],
        "etag": doc["etag"],
        "characters": doc["characters"],
    })
}

use openblog_core::voice::guide::PROVENANCE_MARKER;
use openblog_core::voice::merge::{merge, Choice, QuoteCheck, SavedGuide};

/// The provenance line a proposed guide carries under its title: which visibilities it was folded
/// from, so a later save can tell that a guide quotes private samples.
fn provenance_line(samples: &[ReviewContext], private_sources: bool) -> String {
    let mut sources: Vec<&str> = samples.iter().map(|s| s.visibility().as_str()).collect();
    // The saved guide the proposal is folded into counts as a source too.
    if private_sources {
        sources.push("private");
    }
    sources.sort_unstable();
    sources.dedup();
    format!("{PROVENANCE_MARKER} sources={} -->", sources.join(","))
}

/// Whether a voice guide's provenance line says it quotes a private sample.
pub(super) fn guide_quotes_private_samples(content: &str) -> bool {
    openblog_core::voice::guide::quotes_private_samples(content)
}

pub(super) fn generate_voice_guide(state: &AppState, req: &Request) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    let body: Json = match serde_json::from_slice(&req.body) {
        Ok(body) => body,
        Err(_) => return Response::error(400, "Invalid voice guide request"),
    };
    let sample_ids = match selected_ids(
        &body,
        "sampleIds",
        crate::voice_assistant::MAX_SAMPLES_PER_REQUEST,
    ) {
        Ok(ids) => ids,
        Err(response) => return response,
    };
    if sample_ids.is_empty() {
        return Response::error(400, "Select at least one voice sample");
    }
    if sample_ids.iter().any(|id| !id.starts_with("voice:")) {
        return Response::error(400, "A voice guide is proposed from voice samples only");
    }
    let (skill, samples, portable, private) = {
        let _assistant_lock = lock(&state.build);
        let skill = match resolve_guide_skill(&state.root) {
            Ok(skill) => skill,
            Err(response) => return response,
        };
        let samples = match resolve_review_contexts(&state.root, &sample_ids) {
            Ok(samples) => samples,
            Err(response) => return response,
        };
        let portable = match assistant_context_document(&state.root, "voice", "portable", None) {
            Ok(document) => document,
            Err(response) => return response,
        };
        let private = match assistant_context_document(&state.root, "voice", "private", None) {
            Ok(document) => document,
            Err(response) => return response,
        };
        (skill, samples, portable, private)
    };
    let usable = |doc: &Json| doc["exists"] == true && doc["valid"] == true;
    let current = match body["guide"].as_str() {
        None => [&portable, &private].into_iter().find(|doc| usable(doc)),
        Some("portable") => Some(&portable).filter(|doc| usable(doc)),
        Some("private") => Some(&private).filter(|doc| usable(doc)),
        Some(_) => return Response::error(400, "`guide` must be portable or private"),
    };
    let current_text = current
        .and_then(|doc| doc["content"].as_str())
        .map(str::to_string);

    let (config, credential) = match assistant_provider_snapshot(state) {
        Ok(snapshot) => snapshot,
        Err(response) => return response,
    };
    let provider = match configured_assistant_provider(
        &config,
        credential,
        assistant_provider_timeout(config.knowledge_checks.provider, cfg!(test)),
    ) {
        Ok(provider) => provider,
        Err(error) => return review_error(error),
    };
    let request = AssistantRequest::voice_guide(
        config.knowledge_checks.model.clone(),
        skill.clone(),
        current_text.clone(),
        samples.clone(),
        crate::voice_assistant::gaps_json(&crate::voice_assistant::gaps_for(
            &state.root,
            current_text.as_deref(),
        )),
    );
    let _provider_permit = match state.assistant_operations.try_acquire() {
        Some(permit) => permit,
        None => {
            return Response::json(
                429,
                &json!({ "error": "Two Assistant operations are already running; try again shortly", "code": "concurrency-limit" }),
            )
        }
    };
    let guide = match provider.generate(&request) {
        Ok(AssistantResult::VoiceGuide(guide)) => guide,
        Ok(_) => return Response::error(502, "Assistant provider returned the wrong result type"),
        Err(error) => return review_error(error),
    };
    // The proposal is folded into the saved guide (ADR 0288): saved traits it does not address and
    // the free text around them are kept, and a changed trait waits for the author's choice.
    let saved = SavedGuide::parse(current_text.as_deref().unwrap_or(""));
    let merged = merge(&saved, &guide);
    let carried = crate::voice_store::carried_samples(&state.root, &saved);
    // The merged guide carries the saved guide's text, and a statement is free text that no quote
    // check covers. So a private guide, one that quotes private samples, or one whose traits cite a
    // sample that is private now makes the result private-derived whatever samples were selected.
    let private_sources = current.is_some_and(|doc| doc["visibility"] == "private")
        || current_text
            .as_deref()
            .is_some_and(guide_quotes_private_samples)
        || carried
            .values()
            .any(|(visibility, _)| *visibility == crate::voice_store::Visibility::Private);
    let provenance = provenance_line(&samples, private_sources);
    let portable_allowed = !provenance.contains("private");
    let check = |item: &openblog_core::voice::guide::Trait| {
        QuoteCheck::of(
            item,
            carried.get(&item.sample).map(|(_, text)| text.as_str()),
        )
    };
    // With every proposed change taken: the diff shows the whole of what the proposal would do.
    let proposed = merged.render(Some(&provenance), |_| Choice::Proposed);
    let markdown = (merged.changes == 0).then(|| proposed.clone());
    let diff = crate::voice_diff::unified(
        "voice.md (saved)",
        "voice.md (proposed)",
        current_text.as_deref().unwrap_or(""),
        &proposed,
    );
    Response::json(
        200,
        &json!({
            "schemaVersion": ASSISTANT_SCHEMA_VERSION,
            "guide": guide.to_json(),
            "markdown": markdown,
            "merge": merged.to_json(Some(&provenance), check),
            "portableAllowed": portable_allowed,
            "current": {
                "visibility": current.map(|doc| doc["visibility"].clone()),
                "exists": current.is_some(),
                "content": current_text,
            },
            "diff": diff,
            "targets": { "portable": guide_target(&portable), "private": guide_target(&private) },
            "samples": samples.iter().map(|sample| json!({
                "id": sample.identity(),
                "name": sample.name(),
                "visibility": sample.visibility().as_str(),
                "characters": sample.content().chars().count(),
            })).collect::<Vec<_>>(),
            "skill": { "id": skill.id, "version": skill.version },
            "provider": { "type": "generic-https", "model": config.knowledge_checks.model },
            "research": { "enabled": false },
            "createdAt": clock::now().rfc3339(),
        }),
    )
}
