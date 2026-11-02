use crate::{graph::Graph, identity, profile_evidence};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

thread_local! {
    // Manual dragging changes edge distances, not the settled base layout.
    static FORCE_LAYOUT: std::cell::RefCell<Option<(String, Vec<[f64; 2]>)>> = const { std::cell::RefCell::new(None) };
}

#[derive(Clone, Deserialize)]
pub struct Repository {
    name: String,
    group: String,
    languages: Vec<String>,
    #[serde(default)]
    language_shares: BTreeMap<String, f64>,
    topics: Vec<String>,
    #[serde(default)]
    role: String,
    #[serde(default)]
    members: Vec<String>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    hidden: bool,
    position: Option<[f64; 2]>,
}

#[derive(Clone, Deserialize)]
pub struct Input {
    account: String,
    repos: Vec<Repository>,
    #[serde(default)]
    profile_repositories: Vec<profile_evidence::Repository>,
    compact: bool,
    arrangement: String,
    #[serde(default = "automatic_emphasis")]
    profile_emphasis: String,
    #[serde(default)]
    profile_height: f64,
    all: bool,
    basis: String,
    #[serde(default)]
    ring_rotation: f64,
    #[serde(default)]
    ring_rotations: Option<[f64; 4]>,
    /// Round orbits use the same horizontal and vertical spread. The default
    /// (wide) stretches orbits about 2:1 so a map fills a README banner.
    #[serde(default)]
    round: bool,
}

#[derive(Serialize)]
pub struct Edge {
    from: usize,
    to: usize,
    languages: Vec<String>,
    topics: Vec<String>,
    members: Vec<String>,
    primary: bool,
    #[serde(skip)]
    distance: f64,
}

#[derive(Serialize)]
pub struct Scene {
    positions: Vec<[f64; 2]>,
    edges: Vec<Edge>,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<profile_evidence::Profile>,
}

// Match the existing account-seeded field, including JS's first UTF-16 unit.
fn hash(value: &str) -> u32 {
    let mut n = value.chars().fold(7u32, |n, ch| {
        let mut units = [0; 2];
        n.wrapping_mul(31)
            .wrapping_add(ch.encode_utf16(&mut units)[0] as u32)
    });
    n = (n ^ (n >> 16)).wrapping_mul(0x45d9f3b);
    n = (n ^ (n >> 16)).wrapping_mul(0x45d9f3b);
    n ^ (n >> 16)
}

fn automatic_emphasis() -> String {
    "automatic".into()
}

fn overlap(a: &[String], b: &[String]) -> Vec<String> {
    a.iter()
        .filter(|value| b.contains(value))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn key(edge: &Edge) -> String {
    format!("{}:{}", edge.from, edge.to)
}
fn weight(edge: &Edge) -> usize {
    edge.languages.len() + edge.topics.len() + edge.members.len()
}
fn root(parent: &[usize], mut index: usize) -> usize {
    while parent[index] != index {
        index = parent[index];
    }
    index
}

pub fn compute(input: Input) -> Result<Scene, String> {
    let n = input.repos.len();
    if n > if input.basis == "membership" {
        256
    } else {
        100
    } {
        return Err("At most 100 repositories are supported".into());
    }
    if !["field", "orbital", "force", "rings", "profile"].contains(&input.arrangement.as_str()) {
        return Err("Unknown arrangement".into());
    }
    if input.arrangement == "profile"
        && input.profile_emphasis != "automatic"
        && !profile_evidence::DIMENSIONS.contains(&input.profile_emphasis.as_str())
    {
        return Err("Unknown developer profile emphasis".into());
    }
    if input.arrangement == "profile"
        && input.profile_height != 0.0
        && (!input.profile_height.is_finite() || !(160.0..=2000.0).contains(&input.profile_height))
    {
        return Err("Developer topology height must be between 160 and 2000".into());
    }
    if !["languages", "topics", "both", "repositories", "membership"]
        .contains(&input.basis.as_str())
    {
        return Err("Unknown connection basis".into());
    }
    let height = if input.arrangement == "profile" && input.profile_height > 0.0 {
        input.profile_height
    } else if input.compact {
        280.0
    } else {
        560.0
    };
    let center = if input.compact { 126.0 } else { 270.0 };
    let spread = if input.compact { 88.0 } else { 192.0 };
    let spread_x = if input.round { spread } else { 368.0 };
    let phase = (hash(&input.account) % 628) as f64 / 100.0;
    let rings = identity::generate(&input.account, 0).map_err(str::to_owned)?;
    let ring_points = if input.arrangement == "rings" {
        identity::rotated_points(
            &input.account,
            n,
            &input.ring_rotations.unwrap_or([input.ring_rotation; 4]),
        )
        .map_err(str::to_owned)?
    } else {
        vec![]
    };
    let mut positions: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            if input.arrangement == "rings" {
                return [
                    450.0 + (ring_points[i * 3] - 240.0) * spread_x / 172.0,
                    center + (ring_points[i * 3 + 1] - 240.0) * spread / 172.0,
                ];
            }
            let (angle, radius) = if input.arrangement == "orbital" {
                let ring = i % 4;
                let count = (n - 1 - ring) / 4 + 1;
                (
                    rings[3 + ring * 22].to_radians()
                        + (i / 4) as f64 * std::f64::consts::TAU / count as f64,
                    rings[2 + ring * 22] / 172.0,
                )
            } else {
                (
                    i as f64 * 2.399963 + phase,
                    if n == 1 {
                        0.0
                    } else {
                        ((i as f64 + 0.6) / n as f64).sqrt()
                    },
                )
            };
            [
                450.0 + angle.cos() * radius * spread_x,
                center + angle.sin() * radius * spread,
            ]
        })
        .collect();
    let profile = if input.arrangement == "profile" {
        let evidence_repositories = if input.profile_repositories.is_empty() {
            input
                .repos
                .iter()
                .filter(|repo| repo.kind == "repository")
                .map(|repo| profile_evidence::Repository {
                    name: repo.name.clone(),
                    languages: repo.language_shares.clone(),
                    language_names: repo.languages.clone(),
                    topics: repo.topics.clone(),
                    role: repo.role.clone(),
                })
                .collect()
        } else {
            input.profile_repositories
        };
        let mut analysis = profile_evidence::analyze(profile_evidence::Input {
            repositories: evidence_repositories,
        })?;
        let repository_affinities: BTreeMap<_, _> = analysis
            .repositories
            .iter()
            .map(|repository| (repository.repository.clone(), repository.dimensions.clone()))
            .collect();
        analysis.nodes = input
            .repos
            .iter()
            .map(|node| {
                let dimensions = repository_affinities
                    .get(&node.name)
                    .cloned()
                    .unwrap_or_else(|| {
                        let members: Vec<_> = node
                            .members
                            .iter()
                            .filter_map(|member| repository_affinities.get(member))
                            .collect();
                        if members.is_empty() {
                            return vec![0.0; profile_evidence::DIMENSIONS.len()];
                        }
                        (0..profile_evidence::DIMENSIONS.len())
                            .map(|dimension| {
                                members
                                    .iter()
                                    .map(|affinity| affinity[dimension])
                                    .sum::<f64>()
                                    / members.len() as f64
                            })
                            .collect()
                    });
                profile_evidence::NodeAffinity {
                    node: node.name.clone(),
                    dimensions,
                }
            })
            .collect();
        let profile_height = if input.profile_height > 0.0 {
            input.profile_height
        } else {
            height
        };
        let profile_min_y: f64 = 28.0;
        let profile_max_y = profile_height - 60.0;
        let profile_center = (profile_min_y + profile_max_y) / 2.0;
        let profile_spread = (profile_max_y - profile_min_y) / (2.0 * 0.96);
        let anchors = [
            [780.0, profile_center - profile_spread * 0.62],
            [615.0, profile_center - profile_spread * 0.96],
            [285.0, profile_center - profile_spread * 0.96],
            [120.0, profile_center - profile_spread * 0.62],
            [285.0, profile_center + profile_spread * 0.96],
            [615.0, profile_center + profile_spread * 0.96],
        ];
        let emphasized = profile_evidence::DIMENSIONS
            .iter()
            .position(|dimension| *dimension == input.profile_emphasis.as_str());
        for (index, repository) in analysis.nodes.iter().enumerate() {
            let weights: Vec<_> = repository
                .dimensions
                .iter()
                .enumerate()
                .map(|(dimension, weight)| {
                    if Some(dimension) == emphasized {
                        *weight * 1.5
                    } else {
                        *weight
                    }
                })
                .collect();
            let total: f64 = weights.iter().sum();
            if total <= f64::EPSILON {
                continue;
            }
            let x = weights
                .iter()
                .enumerate()
                .map(|(dimension, weight)| anchors[dimension][0] * weight)
                .sum::<f64>()
                / total;
            let y = weights
                .iter()
                .enumerate()
                .map(|(dimension, weight)| anchors[dimension][1] * weight)
                .sum::<f64>()
                / total;
            let jitter = (hash(&repository.node) % 17) as f64 - 8.0;
            positions[index] = [
                (x + jitter).clamp(32.0, 868.0),
                (y + jitter * 0.45).clamp(28.0, height - 60.0),
            ];
        }
        Some(analysis)
    } else {
        None
    };
    let mut candidates = Vec::new();
    for a in 0..n {
        for b in a + 1..n {
            let languages = if input.basis == "topics"
                || input.basis == "repositories"
                || input.basis == "membership"
            {
                vec![]
            } else {
                overlap(&input.repos[a].languages, &input.repos[b].languages)
            };
            let topics = if input.basis == "languages"
                || input.basis == "repositories"
                || input.basis == "membership"
            {
                vec![]
            } else {
                overlap(&input.repos[a].topics, &input.repos[b].topics)
            };
            let members = if input.basis == "membership" {
                let (left, right) = (&input.repos[a], &input.repos[b]);
                let repository = if left.kind == "repository"
                    && right.kind != "repository"
                    && right.members.contains(&left.name)
                {
                    Some(&left.name)
                } else if right.kind == "repository"
                    && left.kind != "repository"
                    && left.members.contains(&right.name)
                {
                    Some(&right.name)
                } else {
                    None
                };
                repository.into_iter().cloned().collect()
            } else if input.basis == "repositories" {
                overlap(&input.repos[a].members, &input.repos[b].members)
            } else {
                vec![]
            };
            if !languages.is_empty() || !topics.is_empty() || !members.is_empty() {
                candidates.push(Edge {
                    from: a,
                    to: b,
                    languages,
                    topics,
                    members,
                    primary: false,
                    distance: 0.0,
                });
            }
        }
    }
    if input.arrangement == "force" {
        let pairs: Vec<u32> = candidates
            .iter()
            .flat_map(|e| [e.from as u32, e.to as u32])
            .collect();
        let cache_key = format!("{}:{n}:{}:{}:{pairs:?}", input.account, input.compact, input.round);
        let cached = FORCE_LAYOUT.with(|cache| {
            cache
                .borrow()
                .as_ref()
                .filter(|(key, _)| key == &cache_key)
                .map(|(_, positions)| positions.clone())
        });
        if let Some(cached) = cached {
            positions = cached;
        } else {
            let mut graph = Graph::new(n as u32, &pairs, 800.0, 440.0).map_err(str::to_owned)?;
            for (i, node) in graph.nodes.iter_mut().enumerate() {
                node.x = positions[i][0] - 50.0;
                node.y = (positions[i][1] - center) / spread * 192.0 + 220.0;
            }
            // Settle once per data/layout change. CSS owns animation, no frame loop.
            for _ in 0..120 {
                graph.tick(1.0 / 60.0);
            }
            for (position, node) in positions.iter_mut().zip(graph.nodes.iter()) {
                *position = [node.x + 50.0, center + (node.y - 220.0) * spread / 220.0];
            }
            FORCE_LAYOUT.with(|cache| *cache.borrow_mut() = Some((cache_key, positions.clone())));
        }
    }
    for (position, repo) in positions.iter_mut().zip(&input.repos) {
        if let Some([x, y]) = repo.position {
            if !x.is_finite() || !y.is_finite() {
                return Err(format!("Invalid position for {}", repo.name));
            }
            *position = [x.clamp(32.0, 868.0), y.clamp(28.0, height - 60.0)];
        }
    }
    candidates.retain(|edge| !input.repos[edge.from].hidden && !input.repos[edge.to].hidden);
    for edge in &mut candidates {
        edge.distance = (positions[edge.from][0] - positions[edge.to][0]).powi(2)
            + (positions[edge.from][1] - positions[edge.to][1]).powi(2);
    }
    let mut selected = BTreeSet::new();
    if input.all || input.basis == "membership" {
        selected.extend(0..candidates.len());
    } else {
        for i in 0..n {
            let mut adjacent: Vec<_> = candidates
                .iter()
                .enumerate()
                .filter(|(_, e)| e.from == i || e.to == i)
                .collect();
            adjacent.sort_by(|(_, a), (_, b)| {
                let cross = |e: &Edge| input.repos[e.from].group != input.repos[e.to].group;
                weight(b)
                    .cmp(&weight(a))
                    .then(cross(b).cmp(&cross(a)))
                    .then(
                        a.distance
                            .partial_cmp(&b.distance)
                            .unwrap_or(Ordering::Equal),
                    )
                    .then(key(a).cmp(&key(b)))
            });
            selected.extend(adjacent.into_iter().take(4).map(|(i, _)| i));
        }
    }
    let total = candidates.len();
    let mut edges: Vec<_> = candidates
        .into_iter()
        .enumerate()
        .filter(|(i, _)| selected.contains(i))
        .map(|(_, e)| e)
        .collect();
    edges.sort_by(|a, b| {
        a.distance
            .total_cmp(&b.distance)
            .then(weight(b).cmp(&weight(a)))
            .then(key(a).cmp(&key(b)))
    });
    let mut parent: Vec<_> = (0..n).collect();
    for edge in &mut edges {
        let (a, b) = (root(&parent, edge.from), root(&parent, edge.to));
        if a != b {
            edge.primary = true;
            parent[a] = b;
        }
    }
    edges.sort_by_key(|edge| (edge.primary, key(edge)));
    Ok(Scene {
        positions,
        edges,
        total,
        profile,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(arrangement: &str) -> Input {
        Input {
            account: "octocat".into(),
            compact: true,
            arrangement: arrangement.into(),
            profile_emphasis: "automatic".into(),
            profile_height: 0.0,
            all: true,
            basis: "both".into(),
            ring_rotation: 0.0,
            ring_rotations: None,
            round: false,
            profile_repositories: vec![],
            repos: (0..16)
                .map(|i| Repository {
                    name: i.to_string(),
                    group: "Rust".into(),
                    languages: vec!["Rust".into()],
                    language_shares: BTreeMap::new(),
                    topics: vec![],
                    role: String::new(),
                    members: vec![],
                    kind: "repository".into(),
                    hidden: false,
                    position: None,
                })
                .collect(),
        }
    }
    #[test]
    fn round_orbits_use_equal_spreads_and_wide_stays_the_default() {
        for arrangement in ["rings", "orbital", "field"] {
            let wide = compute(Input { compact: false, ..input(arrangement) }).unwrap();
            let round = compute(Input { compact: false, round: true, ..input(arrangement) }).unwrap();
            let reach = |scene: &Scene| scene.positions.iter().fold((0.0f64, 0.0f64), |(x, y), p| (x.max((p[0] - 450.0).abs()), y.max((p[1] - 270.0).abs())));
            let (wx, wy) = reach(&wide);
            let (rx, ry) = reach(&round);
            // Wide orbits reach much further sideways than up and down…
            assert!(wx > wy * 1.5, "{arrangement}: wide {wx} x {wy}");
            // …round orbits stay inside the vertical spread both ways.
            assert!(rx <= 192.0 + 0.5 && ry <= 192.0 + 0.5, "{arrangement}: round {rx} x {ry}");
            assert_eq!(round.positions.iter().map(|p| p[1]).collect::<Vec<_>>(), wide.positions.iter().map(|p| p[1]).collect::<Vec<_>>(), "{arrangement}: round changes only horizontal positions");
        }
    }
    #[test]
    fn layouts_are_deterministic_bounded_and_preserve_manual_positions() {
        for arrangement in ["field", "orbital", "force", "rings", "profile"] {
            let a = compute(input(arrangement)).unwrap();
            let b = compute(input(arrangement)).unwrap();
            assert_eq!(a.positions, b.positions);
            assert_eq!(a.total, 120);
            assert_eq!(a.edges.iter().filter(|e| e.primary).count(), 15);
            assert!(a
                .positions
                .iter()
                .all(|p| (32.0..=868.0).contains(&p[0]) && (28.0..=220.0).contains(&p[1])));
            let mut manual = input(arrangement);
            manual.repos[0].position = Some([200.0, 100.0]);
            assert_eq!(compute(manual).unwrap().positions[0], [200.0, 100.0]);
        }
    }
    #[test]
    fn empty_single_and_disconnected_graphs_work() {
        for count in [0, 1, 2, 3] {
            let mut data = input("orbital");
            data.repos.truncate(count);
            for repo in &mut data.repos {
                repo.languages.clear();
            }
            let result = compute(data).unwrap();
            assert_eq!(result.positions.len(), count);
            assert!(result.edges.is_empty());
        }
    }

    #[test]
    fn profile_layout_is_deterministic_bounded_and_keeps_real_edges() {
        let mut data = input("profile");
        data.repos[0].languages = vec!["Rust".into()];
        data.repos[0].language_shares = BTreeMap::from([("Rust".into(), 100.0)]);
        data.repos[1].languages = vec!["HTML".into()];
        data.repos[1].language_shares = BTreeMap::from([("HTML".into(), 100.0)]);
        data.repos[2].topics = vec!["api".into()];
        let mut ordinary = data.clone();
        ordinary.arrangement = "field".into();
        let mut expected_edges: Vec<_> = compute(ordinary).unwrap().edges.iter().map(key).collect();
        let first = compute(data.clone()).unwrap();
        let second = compute(data).unwrap();
        assert_eq!(first.positions.len(), 16);
        let mut actual_edges: Vec<_> = first.edges.iter().map(key).collect();
        expected_edges.sort();
        actual_edges.sort();
        assert_eq!(actual_edges, expected_edges);
        assert_eq!(first.positions, second.positions);
        assert!(first
            .positions
            .iter()
            .flatten()
            .all(|coordinate| coordinate.is_finite()));
        assert!(first
            .positions
            .iter()
            .all(|point| (32.0..=868.0).contains(&point[0]) && (28.0..=220.0).contains(&point[1])));
        assert_ne!(first.positions[0], first.positions[1]);
        assert!(first.profile.is_some());
    }

    #[test]
    fn profile_regions_follow_single_and_mixed_repository_evidence() {
        let mut data = input("profile");
        data.repos.truncate(3);
        data.repos[0].languages = vec!["Rust".into()];
        data.repos[0].language_shares = BTreeMap::from([("Rust".into(), 100.0)]);
        data.repos[1].languages = vec!["HTML".into()];
        data.repos[1].language_shares = BTreeMap::from([("HTML".into(), 100.0)]);
        data.repos[2].languages = vec!["TypeScript".into()];
        data.repos[2].language_shares = BTreeMap::from([("TypeScript".into(), 100.0)]);
        data.repos[2].topics = vec!["frontend".into(), "api".into()];
        let scene = compute(data).unwrap();
        assert!(scene.positions[0][0] < scene.positions[1][0]);
        assert!(
            scene.positions[2][0] > scene.positions[0][0]
                && scene.positions[2][0] < scene.positions[1][0]
        );
        assert_eq!(scene.total, 0);
    }

    #[test]
    fn profile_arrangement_handles_the_supported_repository_limit() {
        let mut data = input("profile");
        let template = data.repos[0].clone();
        data.repos = (0..100)
            .map(|index| {
                let mut repository = template.clone();
                repository.name = format!("owner/project-{index}");
                repository
            })
            .collect();
        let result = compute(data).unwrap();
        assert_eq!(result.positions.len(), 100);
        assert!(result
            .positions
            .iter()
            .flatten()
            .all(|coordinate| coordinate.is_finite()));
    }

    #[test]
    fn profile_arrangement_stays_inside_static_export_heights() {
        for height in [180.0, 320.0, 480.0, 560.0] {
            let mut data = input("profile");
            data.profile_height = height;
            data.repos.truncate(6);
            for (index, repository) in data.repos.iter_mut().enumerate() {
                repository.languages = vec![match index % 3 {
                    0 => "Rust",
                    1 => "HTML",
                    _ => "SQL",
                }
                .into()];
                repository.language_shares =
                    BTreeMap::from([(repository.languages[0].clone(), 100.0)]);
            }
            let result = compute(data).unwrap();
            assert!(
                result
                    .positions
                    .iter()
                    .all(|point| point[1] >= 28.0 && point[1] <= height - 24.0),
                "height={height}, positions={:?}",
                result.positions
            );
        }
    }

    #[test]
    fn category_nodes_inherit_only_traceable_member_evidence() {
        let mut data = input("profile");
        data.repos = vec![Repository {
            name: "language:HTML".into(),
            group: "HTML".into(),
            languages: vec![],
            language_shares: BTreeMap::new(),
            topics: vec![],
            role: String::new(),
            members: vec!["owner/ui".into()],
            kind: "language".into(),
            hidden: false,
            position: None,
        }];
        data.profile_repositories = vec![profile_evidence::Repository {
            name: "owner/ui".into(),
            languages: BTreeMap::new(),
            language_names: vec!["HTML".into()],
            topics: vec![],
            role: "featured".into(),
        }];
        let scene = compute(data).unwrap();
        let profile = scene.profile.unwrap();
        assert_eq!(profile.dimensions[0].evidence[0].repository, "owner/ui");
        assert_eq!(profile.nodes[0].node, "language:HTML");
        assert!(profile.nodes[0].dimensions[0] > 0.0);
        assert!(scene.positions[0][0] > 600.0);
    }

    #[test]
    fn manual_emphasis_moves_layout_without_changing_profile_scores() {
        let mut automatic = input("profile");
        automatic.repos.truncate(1);
        automatic.repos[0].languages = vec!["HTML".into(), "Rust".into()];
        automatic.repos[0].language_shares =
            BTreeMap::from([("HTML".into(), 50.0), ("Rust".into(), 50.0)]);
        automatic.repos[0].topics = vec!["frontend".into()];
        let mut systems = automatic.clone();
        systems.profile_emphasis = "systems".into();
        let automatic = compute(automatic).unwrap();
        let systems = compute(systems).unwrap();
        assert!(systems.positions[0][0] < automatic.positions[0][0]);
        assert_eq!(
            systems
                .profile
                .unwrap()
                .dimensions
                .iter()
                .map(|value| value.score)
                .collect::<Vec<_>>(),
            automatic
                .profile
                .unwrap()
                .dimensions
                .iter()
                .map(|value| value.score)
                .collect::<Vec<_>>()
        );
    }
}
