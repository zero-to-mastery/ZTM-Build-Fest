mod evidence_navigation;
mod geometry;
mod graph;
mod graph_quality;
mod identity;
mod physics;
mod profile_evidence;
mod projection;
mod refinement;
mod recruiter_evidence;
mod scene;
mod semantic;
mod stable;
mod story_composition;
mod story_clarity;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn semantic_layout(input: &str) -> Result<String, String> {
    if input.len() > 1_000_000 {
        return Err("Semantic input exceeds 1 MiB".into());
    }
    let input =
        serde_json::from_str(input).map_err(|error| format!("Invalid semantic input: {error}"))?;
    serde_json::to_string(&semantic::layout(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn stable_positions(input: &str) -> Result<String, String> {
    let input =
        serde_json::from_str(input).map_err(|error| format!("Invalid overview: {error}"))?;
    serde_json::to_string(&stable::positions(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn refine_layout(input: &str) -> Result<String, String> {
    let input =
        serde_json::from_str(input).map_err(|error| format!("Invalid refinement: {error}"))?;
    serde_json::to_string(&refinement::refine(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn project_nodes(input: &str) -> Result<String, String> {
    let input =
        serde_json::from_str(input).map_err(|error| format!("Invalid projection: {error}"))?;
    serde_json::to_string(&projection::project(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn compute_scene(input: &str) -> Result<String, String> {
    let input = serde_json::from_str(input).map_err(|error| format!("Invalid scene: {error}"))?;
    serde_json::to_string(&scene::compute(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn developer_profile(input: &str) -> Result<String, String> {
    if input.len() > 1_000_000 {
        return Err("Developer profile input exceeds 1 MiB".into());
    }
    let input = serde_json::from_str(input)
        .map_err(|error| format!("Invalid developer profile: {error}"))?;
    serde_json::to_string(&profile_evidence::analyze(input)?).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn graph_quality(input: &str) -> Result<String, String> {
    graph_quality::evaluate(input)
}

#[wasm_bindgen]
pub fn compose_story(input: &str) -> Result<String, String> {
    if input.len() > 1_000_000 {
        return Err("Story Composition input exceeds 1 MiB".into());
    }
    story_composition::compose_json(input)
}

#[wasm_bindgen]
pub fn analyze_story_clarity(input: &str) -> Result<String, String> {
    story_clarity::analyze(input)
}

#[wasm_bindgen]
pub fn analyze_recruiter_evidence(input: &str) -> Result<String, String> {
    recruiter_evidence::analyze(input)
}

/// Retained Evidence Navigation index for one Semantic Graph v1. Build once per
/// graph and reuse it for every focus interaction.
#[wasm_bindgen]
pub struct EvidenceNavigator {
    index: evidence_navigation::NavigationIndex,
}

#[wasm_bindgen]
impl EvidenceNavigator {
    #[wasm_bindgen(constructor)]
    pub fn new(graph: &str) -> Result<EvidenceNavigator, String> {
        evidence_navigation::NavigationIndex::from_json(graph).map(|index| Self { index })
    }

    pub fn navigate(&self, request: &str) -> Result<String, String> {
        self.index.navigate_json(request)
    }

    #[wasm_bindgen(getter, js_name = projectCount)]
    pub fn project_count(&self) -> u32 {
        self.index.project_count() as u32
    }
}

#[wasm_bindgen]
pub fn identity_geometry(input: &str, variation: u32) -> Result<Vec<f64>, String> {
    identity::generate(input, variation).map_err(str::to_owned)
}

#[wasm_bindgen]
pub fn identity_points(input: &str, count: u32, rotations: &[f64]) -> Result<Vec<f64>, String> {
    identity::rotated_points(input, count as usize, rotations).map_err(str::to_owned)
}

#[wasm_bindgen]
pub fn shortest_path(count: u32, pairs: &[u32], start: u32, end: u32) -> Result<Vec<u32>, String> {
    graph::Graph::new(count, pairs, 900.0, 560.0)
        .and_then(|graph| graph.find_path(start, end))
        .map_err(str::to_owned)
}

#[wasm_bindgen]
pub fn neighbors(count: u32, pairs: &[u32], start: u32) -> Result<Vec<u32>, String> {
    graph::Graph::new(count, pairs, 900.0, 560.0).map_err(str::to_owned)?;
    if start >= count {
        return Err("Unknown node index".into());
    }
    let mut result = std::collections::BTreeSet::new();
    for pair in pairs.chunks_exact(2) {
        if pair[0] == start {
            result.insert(pair[1]);
        }
        if pair[1] == start {
            result.insert(pair[0]);
        }
    }
    Ok(result.into_iter().collect())
}

#[cfg(test)]
mod profile_api_tests {
    use super::developer_profile;

    #[test]
    fn developer_profile_rejects_malformed_and_oversized_json() {
        assert!(developer_profile("{")
            .unwrap_err()
            .contains("Invalid developer profile"));
        let oversized = " ".repeat(1_000_001);
        assert!(developer_profile(&oversized).unwrap_err().contains("1 MiB"));
        assert!(super::semantic_layout("{")
            .unwrap_err()
            .contains("Invalid semantic"));
        assert!(super::semantic_layout(&oversized)
            .unwrap_err()
            .contains("1 MiB"));
    }
}
