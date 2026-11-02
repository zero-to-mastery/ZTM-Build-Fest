//! Bounded deterministic selection of evidence-backed portfolio relationships.
use std::collections::{BTreeMap, BTreeSet};

const MAX_PROJECTS: usize = 512;
const MAX_FACTS_PER_PROJECT: usize = 64;
const MAX_FAMILIES: usize = 256;
const MAX_RELATIONSHIPS: usize = 4096;
const MAX_EDGE_BUDGET: usize = 4096;
const MAX_DIAGNOSTICS: usize = 256;
const MAX_CANDIDATES: usize = 16_384;
const MAX_FAMILY_MEMBERS: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    pub id: String,
    pub languages: Vec<String>,
    pub topics: Vec<String>,
    pub featured: bool,
    pub position: Option<[f64; 2]>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    pub id: String,
    pub members: Vec<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ExplicitRelationship {
    pub id: String,
    pub from: String,
    pub to: String,
}
#[derive(Debug, PartialEq)]
pub struct Input {
    pub projects: Vec<Project>,
    pub families: Vec<Family>,
    pub relationships: Vec<ExplicitRelationship>,
    pub edge_budget: Option<usize>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Relationship {
    pub id: String,
    pub from: String,
    pub to: String,
    pub semantic_type: String,
    pub types: Vec<String>,
    pub evidence: Vec<String>,
    pub score: u32,
}
#[derive(Debug, PartialEq)]
pub struct Diagnostic {
    pub relationship_id: String,
    pub reason: String,
}
#[derive(Debug, PartialEq)]
pub struct Output {
    pub version: u32,
    pub relationships: Vec<Relationship>,
    pub diagnostics: Vec<Diagnostic>,
    pub suppressed_count: usize,
    pub candidate_count: usize,
}

fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn add(
    candidates: &mut BTreeMap<String, Relationship>,
    kind: &str,
    a: &str,
    b: &str,
    evidence: Vec<String>,
    score: u32,
) -> usize {
    let (from, to) = if a <= b { (a, b) } else { (b, a) };
    let key = format!("{}:{}{}:{}", from.len(), from, to.len(), to);
    if !candidates.contains_key(&key) && candidates.len() >= MAX_CANDIDATES {
        return 1;
    }
    let id = format!("story-rel:{key}");
    let relationship = candidates.entry(key).or_insert(Relationship {
        id,
        from: from.into(),
        to: to.into(),
        semantic_type: kind.into(),
        types: vec![kind.into()],
        evidence: vec![],
        score: 0,
    });
    relationship.types.push(kind.into());
    relationship.types.sort();
    relationship.types.dedup();
    relationship.evidence.extend(evidence);
    relationship.evidence.sort();
    relationship.evidence.dedup();
    if score > relationship.score
        || (score == relationship.score && kind < relationship.semantic_type.as_str())
    {
        relationship.score = score;
        relationship.semantic_type = kind.into();
    }
    0
}

fn required_text(value: &serde_json::Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Story Composition field {key} must be text"))
}

fn text_list(value: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.get(key) else {
        return Ok(Vec::new());
    };
    let items = items
        .as_array()
        .ok_or_else(|| format!("Story Composition field {key} must be a list"))?;
    if items.len() > MAX_FACTS_PER_PROJECT {
        return Err("Story Composition evidence list exceeds bounds".into());
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("Story Composition field {key} must contain text"))
        })
        .collect()
}

fn parse_input(json: &str) -> Result<Input, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("Invalid Story Composition input: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Story Composition input must be an object".to_owned())?;
    let project_values = object
        .get("projects")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Story Composition projects must be a list".to_owned())?;
    if project_values.len() > MAX_PROJECTS {
        return Err("Story Composition input exceeds collection bounds".into());
    }
    let mut projects = Vec::with_capacity(project_values.len());
    for item in project_values {
        let position = match item.get("position") {
            None | Some(serde_json::Value::Null) => None,
            Some(point) => {
                let point = point
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| {
                        "Story Composition position must contain two numbers".to_owned()
                    })?;
                Some([
                    point[0]
                        .as_f64()
                        .ok_or_else(|| "Invalid Story Composition position".to_owned())?,
                    point[1]
                        .as_f64()
                        .ok_or_else(|| "Invalid Story Composition position".to_owned())?,
                ])
            }
        };
        projects.push(Project {
            id: required_text(item, "id")?,
            languages: text_list(item, "languages")?,
            topics: text_list(item, "topics")?,
            featured: item
                .get("featured")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            position,
        });
    }
    let family_values = object
        .get("families")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if family_values.len() > MAX_FAMILIES {
        return Err("Story Composition input exceeds collection bounds".into());
    }
    let mut families = Vec::with_capacity(family_values.len());
    for item in family_values {
        let members = item
            .get("members")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|value| {
                        value.as_str().map(str::to_owned).ok_or_else(|| {
                            "Story Composition family members must be text".to_owned()
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        families.push(Family {
            id: required_text(item, "id")?,
            members,
        });
    }
    let relationship_values = object
        .get("relationships")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if relationship_values.len() > MAX_RELATIONSHIPS {
        return Err("Story Composition input exceeds collection bounds".into());
    }
    let relationships = relationship_values
        .iter()
        .map(|item| {
            Ok(ExplicitRelationship {
                id: required_text(item, "id")?,
                from: required_text(item, "from")?,
                to: required_text(item, "to")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let edge_budget =
        match object.get("edge_budget") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) => Some(
                usize::try_from(value.as_u64().ok_or_else(|| {
                    "Story Composition edge budget must be an integer".to_owned()
                })?)
                .map_err(|_| "Story Composition edge budget exceeds platform bounds".to_owned())?,
            ),
        };
    Ok(Input {
        projects,
        families,
        relationships,
        edge_budget,
    })
}

pub fn compose_json(json: &str) -> Result<String, String> {
    let result = compose(parse_input(json)?)?;
    let relationships: Vec<_> = result
        .relationships
        .iter()
        .map(|edge| {
            serde_json::json!({
                "id": edge.id, "from": edge.from, "to": edge.to, "type": edge.semantic_type,
                "types": edge.types, "evidence": edge.evidence, "score": edge.score,
            })
        })
        .collect();
    let diagnostics: Vec<_> = result
        .diagnostics
        .iter()
        .map(|item| {
            serde_json::json!({
                "relationship_id": item.relationship_id, "reason": item.reason,
            })
        })
        .collect();
    serde_json::to_string(&serde_json::json!({
        "version": 1, "relationships": relationships, "diagnostics": diagnostics,
        "suppressed_count": result.suppressed_count, "candidate_count": result.candidate_count,
    }))
    .map_err(|error| error.to_string())
}

pub fn compose(input: Input) -> Result<Output, String> {
    let count = input.projects.len();
    if count > MAX_PROJECTS
        || input.families.len() > MAX_FAMILIES
        || input.relationships.len() > MAX_RELATIONSHIPS
    {
        return Err("Story Composition input exceeds collection bounds".into());
    }
    let budget = input.edge_budget.unwrap_or(count.saturating_mul(2).max(1));
    if budget == 0 || budget > MAX_EDGE_BUDGET {
        return Err("Invalid Story Composition edge budget".into());
    }
    let mut projects = input.projects;
    projects.sort_by(|a, b| a.id.cmp(&b.id));
    if projects.iter().any(|p| {
        !valid_text(&p.id)
            || p.languages.len() > MAX_FACTS_PER_PROJECT
            || p.topics.len() > MAX_FACTS_PER_PROJECT
            || p.position
                .is_some_and(|v| v.iter().any(|n| !n.is_finite() || n.abs() > 1_000_000.0))
    }) {
        return Err("Invalid or oversized Story Composition project".into());
    }
    if projects.windows(2).any(|w| w[0].id == w[1].id) {
        return Err("Duplicate Story Composition project ID".into());
    }
    for p in &projects {
        if p.languages.iter().chain(&p.topics).any(|v| !valid_text(v)) {
            return Err("Invalid Story Composition evidence value".into());
        }
    }
    let language_sets: Vec<BTreeSet<&str>> = projects
        .iter()
        .map(|p| p.languages.iter().map(String::as_str).collect())
        .collect();
    let topic_sets: Vec<BTreeSet<&str>> = projects
        .iter()
        .map(|p| p.topics.iter().map(String::as_str).collect())
        .collect();
    let project_ids: BTreeSet<String> = projects.iter().map(|p| p.id.clone()).collect();
    let mut candidates = BTreeMap::new();
    let mut generation_suppressed = 0usize;
    let mut relationships = input.relationships;
    relationships.sort_by(|a, b| a.id.cmp(&b.id));
    for edge in relationships {
        if !valid_text(&edge.id)
            || edge.from == edge.to
            || !project_ids.contains(&edge.from)
            || !project_ids.contains(&edge.to)
        {
            continue;
        }
        generation_suppressed += add(
            &mut candidates,
            "explicit-relationship",
            &edge.from,
            &edge.to,
            vec![format!("relationship:{}", edge.id)],
            120,
        );
    }
    let mut families = input.families;
    families.sort_by(|a, b| a.id.cmp(&b.id));
    let mut family_pair_work = 0usize;
    for family in families {
        if !valid_text(&family.id) || family.members.len() > MAX_FAMILY_MEMBERS {
            return Err("Invalid Story Composition family".into());
        }
        let members: Vec<_> = family
            .members
            .iter()
            .filter(|id| project_ids.contains(*id))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for i in 0..members.len() {
            for j in i + 1..members.len() {
                family_pair_work += 1;
                if family_pair_work > 32_768 {
                    generation_suppressed += members.len() * (members.len() - 1) / 2;
                    break;
                }
                generation_suppressed += add(
                    &mut candidates,
                    "authored-family",
                    members[i],
                    members[j],
                    vec![format!("family:{}", family.id)],
                    100,
                );
            }
        }
    }
    for i in 0..projects.len() {
        for j in i + 1..projects.len() {
            let a = &projects[i];
            let b = &projects[j];
            let languages: Vec<_> = language_sets[i]
                .intersection(&language_sets[j])
                .map(|v| format!("language:{}", v))
                .take(8)
                .collect();
            if !languages.is_empty() {
                generation_suppressed += add(
                    &mut candidates,
                    "shared-language",
                    &a.id,
                    &b.id,
                    languages,
                    20,
                );
            }
            let topics: Vec<_> = topic_sets[i]
                .intersection(&topic_sets[j])
                .map(|v| format!("topic:{}", v))
                .take(8)
                .collect();
            if !topics.is_empty() {
                generation_suppressed +=
                    add(&mut candidates, "shared-topic", &a.id, &b.id, topics, 10);
            }
        }
    }
    let project_map: BTreeMap<_, _> = projects.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut ranked: Vec<_> = candidates.into_values().collect();
    ranked.sort_by(|a, b| {
        let featured_a = project_map[a.from.as_str()].featured as u32
            + project_map[a.to.as_str()].featured as u32;
        let featured_b = project_map[b.from.as_str()].featured as u32
            + project_map[b.to.as_str()].featured as u32;
        let distance = |edge: &Relationship| -> f64 {
            match (
                project_map[edge.from.as_str()].position,
                project_map[edge.to.as_str()].position,
            ) {
                (Some(a), Some(b)) => (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2),
                _ => f64::INFINITY,
            }
        };
        b.score
            .cmp(&a.score)
            .then_with(|| b.evidence.len().cmp(&a.evidence.len()))
            .then_with(|| featured_b.cmp(&featured_a))
            .then_with(|| distance(a).total_cmp(&distance(b)))
            .then_with(|| a.id.cmp(&b.id))
    });
    let candidate_count = ranked.len() + generation_suppressed;
    let selected: BTreeSet<_> = ranked.iter().take(budget).map(|e| e.id.clone()).collect();
    let mut diagnostics = Vec::new();
    let edge_diagnostic_limit = MAX_DIAGNOSTICS - usize::from(generation_suppressed > 0);
    for edge in &ranked {
        if selected.contains(&edge.id) {
            continue;
        }
        if diagnostics.len() < edge_diagnostic_limit {
            diagnostics.push(Diagnostic {
                relationship_id: edge.id.clone(),
                reason: "edge-budget".into(),
            });
        }
    }
    if generation_suppressed > 0 && diagnostics.len() < MAX_DIAGNOSTICS {
        diagnostics.push(Diagnostic {
            relationship_id: "story-composition".into(),
            reason: "candidate-generation-limit".into(),
        });
    }
    let mut relationships: Vec<_> = ranked
        .into_iter()
        .filter(|e| selected.contains(&e.id))
        .collect();
    relationships.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Output {
        version: 1,
        relationships,
        diagnostics,
        suppressed_count: candidate_count.saturating_sub(selected.len()),
        candidate_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(reverse: bool) -> Input {
        let mut projects = vec![
            Project {
                id: "a".into(),
                languages: vec!["Rust".into()],
                topics: vec!["wasm".into()],
                featured: true,
                position: Some([0.0, 0.0]),
            },
            Project {
                id: "b".into(),
                languages: vec!["Rust".into()],
                topics: vec!["wasm".into()],
                featured: false,
                position: Some([20.0, 0.0]),
            },
            Project {
                id: "c".into(),
                languages: vec!["JS".into()],
                topics: vec![],
                featured: false,
                position: Some([30.0, 0.0]),
            },
        ];
        if reverse {
            projects.reverse();
        }
        Input {
            projects,
            families: vec![Family {
                id: "tooling".into(),
                members: vec!["b".into(), "a".into()],
            }],
            relationships: vec![ExplicitRelationship {
                id: "custom".into(),
                from: "a".into(),
                to: "c".into(),
            }],
            edge_budget: Some(2),
        }
    }
    #[test]
    fn output_is_stable_and_explicit_evidence_wins() {
        let a = compose(input(false)).unwrap();
        let b = compose(input(true)).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.relationships.len(), 2);
        assert!(a
            .relationships
            .iter()
            .any(|e| e.semantic_type == "explicit-relationship"));
    }
    #[test]
    fn rejects_duplicate_ids_and_bad_budget() {
        let mut x = input(false);
        x.edge_budget = Some(MAX_EDGE_BUDGET + 1);
        assert!(compose(x).is_err());
        let mut x = input(false);
        x.projects.push(x.projects[0].clone());
        assert!(compose(x).unwrap_err().contains("Duplicate"));
    }
    #[test]
    fn candidate_generation_is_bounded_and_keeps_authored_edges_ahead_of_inferred_edges() {
        let projects = (0..200)
            .map(|i| Project {
                id: format!("project-{i:03}"),
                languages: vec!["Rust".into()],
                topics: vec![],
                featured: false,
                position: None,
            })
            .collect();
        let result = compose(Input {
            projects,
            families: vec![],
            relationships: vec![ExplicitRelationship {
                id: "authored".into(),
                from: "project-000".into(),
                to: "project-199".into(),
            }],
            edge_budget: Some(1),
        })
        .unwrap();
        assert_eq!(result.relationships.len(), 1);
        assert_eq!(
            result.relationships[0].semantic_type,
            "explicit-relationship"
        );
        assert!(result.candidate_count > MAX_CANDIDATES);
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.reason == "candidate-generation-limit"));
    }
    #[test]
    fn json_boundary_emits_contract_names_and_rejects_malformed_budgets() {
        let output = compose_json(
            r#"{"projects":[{"id":"a","languages":["Rust"]},{"id":"b","languages":["Rust"]}]}"#,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["relationships"][0]["type"], "shared-language");
        assert!(compose_json(r#"{"projects":[],"edge_budget":-1}"#)
            .unwrap_err()
            .contains("edge budget"));
    }
}
