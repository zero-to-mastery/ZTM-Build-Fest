//! Bounded, deterministic evidence navigation over Semantic Graph v1.
//!
//! The navigator answers "what is this project connected to, and why?" using
//! only factual edges already present in the graph. It never infers expertise,
//! dependencies, collaboration, or chronology, never ranks developers, and never
//! modifies the graph. The index is built once per graph and reused for every
//! interaction; record order in the input cannot change any result.
//!
//! Binary size: inputs are read through the shared `serde_json::Value` parser,
//! output is written by a small JSON writer, sets are bitmasks, lookups use sorted
//! vectors, and all sorting goes through one index merge sort. Each generic
//! `sort_by`, `BTreeMap`, or `Serialize` instantiation costs WASM bytes, and this
//! module ships inline in every standalone interactive export (1 MiB runtime budget).
use std::cmp::Ordering;

pub const EVIDENCE_NAVIGATION_VERSION: u32 = 1;
const MAX_BYTES: usize = 4_000_000;
const MAX_NODES: usize = 4096;
const MAX_EDGES: usize = 16_384;
const MAX_ID_BYTES: usize = 4096;
const MAX_LABEL_BYTES: usize = 4096;
const MAX_KIND_BYTES: usize = 64;
const MAX_PROVENANCE: usize = 16;
const MAX_REQUEST_BYTES: usize = 8192;
const MAX_DEPTH: u8 = 2;
/// Connections returned per degree. Larger neighborhoods are truncated with a diagnostic.
const MAX_CONNECTIONS: usize = 256;
/// Evidence references retained per relationship type for one connection.
const MAX_EVIDENCE_PER_TYPE: usize = 32;
/// Intermediate projects listed for one second-degree project.
const MAX_VIA: usize = 16;
/// Upper bound on hub-member visits for one query, including second-degree expansion.
const MAX_TRAVERSAL_WORK: usize = 262_144;
const MAX_DIAGNOSTICS: usize = 64;
const MAX_DIAGNOSTIC_IDS: usize = 16;
const NONE: u32 = u32::MAX;

/// The closed set of relationships navigation may explain. These match the
/// Story Composition vocabulary so focus and static stories agree on meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum RelationshipType {
    ExplicitRelationship,
    AuthoredFamily,
    SharedLanguage,
    SharedTopic,
}
const RELATIONSHIP_TYPES: [RelationshipType; 4] = [
    RelationshipType::ExplicitRelationship,
    RelationshipType::AuthoredFamily,
    RelationshipType::SharedLanguage,
    RelationshipType::SharedTopic,
];

impl RelationshipType {
    fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitRelationship => "explicit-relationship",
            Self::AuthoredFamily => "authored-family",
            Self::SharedLanguage => "shared-language",
            Self::SharedTopic => "shared-topic",
        }
    }
    fn bit(self) -> u8 {
        1 << self as u8
    }
}

/// Semantic Graph v1 provenance categories, in canonical (alphabetical) order.
const PROVENANCE: [(&str, u8); 3] = [("derived", 1), ("source", 2), ("user", 4)];

/// Minimal JSON writer for navigation output.
struct Json(String);
impl Json {
    fn raw(&mut self, text: &str) -> &mut Self {
        self.0.push_str(text);
        self
    }
    fn string(&mut self, text: &str) -> &mut Self {
        self.0.push('"');
        for character in text.chars() {
            match character {
                '"' => self.0.push_str("\\\""),
                '\\' => self.0.push_str("\\\\"),
                c if (c as u32) < 0x20 => {
                    const HEX: &[u8; 16] = b"0123456789abcdef";
                    self.0.push_str("\\u00");
                    self.0.push(HEX[(c as usize) >> 4] as char);
                    self.0.push(HEX[(c as usize) & 15] as char);
                }
                c => self.0.push(c),
            }
        }
        self.0.push('"');
        self
    }
    fn number(&mut self, value: usize) -> &mut Self {
        self.0.push_str(&value.to_string());
        self
    }
    fn strings<'a>(&mut self, items: impl IntoIterator<Item = &'a str>) -> &mut Self {
        self.0.push('[');
        for (index, item) in items.into_iter().enumerate() {
            if index > 0 {
                self.0.push(',');
            }
            self.string(item);
        }
        self.0.push(']');
        self
    }
    fn types(&mut self, mask: u8) -> &mut Self {
        self.strings(RELATIONSHIP_TYPES.iter().filter(|kind| mask & kind.bit() != 0).map(|kind| kind.as_str()))
    }
    fn provenance(&mut self, mask: u8) -> &mut Self {
        self.strings(PROVENANCE.iter().filter(|(_, bit)| mask & bit != 0).map(|(name, _)| *name))
    }
    fn list<T>(&mut self, items: &[T], write: impl Fn(&mut Self, &T)) -> &mut Self {
        self.0.push('[');
        for (index, item) in items.iter().enumerate() {
            if index > 0 {
                self.0.push(',');
            }
            write(self, item);
        }
        self.0.push(']');
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ProjectIx(u32);
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct HubIx(u32);

/// Stable bottom-up merge sort of `0..len`. One non-generic body serves every sort.
fn stable_order(len: usize, compare: &dyn Fn(usize, usize) -> Ordering) -> Vec<usize> {
    let mut order: Vec<usize> = (0..len).collect();
    let mut buffer = order.clone();
    let mut width = 1;
    while width < len {
        let mut start = 0;
        while start < len {
            let middle = (start + width).min(len);
            let end = (start + 2 * width).min(len);
            let (mut left, mut right, mut out) = (start, middle, start);
            while left < middle && right < end {
                if compare(order[right], order[left]) == Ordering::Less {
                    buffer[out] = order[right];
                    right += 1;
                } else {
                    buffer[out] = order[left];
                    left += 1;
                }
                out += 1;
            }
            buffer[out..out + middle - left].copy_from_slice(&order[left..middle]);
            out += middle - left;
            buffer[out..out + end - right].copy_from_slice(&order[right..end]);
            start = end;
        }
        std::mem::swap(&mut order, &mut buffer);
        width *= 2;
    }
    order
}

fn sorted<T>(items: Vec<T>, compare: &dyn Fn(&T, &T) -> Ordering) -> Vec<T> {
    let order = stable_order(items.len(), &|a, b| compare(&items[a], &items[b]));
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    order.into_iter().filter_map(|index| slots[index].take()).collect()
}

fn sorted_unique_strings(items: Vec<String>) -> Vec<String> {
    let mut items = sorted(items, &|a, b| a.cmp(b));
    items.dedup();
    items
}

struct RawNode {
    id: String,
    kind: String,
    label: String,
    group_kind: Option<String>,
    provenance: u8,
}
struct RawEdge {
    id: String,
    kind: String,
    from: String,
    to: String,
    provenance: u8,
}
struct RawGraph {
    version: Option<u64>,
    nodes: Vec<RawNode>,
    edges: Vec<RawEdge>,
}

type Object = serde_json::Map<String, serde_json::Value>;
fn object<'a>(value: &'a serde_json::Value, what: &str) -> Result<&'a Object, String> {
    value.as_object().ok_or_else(|| format!("Evidence Navigation {what} must be an object"))
}
fn text(value: &Object, key: &str, what: &str) -> Result<String, String> {
    match value.get(key) {
        Some(serde_json::Value::String(text)) => Ok(text.clone()),
        _ => Err(format!("Evidence Navigation {what} field {key} must be text")),
    }
}
fn optional_text(value: &Object, key: &str, what: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(_) => text(value, key, what).map(Some),
    }
}
fn list<'a>(value: &'a Object, key: &str, what: &str) -> Result<&'a [serde_json::Value], String> {
    match value.get(key) {
        None => Ok(&[]),
        Some(serde_json::Value::Array(items)) => Ok(items),
        Some(_) => Err(format!("Evidence Navigation {what} field {key} must be a list")),
    }
}
fn provenance(value: &Object, what: &str) -> Result<u8, String> {
    let items = list(value, "provenance", what)?;
    if items.len() > MAX_PROVENANCE {
        return Err("Evidence Navigation provenance exceeds bounds".into());
    }
    let mut mask = 0;
    for item in items {
        let category = optional_text(object(item, "provenance")?, "category", "provenance")?;
        mask |= PROVENANCE.iter().find(|(name, _)| Some(*name) == category.as_deref()).map_or(0, |(_, bit)| *bit);
    }
    Ok(mask)
}
fn raw_graph(value: &serde_json::Value) -> Result<RawGraph, String> {
    let graph = object(value, "graph")?;
    let version = match graph.get("version") {
        None | Some(serde_json::Value::Null) => None,
        Some(version) => Some(version.as_u64().ok_or("Evidence Navigation graph version must be an integer")?),
    };
    if graph.get("nodes").is_none() {
        return Err("Evidence Navigation graph requires nodes".into());
    }
    let (nodes, edges) = (list(graph, "nodes", "graph")?, list(graph, "edges", "graph")?);
    if nodes.len() > MAX_NODES || edges.len() > MAX_EDGES {
        return Err("Evidence Navigation graph exceeds collection bounds".into());
    }
    let nodes = nodes
        .iter()
        .map(|node| {
            let node = object(node, "node")?;
            let group_kind = match node.get("properties") {
                Some(serde_json::Value::Object(properties)) => optional_text(properties, "groupKind", "node properties")?,
                _ => None,
            };
            Ok(RawNode {
                id: text(node, "id", "node")?,
                kind: text(node, "kind", "node")?,
                label: optional_text(node, "label", "node")?.unwrap_or_default(),
                group_kind,
                provenance: provenance(node, "node")?,
            })
        })
        .collect::<Result<_, String>>()?;
    let edges = edges
        .iter()
        .map(|edge| {
            let edge = object(edge, "edge")?;
            Ok(RawEdge {
                id: text(edge, "id", "edge")?,
                kind: text(edge, "kind", "edge")?,
                from: text(edge, "from", "edge")?,
                to: text(edge, "to", "edge")?,
                provenance: provenance(edge, "edge")?,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(RawGraph { version, nodes, edges })
}
/// Reads `{ projectId, depth? }`; any other field is rejected so callers cannot
/// pass unsupported options into navigation.
fn raw_request(value: &Object, allowed: &[&str]) -> Result<(String, u8), String> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("Invalid Evidence Navigation request: unknown field {key}"));
    }
    let project_id = text(value, "projectId", "request")?;
    let depth = match value.get("depth") {
        None | Some(serde_json::Value::Null) => 1,
        Some(depth) => depth
            .as_u64()
            .filter(|depth| *depth <= u64::from(u8::MAX))
            .ok_or("Evidence Navigation depth must be 1 or 2")? as u8,
    };
    Ok((project_id, depth))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && !value.chars().any(char::is_control)
}
fn valid_label(value: &str) -> bool {
    value.len() <= MAX_LABEL_BYTES && !value.chars().any(char::is_control)
}

struct Project {
    id: String,
    label: String,
}
/// A shared fact several projects point at: a language, topic, or authored family.
struct Hub {
    id: String,
    label: String,
    kind: RelationshipType,
    /// Members sorted by project, each with the first (by ID) edge that attaches it.
    members: Vec<(ProjectIx, String)>,
    provenance: u8,
}
struct Explicit {
    other: ProjectIx,
    edge_id: String,
    provenance: u8,
}

/// Retained topology for one validated graph. Projects and hubs are sorted by
/// canonical ID, so index order is ID order.
pub struct NavigationIndex {
    projects: Vec<Project>,
    hubs: Vec<Hub>,
    /// Sorted IDs of every non-project node, to distinguish "not a project" from "missing".
    non_projects: Vec<String>,
    /// Hubs each project belongs to, sorted.
    project_hubs: Vec<Vec<HubIx>>,
    /// Explicit relationships each project participates in, sorted by (other, edge).
    explicit: Vec<Vec<Explicit>>,
    /// Derived groups each project belongs to; reported, never used as connections.
    derived_groups: Vec<Vec<String>>,
    skipped_edges: Vec<String>,
}

impl NavigationIndex {
    pub fn from_json(json: &str) -> Result<Self, String> {
        if json.len() > MAX_BYTES {
            return Err("Evidence Navigation graph exceeds 4 MB".into());
        }
        let graph: serde_json::Value = serde_json::from_str(json)
            .map_err(|error| format!("Invalid Evidence Navigation graph: {error}"))?;
        Self::build(raw_graph(&graph)?)
    }

    fn build(graph: RawGraph) -> Result<Self, String> {
        if graph.version.is_some_and(|version| version != 1) {
            return Err("Evidence Navigation supports Semantic Graph v1 only".into());
        }
        if graph.nodes.iter().any(|node| !valid_id(&node.id) || node.kind.len() > MAX_KIND_BYTES || !valid_label(&node.label))
            || graph.edges.iter().any(|edge| {
                !valid_id(&edge.id) || !valid_id(&edge.from) || !valid_id(&edge.to) || edge.kind.len() > MAX_KIND_BYTES
            })
        {
            return Err("Evidence Navigation graph contains invalid identifiers or labels".into());
        }
        let nodes = sorted(graph.nodes, &|a, b| a.id.cmp(&b.id));
        let edges = sorted(graph.edges, &|a, b| a.id.cmp(&b.id));
        if nodes.windows(2).any(|pair| pair[0].id == pair[1].id) || edges.windows(2).any(|pair| pair[0].id == pair[1].id) {
            return Err("Evidence Navigation graph contains duplicate identifiers".into());
        }

        let mut projects = Vec::new();
        let mut hubs = Vec::new();
        let mut non_projects = Vec::new();
        let mut derived = Vec::new();
        for node in nodes {
            let kind = match node.kind.as_str() {
                "project" => {
                    let label = if node.label.is_empty() { node.id.clone() } else { node.label };
                    projects.push(Project { id: node.id, label });
                    continue;
                }
                "language" => RelationshipType::SharedLanguage,
                "topic" => RelationshipType::SharedTopic,
                // Only user-authored project families relate projects; derived owner
                // groups describe a namespace, not a relationship between projects.
                "semantic-group" if node.group_kind.as_deref() == Some("project-family") && node.provenance & 4 != 0 => {
                    RelationshipType::AuthoredFamily
                }
                "semantic-group" => {
                    derived.push(node.id.clone());
                    non_projects.push(node.id);
                    continue;
                }
                _ => {
                    non_projects.push(node.id);
                    continue;
                }
            };
            non_projects.push(node.id.clone());
            hubs.push(Hub { id: node.id, label: node.label, kind, members: Vec::new(), provenance: 0 });
        }
        let find_project = |id: &str| projects.binary_search_by(|p: &Project| p.id.as_str().cmp(id)).ok().map(|i| ProjectIx(i as u32));
        let find_hub = |id: &str| hubs.binary_search_by(|h: &Hub| h.id.as_str().cmp(id)).ok().map(|i| HubIx(i as u32));

        let mut project_hubs: Vec<Vec<HubIx>> = (0..projects.len()).map(|_| Vec::new()).collect();
        let mut explicit: Vec<Vec<Explicit>> = (0..projects.len()).map(|_| Vec::new()).collect();
        let mut derived_groups: Vec<Vec<String>> = (0..projects.len()).map(|_| Vec::new()).collect();
        let mut memberships = Vec::new();
        let mut skipped_edges = Vec::new();
        for edge in edges {
            let expected = match edge.kind.as_str() {
                "uses-language" => Some(RelationshipType::SharedLanguage),
                "has-topic" => Some(RelationshipType::SharedTopic),
                "member-of" => Some(RelationshipType::AuthoredFamily),
                "project-relationship" => None,
                // Structural and ownership edges are not project-to-project evidence.
                _ => continue,
            };
            let Some(from) = find_project(&edge.from) else {
                skipped_edges.push(edge.id);
                continue;
            };
            let Some(kind) = expected else {
                match find_project(&edge.to) {
                    Some(to) if to != from => {
                        explicit[from.0 as usize].push(Explicit { other: to, edge_id: edge.id.clone(), provenance: edge.provenance });
                        explicit[to.0 as usize].push(Explicit { other: from, edge_id: edge.id, provenance: edge.provenance });
                    }
                    _ => skipped_edges.push(edge.id),
                }
                continue;
            };
            if kind == RelationshipType::AuthoredFamily && derived.binary_search(&edge.to).is_ok() {
                derived_groups[from.0 as usize].push(edge.to);
                continue;
            }
            match find_hub(&edge.to) {
                Some(hub) if hubs[hub.0 as usize].kind == kind => memberships.push((hub, from, edge.id, edge.provenance)),
                _ => skipped_edges.push(edge.id),
            }
        }
        // Edges arrive in ID order and the sort is stable, so the membership kept for a
        // repeated (hub, project) pair is the one with the smallest edge ID. Hub members and
        // each project's hub list come out sorted.
        let memberships = sorted(memberships, &|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
        for (hub, project, edge_id, provenance) in memberships {
            let target = &mut hubs[hub.0 as usize];
            target.provenance |= provenance;
            if target.members.last().is_none_or(|(member, _)| *member != project) {
                target.members.push((project, edge_id));
                project_hubs[project.0 as usize].push(hub);
            }
        }
        for list in &mut explicit {
            *list = sorted(std::mem::take(list), &|a, b| (a.other, &a.edge_id).cmp(&(b.other, &b.edge_id)));
        }
        for list in &mut derived_groups {
            *list = sorted_unique_strings(std::mem::take(list));
        }
        Ok(Self { projects, hubs, non_projects, project_hubs, explicit, derived_groups, skipped_edges })
    }

    pub fn project_count(&self) -> usize {
        self.projects.len()
    }

    fn find(&self, id: &str) -> Option<ProjectIx> {
        self.projects.binary_search_by(|p| p.id.as_str().cmp(id)).ok().map(|i| ProjectIx(i as u32))
    }

    fn id(&self, project: ProjectIx) -> &str {
        &self.projects[project.0 as usize].id
    }

    pub fn navigate_json(&self, request: &str) -> Result<String, String> {
        if request.len() > MAX_REQUEST_BYTES {
            return Err("Evidence Navigation request exceeds 8 KiB".into());
        }
        let request: serde_json::Value = serde_json::from_str(request)
            .map_err(|error| format!("Invalid Evidence Navigation request: {error}"))?;
        let (project_id, depth) = raw_request(object(&request, "request")?, &["projectId", "depth"])?;
        Ok(self.navigate(&project_id, depth)?.to_json())
    }

    pub fn navigate(&self, project_id: &str, depth: u8) -> Result<Navigation<'_>, String> {
        if !(1..=MAX_DEPTH).contains(&depth) {
            return Err("Evidence Navigation depth must be 1 or 2".into());
        }
        if !valid_id(project_id) {
            return Err("Evidence Navigation project ID is invalid".into());
        }
        let mut diagnostics = Diagnostics::default();
        if !self.skipped_edges.is_empty() {
            diagnostics.push("edges-without-supported-endpoints", "info", self.skipped_edges.clone());
        }
        let Some(selected) = self.find(project_id) else {
            let code = if self.non_projects.binary_search_by(|id| id.as_str().cmp(project_id)).is_ok() {
                "not-a-project"
            } else {
                "unknown-project"
            };
            diagnostics.push(code, "warning", vec![project_id.to_owned()]);
            return Ok(Navigation {
                version: EVIDENCE_NAVIGATION_VERSION,
                status: "unavailable",
                project: None,
                depth,
                connections: Vec::new(),
                second_degree: Vec::new(),
                truncated: false,
                diagnostics: diagnostics.finish(),
            });
        };
        let selected_id = self.id(selected);

        let mut work = 0usize;
        let first = self.direct(selected, &mut work);
        let mut truncated = false;
        if first.len() > MAX_CONNECTIONS {
            truncated = true;
            diagnostics.push("connections-truncated", "info", vec![selected_id.to_owned()]);
        }
        if !self.derived_groups[selected.0 as usize].is_empty() {
            diagnostics.push("derived-groups-not-relationships", "info", self.derived_groups[selected.0 as usize].clone());
        }
        if first.is_empty() {
            diagnostics.push("no-supported-relationships", "info", vec![selected_id.to_owned()]);
        }

        let mut second_degree = Vec::new();
        if depth == 2 {
            let mut first_mask = vec![0u8; self.projects.len()];
            for connection in &first {
                first_mask[connection.project.0 as usize] = connection.mask;
            }
            // Dense per-target state; vias are visited in ID order, so the first via
            // recorded for a target is its canonical (lexicographically first) path.
            let mut first_via = vec![NONE; self.projects.len()];
            let mut last_via = vec![NONE; self.projects.len()];
            let mut hop_mask = vec![0u8; self.projects.len()];
            let mut via_count = vec![0u32; self.projects.len()];
            let mut vias: Vec<Vec<ProjectIx>> = (0..self.projects.len()).map(|_| Vec::new()).collect();
            let mut reached = Vec::new();
            let mut neighbors = Vec::new();
            for connection in &first {
                if work > MAX_TRAVERSAL_WORK {
                    break;
                }
                let via = connection.project;
                neighbors.clear();
                self.neighbor_masks(via, &mut work, &mut neighbors);
                for &(target, mask) in &neighbors {
                    let t = target.0 as usize;
                    if target == selected || first_mask[t] != 0 {
                        continue;
                    }
                    if first_via[t] == NONE {
                        first_via[t] = via.0;
                        reached.push(target);
                    }
                    if first_via[t] == via.0 {
                        hop_mask[t] |= mask;
                    }
                    if last_via[t] != via.0 {
                        last_via[t] = via.0;
                        via_count[t] += 1;
                        if vias[t].len() < MAX_VIA {
                            vias[t].push(via);
                        }
                    }
                }
            }
            if work > MAX_TRAVERSAL_WORK {
                truncated = true;
                diagnostics.push("traversal-budget-exhausted", "warning", vec![selected_id.to_owned()]);
            }
            if reached.len() > MAX_CONNECTIONS {
                truncated = true;
                diagnostics.push("second-degree-truncated", "info", vec![selected_id.to_owned()]);
            }
            // Projects reachable through more direct connections first, then canonical ID.
            let reached = sorted(reached, &|a, b| via_count[b.0 as usize].cmp(&via_count[a.0 as usize]).then(a.cmp(b)));
            for target in reached.into_iter().take(MAX_CONNECTIONS) {
                let t = target.0 as usize;
                let path_via = ProjectIx(first_via[t]);
                second_degree.push(Reached {
                    project_id: self.id(target),
                    label: &self.projects[t].label,
                    degree: 2,
                    via: vias[t].iter().map(|via| self.id(*via)).collect(),
                    via_count: via_count[t] as usize,
                    path: [selected_id, self.id(path_via), self.id(target)],
                    hops: [
                        Hop { from: selected_id, to: self.id(path_via), types: first_mask[path_via.0 as usize] },
                        Hop { from: self.id(path_via), to: self.id(target), types: hop_mask[t] },
                    ],
                });
            }
        }

        // Stable presentation order: richer evidence first, then canonical project ID.
        // This orders explanations; it is not a score of the project or developer.
        let first = sorted(first, &|a, b| b.mask.count_ones().cmp(&a.mask.count_ones()).then(a.project.cmp(&b.project)));
        let connections = first.into_iter().take(MAX_CONNECTIONS).map(|group| self.connection(selected, group)).collect();
        let project = &self.projects[selected.0 as usize];
        Ok(Navigation {
            version: EVIDENCE_NAVIGATION_VERSION,
            status: "ok",
            project: Some(ProjectRef { id: &project.id, label: &project.label }),
            depth,
            connections,
            second_degree,
            truncated,
            diagnostics: diagnostics.finish(),
        })
    }

    /// Direct neighbors grouped by project, with evidence for each relationship type.
    fn direct(&self, selected: ProjectIx, work: &mut usize) -> Vec<Direct<'_>> {
        let mut items: Vec<(ProjectIx, RelationshipType, Evidence<'_>)> = Vec::new();
        for item in &self.explicit[selected.0 as usize] {
            *work += 1;
            let evidence = Evidence { node_id: None, label: None, edge_ids: vec![&item.edge_id], provenance: item.provenance };
            items.push((item.other, RelationshipType::ExplicitRelationship, evidence));
        }
        for hub in &self.project_hubs[selected.0 as usize] {
            let hub = &self.hubs[hub.0 as usize];
            let Some((_, own_edge)) = hub.members.iter().find(|(member, _)| *member == selected) else {
                continue;
            };
            // One expansion visits each membership at most once (<= MAX_EDGES); the
            // caller checks the shared budget between expansions.
            for (member, edge) in &hub.members {
                *work += 1;
                if *member == selected {
                    continue;
                }
                let edge_ids = if own_edge <= edge { vec![own_edge.as_str(), edge.as_str()] } else { vec![edge.as_str(), own_edge.as_str()] };
                let evidence = Evidence { node_id: Some(&hub.id), label: Some(&hub.label), edge_ids, provenance: hub.provenance };
                items.push((*member, hub.kind, evidence));
            }
        }
        let items = sorted(items, &|a, b| {
            (a.0, a.1, a.2.node_id, &a.2.edge_ids).cmp(&(b.0, b.1, b.2.node_id, &b.2.edge_ids))
        });
        let mut grouped: Vec<Direct<'_>> = Vec::new();
        for (project, kind, evidence) in items {
            if grouped.last().is_none_or(|group| group.project != project) {
                grouped.push(Direct { project, mask: 0, relationships: Vec::new() });
            }
            let Some(group) = grouped.last_mut() else { continue };
            if group.mask & kind.bit() == 0 {
                group.mask |= kind.bit();
                group.relationships.push(Relationship { kind: kind.as_str(), evidence_count: 0, evidence: Vec::new() });
            }
            if let Some(relationship) = group.relationships.last_mut() {
                relationship.evidence_count += 1;
                if relationship.evidence.len() < MAX_EVIDENCE_PER_TYPE {
                    relationship.evidence.push(evidence);
                }
            }
        }
        grouped
    }

    /// Lightweight neighbor scan for second-degree traversal: types only, no evidence.
    fn neighbor_masks(&self, project: ProjectIx, work: &mut usize, out: &mut Vec<(ProjectIx, u8)>) {
        for item in &self.explicit[project.0 as usize] {
            *work += 1;
            out.push((item.other, RelationshipType::ExplicitRelationship.bit()));
        }
        for hub in &self.project_hubs[project.0 as usize] {
            let hub = &self.hubs[hub.0 as usize];
            for (member, _) in &hub.members {
                *work += 1;
                if *member != project {
                    out.push((*member, hub.kind.bit()));
                }
            }
        }
    }

    fn connection<'a>(&'a self, selected: ProjectIx, group: Direct<'a>) -> Connection<'a> {
        let (from, to) = (self.id(selected), self.id(group.project));
        let (a, b) = if from <= to { (from, to) } else { (to, from) };
        Connection {
            id: format!("nav:{}:{}{}:{}", a.len(), a, b.len(), b),
            project_id: to,
            label: &self.projects[group.project.0 as usize].label,
            degree: 1,
            path: [from, to],
            types: group.mask,
            relationships: group.relationships,
        }
    }
}

struct Direct<'a> {
    project: ProjectIx,
    mask: u8,
    relationships: Vec<Relationship<'a>>,
}

/// Navigation result. `to_json` field names are the stable contract consumed by the runtime.
pub struct Navigation<'a> {
    version: u32,
    status: &'static str,
    project: Option<ProjectRef<'a>>,
    depth: u8,
    connections: Vec<Connection<'a>>,
    second_degree: Vec<Reached<'a>>,
    truncated: bool,
    diagnostics: Vec<Diagnostic>,
}
struct ProjectRef<'a> {
    id: &'a str,
    label: &'a str,
}
struct Connection<'a> {
    id: String,
    project_id: &'a str,
    label: &'a str,
    degree: u8,
    path: [&'a str; 2],
    types: u8,
    relationships: Vec<Relationship<'a>>,
}
struct Relationship<'a> {
    kind: &'static str,
    evidence_count: usize,
    evidence: Vec<Evidence<'a>>,
}
struct Evidence<'a> {
    node_id: Option<&'a str>,
    label: Option<&'a str>,
    edge_ids: Vec<&'a str>,
    provenance: u8,
}
struct Reached<'a> {
    project_id: &'a str,
    label: &'a str,
    degree: u8,
    via: Vec<&'a str>,
    via_count: usize,
    path: [&'a str; 3],
    hops: [Hop<'a>; 2],
}
struct Hop<'a> {
    from: &'a str,
    to: &'a str,
    types: u8,
}
struct Diagnostic {
    code: &'static str,
    severity: &'static str,
    ids: Vec<String>,
    count: usize,
}

impl Navigation<'_> {
    pub fn to_json(&self) -> String {
        let mut out = Json(String::with_capacity(256 + self.connections.len() * 384 + self.second_degree.len() * 256));
        out.raw("{\"version\":").number(self.version as usize).raw(",\"status\":").string(self.status).raw(",\"project\":");
        match &self.project {
            Some(project) => {
                out.raw("{\"id\":").string(project.id).raw(",\"label\":").string(project.label).raw("}");
            }
            None => {
                out.raw("null");
            }
        }
        out.raw(",\"depth\":").number(self.depth as usize).raw(",\"connections\":");
        out.list(&self.connections, |out, item| {
            out.raw("{\"id\":").string(&item.id).raw(",\"projectId\":").string(item.project_id);
            out.raw(",\"label\":").string(item.label).raw(",\"degree\":").number(item.degree as usize);
            out.raw(",\"path\":").strings(item.path).raw(",\"relationshipTypes\":").types(item.types);
            out.raw(",\"relationships\":").list(&item.relationships, |out, relationship| {
                out.raw("{\"type\":").string(relationship.kind).raw(",\"evidenceCount\":").number(relationship.evidence_count);
                out.raw(",\"evidence\":").list(&relationship.evidence, |out, evidence| {
                    out.raw("{");
                    if let Some(node) = evidence.node_id {
                        out.raw("\"nodeId\":").string(node).raw(",");
                    }
                    if let Some(label) = evidence.label {
                        out.raw("\"label\":").string(label).raw(",");
                    }
                    out.raw("\"edgeIds\":").strings(evidence.edge_ids.iter().copied());
                    out.raw(",\"provenance\":").provenance(evidence.provenance).raw("}");
                });
                out.raw("}");
            });
            out.raw("}");
        });
        out.raw(",\"secondDegree\":").list(&self.second_degree, |out, item| {
            out.raw("{\"projectId\":").string(item.project_id).raw(",\"label\":").string(item.label);
            out.raw(",\"degree\":").number(item.degree as usize).raw(",\"via\":").strings(item.via.iter().copied());
            out.raw(",\"viaCount\":").number(item.via_count).raw(",\"path\":").strings(item.path);
            out.raw(",\"hops\":").list(&item.hops, |out, hop| {
                out.raw("{\"from\":").string(hop.from).raw(",\"to\":").string(hop.to);
                out.raw(",\"relationshipTypes\":").types(hop.types).raw("}");
            });
            out.raw("}");
        });
        out.raw(",\"truncated\":").raw(if self.truncated { "true" } else { "false" });
        out.raw(",\"diagnostics\":").list(&self.diagnostics, |out, item| {
            out.raw("{\"code\":").string(item.code).raw(",\"severity\":").string(item.severity);
            out.raw(",\"ids\":").strings(item.ids.iter().map(String::as_str)).raw(",\"count\":").number(item.count).raw("}");
        });
        out.raw("}");
        out.0
    }
}

#[derive(Default)]
struct Diagnostics(Vec<Diagnostic>);
impl Diagnostics {
    fn push(&mut self, code: &'static str, severity: &'static str, ids: Vec<String>) {
        let mut ids = sorted_unique_strings(ids);
        let count = ids.len();
        ids.truncate(MAX_DIAGNOSTIC_IDS);
        self.0.push(Diagnostic { code, severity, ids, count });
    }
    fn finish(self) -> Vec<Diagnostic> {
        let mut diagnostics = sorted(self.0, &|a, b| (a.code, a.severity, &a.ids).cmp(&(b.code, b.severity, &b.ids)));
        diagnostics.truncate(MAX_DIAGNOSTICS);
        diagnostics
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const FIXTURE: &str = include_str!("../../../test/fixtures/evidence-navigation/graph.json");
    const EXPECTED: &str = include_str!("../../../test/fixtures/evidence-navigation/expected.json");

    fn navigate(graph: &str, project: &str, depth: u8) -> serde_json::Value {
        let index = NavigationIndex::from_json(graph).unwrap();
        serde_json::from_str(&index.navigate(project, depth).unwrap().to_json()).unwrap()
    }

    fn codes(result: &serde_json::Value) -> Vec<&str> {
        result["diagnostics"].as_array().unwrap().iter().map(|d| d["code"].as_str().unwrap()).collect()
    }

    #[test]
    fn fixture_matches_the_shared_native_and_wasm_expectation() {
        // test/evidence-navigation.test.mjs checks the WASM build against the same file.
        let expected: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
        assert!(expected.as_array().unwrap().len() >= 5);
        for case in expected.as_array().unwrap() {
            let actual = navigate(FIXTURE, case["projectId"].as_str().unwrap(), case["depth"].as_u64().unwrap() as u8);
            assert_eq!(actual, case["result"], "case {}", case["projectId"]);
        }
    }

    #[test]
    fn direct_connections_carry_evidence_for_every_relationship_type() {
        let result = navigate(FIXTURE, "octo/compiler", 1);
        assert_eq!(result["status"], "ok");
        for connection in result["connections"].as_array().unwrap() {
            let types: Vec<_> = connection["relationships"].as_array().unwrap().iter().map(|r| r["type"].clone()).collect();
            assert_eq!(serde_json::Value::from(types), connection["relationshipTypes"]);
            for relationship in connection["relationships"].as_array().unwrap() {
                assert!(!relationship["evidence"].as_array().unwrap().is_empty());
                for item in relationship["evidence"].as_array().unwrap() {
                    assert!(!item["edgeIds"].as_array().unwrap().is_empty());
                    assert!(!item["provenance"].as_array().unwrap().is_empty());
                }
            }
        }
    }

    #[test]
    fn record_order_does_not_change_results() {
        let mut graph: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        graph["nodes"].as_array_mut().unwrap().reverse();
        graph["edges"].as_array_mut().unwrap().reverse();
        let reversed = graph.to_string();
        for project in ["octo/compiler", "octo/site", "octo/loner", "octo/docs"] {
            for depth in [1, 2] {
                assert_eq!(navigate(FIXTURE, project, depth), navigate(&reversed, project, depth));
            }
        }
    }

    #[test]
    fn missing_and_non_project_ids_return_explicit_diagnostics() {
        let unknown = navigate(FIXTURE, "octo/removed", 1);
        assert_eq!(unknown["status"], "unavailable");
        assert_eq!(unknown["project"], serde_json::Value::Null);
        assert_eq!(codes(&unknown), ["unknown-project"]);
        assert_eq!(codes(&navigate(FIXTURE, "language:rust", 1)), ["not-a-project"]);
        assert_eq!(codes(&navigate(FIXTURE, "group:user:toolchain", 1)), ["not-a-project"]);
        assert!(codes(&navigate(FIXTURE, "octo/loner", 1)).contains(&"no-supported-relationships"));
    }

    #[test]
    fn derived_groups_are_reported_but_never_become_connections() {
        let result = navigate(FIXTURE, "octo/loner", 2);
        assert!(result["connections"].as_array().unwrap().is_empty());
        assert!(result["secondDegree"].as_array().unwrap().is_empty());
        assert!(codes(&result).contains(&"derived-groups-not-relationships"));
        // A family without user provenance is treated as derived, not authored.
        let mut graph: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        for node in graph["nodes"].as_array_mut().unwrap() {
            if node["id"] == "group:user:toolchain" {
                node["provenance"] = serde_json::json!([{"category": "derived", "source": "x"}]);
            }
        }
        let result = navigate(&graph.to_string(), "octo/compiler", 1);
        let runtime = &result["connections"][0];
        assert_eq!(runtime["projectId"], "octo/runtime");
        assert_eq!(runtime["relationshipTypes"], serde_json::json!(["shared-language", "shared-topic"]));
    }

    #[test]
    fn rejects_invalid_depths_ids_and_unbounded_input() {
        let index = NavigationIndex::from_json(FIXTURE).unwrap();
        assert!(index.navigate("octo/compiler", 0).is_err());
        assert!(index.navigate("octo/compiler", 3).is_err());
        assert!(index.navigate("", 1).is_err());
        assert!(index.navigate("bad\u{0}id", 1).is_err());
        assert!(index.navigate_json(r#"{"projectId":"octo/compiler","script":"x"}"#).is_err());
        assert!(index.navigate_json(r#"{"projectId":"octo/compiler","depth":-1}"#).is_err());
        assert!(index.navigate_json(r#"{"projectId":"octo/compiler","depth":258}"#).is_err());
        assert!(index.navigate_json(r#"{"projectId":7}"#).is_err());
        assert!(index.navigate_json(&" ".repeat(MAX_REQUEST_BYTES + 1)).is_err());
        assert!(NavigationIndex::from_json("{").is_err());
        assert!(NavigationIndex::from_json("[]").is_err());
        assert!(NavigationIndex::from_json(r#"{"edges":[]}"#).is_err());
        assert!(NavigationIndex::from_json(r#"{"nodes":[{"id":1,"kind":"project"}]}"#).is_err());
        assert!(NavigationIndex::from_json(&" ".repeat(MAX_BYTES + 1)).is_err());
        assert!(NavigationIndex::from_json(r#"{"version":2,"nodes":[]}"#).is_err());
        let nodes = (0..=MAX_NODES).map(|i| format!(r#"{{"id":"p{i}","kind":"project"}}"#)).collect::<Vec<_>>().join(",");
        assert!(NavigationIndex::from_json(&format!(r#"{{"nodes":[{nodes}]}}"#)).err().unwrap().contains("bounds"));
        let duplicate = r#"{"nodes":[{"id":"a","kind":"project"},{"id":"a","kind":"project"}]}"#;
        assert!(NavigationIndex::from_json(duplicate).err().unwrap().contains("duplicate"));
    }

    #[test]
    fn dangling_edges_are_skipped_with_a_diagnostic() {
        let graph = r#"{"nodes":[{"id":"a","kind":"project"},{"id":"b","kind":"project"}],"edges":[
            {"id":"e1","kind":"project-relationship","from":"a","to":"b","provenance":[{"category":"user"}]},
            {"id":"e2","kind":"project-relationship","from":"a","to":"gone"},
            {"id":"e3","kind":"uses-language","from":"a","to":"language:missing"},
            {"id":"e4","kind":"project-relationship","from":"a","to":"a"}]}"#;
        let result = navigate(graph, "a", 1);
        assert_eq!(result["connections"][0]["projectId"], "b");
        assert_eq!(result["connections"][0]["label"], "b", "an empty label falls back to the ID");
        let skipped = result["diagnostics"].as_array().unwrap().iter().find(|d| d["code"] == "edges-without-supported-endpoints").unwrap();
        assert_eq!(skipped["ids"], serde_json::json!(["e2", "e3", "e4"]));
    }

    #[test]
    fn large_hubs_stay_bounded_and_report_truncation() {
        let mut nodes = vec![r#"{"id":"language:rust","kind":"language","label":"Rust"}"#.to_owned()];
        let mut edges = Vec::new();
        for i in 0..2000 {
            nodes.push(format!(r#"{{"id":"p/{i:04}","kind":"project"}}"#));
            edges.push(format!(r#"{{"id":"l{i:04}","kind":"uses-language","from":"p/{i:04}","to":"language:rust"}}"#));
            if i > 0 {
                edges.push(format!(r#"{{"id":"t{i:04}","kind":"project-relationship","from":"p/{:04}","to":"p/{i:04}"}}"#, i - 1));
            }
        }
        let graph = format!(r#"{{"nodes":[{}],"edges":[{}]}}"#, nodes.join(","), edges.join(","));
        let result = navigate(&graph, "p/0000", 2);
        assert_eq!(result["connections"].as_array().unwrap().len(), MAX_CONNECTIONS);
        assert_eq!(result["truncated"], true);
        assert!(codes(&result).contains(&"connections-truncated"));
        // Explicit + shared language precedes shared language alone, deterministically.
        assert_eq!(result["connections"][0]["projectId"], "p/0001");
        assert_eq!(result["connections"][1]["projectId"], "p/0002");
    }

    #[test]
    fn second_degree_traversal_has_a_work_budget() {
        // 250 projects that each share 64 topics: dense second-degree expansion.
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for t in 0..64 {
            nodes.push(format!(r#"{{"id":"topic:{t:02}","kind":"topic","label":"t{t}"}}"#));
        }
        for p in 0..250 {
            nodes.push(format!(r#"{{"id":"p/{p:03}","kind":"project"}}"#));
            for t in 0..64 {
                edges.push(format!(r#"{{"id":"h{p:03}-{t:02}","kind":"has-topic","from":"p/{p:03}","to":"topic:{t:02}"}}"#));
            }
        }
        // A chain of explicit links reaches projects outside the dense cluster.
        for p in 0..144 {
            nodes.push(format!(r#"{{"id":"q/{p:03}","kind":"project"}}"#));
            edges.push(format!(r#"{{"id":"x{p:03}","kind":"project-relationship","from":"p/{p:03}","to":"q/{p:03}"}}"#));
        }
        let graph = format!(r#"{{"nodes":[{}],"edges":[{}]}}"#, nodes.join(","), edges.join(","));
        let result = navigate(&graph, "p/000", 2);
        assert_eq!(result["truncated"], true);
        assert!(codes(&result).contains(&"traversal-budget-exhausted"));
        assert_eq!(navigate(&graph, "p/000", 2), result, "budgeted traversal stays deterministic");
    }

    #[test]
    fn second_degree_paths_are_stable_and_exclude_direct_neighbors() {
        let result = navigate(FIXTURE, "octo/site", 2);
        let direct: BTreeSet<_> = result["connections"].as_array().unwrap().iter().map(|c| c["projectId"].as_str().unwrap()).collect();
        assert!(!result["secondDegree"].as_array().unwrap().is_empty());
        for item in result["secondDegree"].as_array().unwrap() {
            assert!(!direct.contains(item["projectId"].as_str().unwrap()));
            assert_eq!(item["path"].as_array().unwrap().len(), 3);
            assert_eq!(item["path"][1], item["via"][0]);
            assert_eq!(item["hops"][1]["to"], item["projectId"]);
        }
    }

    #[test]
    fn output_is_valid_escaped_json() {
        let graph = r#"{"nodes":[{"id":"a\"b","kind":"project","label":"Quote \" \\ </script>"},{"id":"c","kind":"project","label":"\u00e9t\u00e9 \ud83d\ude80"}],
            "edges":[{"id":"e","kind":"project-relationship","from":"a\"b","to":"c","provenance":[{"category":"user"}]}]}"#;
        let index = NavigationIndex::from_json(graph).unwrap();
        let text = index.navigate("a\"b", 2).unwrap().to_json();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["project"]["label"], "Quote \" \\ </script>");
        assert_eq!(value["connections"][0]["label"], "\u{e9}t\u{e9} \u{1f680}");
        assert_eq!(value["connections"][0]["relationships"][0]["evidence"][0], serde_json::json!({"edgeIds": ["e"], "provenance": ["user"]}));
        let mut out = Json(String::new());
        out.string("\u{1}\n\t");
        assert_eq!(out.0, r#""\u0001\u000a\u0009""#);
    }

    #[test]
    fn stable_order_is_a_stable_sort() {
        let items = vec![(3, 'a'), (1, 'b'), (3, 'c'), (2, 'd'), (1, 'e'), (0, 'f'), (2, 'g')];
        let result = sorted(items.clone(), &|a, b| a.0.cmp(&b.0));
        let mut expected = items;
        expected.sort_by_key(|item| item.0);
        assert_eq!(result, expected);
        assert!(sorted(Vec::<u8>::new(), &|a, b| a.cmp(b)).is_empty());
    }
}
