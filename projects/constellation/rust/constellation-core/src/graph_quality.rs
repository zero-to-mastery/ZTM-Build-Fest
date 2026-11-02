//! Deterministic, bounded evaluation of graph presentation quality.
//! Scores describe a candidate visualization, never its subject.
use serde::Deserialize;

pub const GRAPH_QUALITY_VERSION: u32 = 1;
const MAX_BYTES: usize = 1_000_000;
const MAX_NODES: usize = 512;
const MAX_EDGES: usize = 4096;
const MAX_GROUPS: usize = 128;

#[derive(Deserialize)]
struct Candidate {
    #[serde(default)]
    name: String,
    #[serde(default)]
    nodes: Vec<Node>,
    #[serde(default)]
    edges: Vec<Edge>,
    #[serde(default)]
    groups: Vec<Group>,
}
#[derive(Deserialize)]
struct Node {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    curated: bool,
}
#[derive(Deserialize)]
struct Edge {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}
#[derive(Deserialize)]
struct Group {
    #[serde(default)]
    members: Vec<String>,
    #[serde(default)]
    evidence: Vec<String>,
}

fn clamp(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
fn segment_cross(a: &Node, b: &Node, c: &Node, d: &Node) -> bool {
    fn orient(a: &Node, b: &Node, c: &Node) -> f64 {
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    }
    let (o1, o2, o3, o4) = (
        orient(a, b, c),
        orient(a, b, d),
        orient(c, d, a),
        orient(c, d, b),
    );
    o1 * o2 < 0.0 && o3 * o4 < 0.0
}

pub fn evaluate(input: &str) -> Result<String, String> {
    if input.len() > MAX_BYTES {
        return Err("Graph Quality input exceeds 1 MiB".into());
    }
    let c: Candidate =
        serde_json::from_str(input).map_err(|e| format!("Invalid Graph Quality candidate: {e}"))?;
    if c.nodes.len() > MAX_NODES || c.edges.len() > MAX_EDGES || c.groups.len() > MAX_GROUPS {
        return Err("Graph Quality candidate exceeds collection bounds".into());
    }
    let nodes: Vec<&Node> = c
        .nodes
        .iter()
        .filter(|n| n.x.is_finite() && n.y.is_finite())
        .collect();
    let projects = nodes.iter().filter(|n| n.kind == "project").count();
    let mut overlap = 0usize;
    for i in 0..nodes.len() {
        for j in i + 1..nodes.len() {
            let dx = nodes[i].x - nodes[j].x;
            let dy = nodes[i].y - nodes[j].y;
            let radius = if nodes[i].kind == "project" || nodes[j].kind == "project" {
                18.0
            } else {
                12.0
            };
            if dx * dx + dy * dy < radius * radius {
                overlap += 1;
            }
        }
    }
    let ids: std::collections::HashMap<&str, &Node> =
        nodes.iter().map(|n| (n.id.as_str(), *n)).collect();
    let edges: Vec<(&Node, &Node)> = c
        .edges
        .iter()
        .filter_map(|e| Some((*ids.get(e.from.as_str())?, *ids.get(e.to.as_str())?)))
        .collect();
    let mut crossings = 0usize;
    'pairs: for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            if edges[i].0.id == edges[j].0.id
                || edges[i].0.id == edges[j].1.id
                || edges[i].1.id == edges[j].0.id
                || edges[i].1.id == edges[j].1.id
            {
                continue;
            }
            if segment_cross(edges[i].0, edges[i].1, edges[j].0, edges[j].1) {
                crossings += 1;
                if crossings >= 1000 {
                    break 'pairs;
                }
            }
        }
    }
    let possible = projects.saturating_mul(projects.saturating_sub(1)) / 2;
    let project_edges = edges
        .iter()
        .filter(|(a, b)| a.kind == "project" && b.kind == "project")
        .count();
    let density = if possible == 0 {
        0.0
    } else {
        project_edges as f64 / possible as f64
    };
    let labels: usize = nodes
        .iter()
        .filter(|n| !n.label.is_empty())
        .map(|n| n.label.chars().count())
        .sum();
    let label_pressure = if nodes.is_empty() {
        0.0
    } else {
        (labels as f64 / (nodes.len() as f64 * 24.0)).clamp(0.0, 2.0) / 2.0
    };
    let legibility = clamp(
        1.0 - overlap as f64 / (nodes.len().max(1) as f64 * 1.5)
            - crossings as f64 / (edges.len().max(1) as f64 * 8.0)
            - density.max(0.55) * 0.65
            - label_pressure * 0.25,
    );
    let mut facts = std::collections::HashMap::<&str, usize>::new();
    for n in &nodes {
        for fact in &n.evidence {
            *facts.entry(fact).or_default() += 1;
        }
    }
    let unique = nodes
        .iter()
        .flat_map(|n| n.evidence.iter())
        .filter(|f| facts.get(f.as_str()) == Some(&1))
        .count();
    let distinct = facts.len();
    let mut feature_projects =
        std::collections::HashMap::<&str, std::collections::HashSet<&str>>::new();
    for n in &nodes {
        if n.kind == "project" {
            for fact in &n.evidence {
                feature_projects.entry(fact).or_default().insert(&n.id);
            }
        }
    }
    let discrimination = if projects == 0 || feature_projects.is_empty() {
        0.0
    } else {
        feature_projects
            .values()
            .map(|ids| {
                let p = ids.len() as f64 / projects as f64;
                4.0 * p * (1.0 - p)
            })
            .sum::<f64>()
            / feature_projects.len() as f64
    };
    let evidence_coverage = clamp(if nodes.is_empty() {
        0.0
    } else {
        (unique as f64 / nodes.len() as f64).min(1.0) * 0.55
            + (distinct as f64 / 4.0).min(1.0) * 0.30
            + (c.groups
                .iter()
                .filter(|g| !g.evidence.is_empty())
                .count()
                .min(5) as f64)
                * 0.03
    });
    let meaningful_groups = c
        .groups
        .iter()
        .filter(|g| g.members.len() >= 2 && g.members.len() <= projects.max(2))
        .count();
    let group_sizes: usize = c.groups.iter().map(|g| g.members.len()).sum();
    let group_balance = if meaningful_groups == 0 {
        if projects <= 12 {
            0.72
        } else {
            0.38
        }
    } else {
        let avg = group_sizes as f64 / meaningful_groups as f64;
        (1.0 - (avg - projects as f64 / meaningful_groups as f64).abs() / (projects.max(1) as f64))
            .clamp(0.0, 1.0)
    };
    let narrative = clamp(
        0.45 * group_balance
            + 0.35 * (meaningful_groups as f64 / 3.0).min(1.0)
            + 0.20 * (1.0 - density.min(1.0)),
    );
    let differentiation = clamp(discrimination * (1.0 - density.min(1.0)));
    let represented_projects = nodes
        .iter()
        .filter(|n| n.kind == "project" && !n.evidence.is_empty())
        .count();
    let curated_projects = nodes
        .iter()
        .filter(|n| n.kind == "project" && n.curated)
        .count();
    let project_coverage = clamp(if projects == 0 {
        0.0
    } else {
        0.75 * (represented_projects as f64 / projects as f64)
            + 0.25 * (curated_projects as f64 / projects as f64)
    });
    let score = clamp(
        legibility * 0.25
            + differentiation * 0.20
            + evidence_coverage * 0.20
            + narrative * 0.20
            + project_coverage * 0.15,
    );
    let mut diagnostics = Vec::new();
    if density > 0.5 {
        diagnostics.push("project-edges-too-dense");
    }
    if overlap > 0 {
        diagnostics.push("node-collisions");
    }
    if crossings > 0 {
        diagnostics.push("edge-crossings");
    }
    if meaningful_groups == 1 && projects > 8 {
        diagnostics.push("single-dominant-group");
    }
    if meaningful_groups == 0 && projects > 8 {
        diagnostics.push("no-visible-hierarchy");
    }
    if unique == 0 && projects > 0 {
        diagnostics.push("low-evidence-discrimination");
    }
    if label_pressure > 0.65 {
        diagnostics.push("label-pressure");
    }
    let result = serde_json::json!({"version":GRAPH_QUALITY_VERSION,"name":c.name,"score":score,"dimensions":{"legibility":legibility,"differentiation":differentiation,"evidenceCoverage":evidence_coverage,"narrativeStructure":narrative,"projectCoverage":project_coverage},"diagnostics":diagnostics});
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::evaluate;
    #[test]
    fn penalizes_dense_colliding_visualizations() {
        let good = r#"{"name":"good","nodes":[{"id":"a","kind":"project","label":"Alpha","x":0,"y":0,"evidence":["rust"]},{"id":"b","kind":"project","label":"Beta","x":100,"y":0,"evidence":["web"]}],"edges":[],"groups":[]}"#;
        let bad = r#"{"name":"bad","nodes":[{"id":"a","kind":"project","label":"Alpha","x":0,"y":0},{"id":"b","kind":"project","label":"Beta","x":1,"y":0}],"edges":[{"from":"a","to":"b"}],"groups":[]}"#;
        let a: serde_json::Value = serde_json::from_str(&evaluate(good).unwrap()).unwrap();
        let b: serde_json::Value = serde_json::from_str(&evaluate(bad).unwrap()).unwrap();
        assert!(a["score"].as_f64().unwrap() > b["score"].as_f64().unwrap());
    }
    #[test]
    fn enforces_candidate_bounds() {
        let mut x = String::from("{\"nodes\":[");
        for i in 0..513 {
            if i > 0 {
                x.push(',')
            }
            x.push_str("{}");
        }
        x.push_str("]}");
        assert!(evaluate(&x).unwrap_err().contains("bounds"));
    }
}
