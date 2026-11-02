use crate::geometry::{constrain, Node, NODE_RADIUS};
use crate::physics;
use std::collections::{BTreeSet, VecDeque};

const MAX_NODES: u32 = 2048;
const MAX_DIMENSION: f64 = 100_000.0;
const MAX_DELTA: f64 = 0.05;
const MAX_STEP: f64 = 1.0 / 120.0;

pub(crate) struct Graph {
    pub nodes: Vec<Node>,
    edges: Vec<(usize, usize)>,
    forces: Vec<(f64, f64)>,
    width: f64,
    height: f64,
}

fn validate_viewport(width: f64, height: f64) -> Result<(), &'static str> {
    if [width, height]
        .iter()
        .any(|value| !value.is_finite() || !(2.0 * NODE_RADIUS..=MAX_DIMENSION).contains(value))
    {
        return Err("Viewport dimensions must be finite and between 48 and 100000 pixels");
    }
    Ok(())
}

impl Graph {
    pub fn new(count: u32, pairs: &[u32], width: f64, height: f64) -> Result<Self, &'static str> {
        validate_viewport(width, height)?;
        if count > MAX_NODES {
            return Err("The simulation supports at most 2048 nodes");
        }
        if pairs.len() % 2 != 0 {
            return Err("Edges must contain complete pairs of node indices");
        }
        let mut edges = BTreeSet::new();
        for pair in pairs.chunks_exact(2) {
            let (a, b) = (pair[0], pair[1]);
            if a >= count || b >= count {
                return Err("An edge references an unknown node index");
            }
            if a == b {
                return Err("An edge must connect two different nodes");
            }
            edges.insert((a.min(b) as usize, a.max(b) as usize));
        }
        let columns = (count as f64).sqrt().ceil().max(1.0) as u32;
        let rows = count.div_ceil(columns).max(1);
        let nodes = (0..count)
            .map(|index| Node {
                x: NODE_RADIUS
                    + (width - 2.0 * NODE_RADIUS) * (f64::from(index % columns) + 0.5)
                        / f64::from(columns),
                y: NODE_RADIUS
                    + (height - 2.0 * NODE_RADIUS) * (f64::from(index / columns) + 0.5)
                        / f64::from(rows),
                ..Node::default()
            })
            .collect();
        Ok(Self {
            nodes,
            edges: edges.into_iter().collect(),
            forces: vec![(0.0, 0.0); count as usize],
            width,
            height,
        })
    }

    /// Shortest unweighted path; sorted edges make equal-length ties deterministic.
    pub fn find_path(&self, start: u32, end: u32) -> Result<Vec<u32>, &'static str> {
        let (start, end) = (start as usize, end as usize);
        if start >= self.nodes.len() || end >= self.nodes.len() {
            return Err("A path endpoint references an unknown node index");
        }
        let mut neighbors = vec![Vec::new(); self.nodes.len()];
        for &(a, b) in &self.edges {
            neighbors[a].push(b);
            neighbors[b].push(a);
        }
        let mut previous = vec![None; self.nodes.len()];
        previous[start] = Some(start);
        let mut queue = VecDeque::from([start]);
        while let Some(node) = queue.pop_front() {
            if node == end {
                let mut path = vec![end as u32];
                let mut current = end;
                while current != start {
                    current = previous[current].expect("Queued nodes have a predecessor");
                    path.push(current as u32);
                }
                path.reverse();
                return Ok(path);
            }
            for &neighbor in &neighbors[node] {
                if previous[neighbor].is_none() {
                    previous[neighbor] = Some(node);
                    queue.push_back(neighbor);
                }
            }
        }
        Ok(Vec::new())
    }

    pub fn tick(&mut self, delta: f64) {
        if !delta.is_finite() || delta <= 0.0 {
            return;
        }
        let delta = delta.min(MAX_DELTA);
        let steps = (delta / MAX_STEP).ceil() as usize;
        for _ in 0..steps {
            physics::step(
                &mut self.nodes,
                &self.edges,
                &mut self.forces,
                self.width,
                self.height,
                delta / steps as f64,
            );
        }
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<(), &'static str> {
        validate_viewport(width, height)?;
        self.width = width;
        self.height = height;
        for node in &mut self.nodes {
            constrain(node, width, height);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_follow_undirected_edges_and_choose_the_shortest_route() {
        // A longer route 0-1-2-3 and a shorter route 0-4-3 form a cycle.
        let graph = Graph::new(5, &[0, 1, 1, 2, 2, 3, 0, 4, 4, 3], 640.0, 400.0).unwrap();
        assert_eq!(graph.find_path(0, 3).unwrap(), vec![0, 4, 3]);
        assert_eq!(graph.find_path(3, 0).unwrap(), vec![3, 4, 0]);
        assert_eq!(graph.find_path(1, 2).unwrap(), vec![1, 2]);
    }

    #[test]
    fn equal_length_paths_are_stable_across_duplicate_reordered_and_reversed_edges() {
        for pairs in [
            vec![0, 1, 1, 3, 0, 2, 2, 3],
            vec![3, 2, 2, 0, 3, 1, 1, 0, 0, 1],
        ] {
            let graph = Graph::new(4, &pairs, 640.0, 400.0).unwrap();
            assert_eq!(graph.find_path(0, 3).unwrap(), vec![0, 1, 3]);
        }
    }

    #[test]
    fn a_path_to_the_same_node_contains_only_that_node() {
        let graph = Graph::new(2, &[], 640.0, 400.0).unwrap();
        assert_eq!(graph.find_path(1, 1).unwrap(), vec![1]);
    }

    #[test]
    fn disconnected_nodes_have_no_path() {
        let graph = Graph::new(4, &[0, 1, 2, 3], 640.0, 400.0).unwrap();
        assert!(graph.find_path(0, 3).unwrap().is_empty());
    }

    #[test]
    fn invalid_path_endpoints_are_errors_including_on_an_empty_graph() {
        let graph = Graph::new(2, &[0, 1], 640.0, 400.0).unwrap();
        for (start, end) in [(2, 0), (0, 2), (u32::MAX, u32::MAX)] {
            assert!(graph.find_path(start, end).is_err());
        }
        assert!(Graph::new(0, &[], 640.0, 400.0)
            .unwrap()
            .find_path(0, 0)
            .is_err());
    }

    #[test]
    fn initialization_supports_empty_and_single_node_graphs() {
        assert!(Graph::new(0, &[], 640.0, 400.0).unwrap().nodes.is_empty());
        assert_eq!(
            Graph::new(1, &[], 640.0, 400.0).unwrap().nodes[0],
            Node {
                x: 320.0,
                y: 200.0,
                ..Node::default()
            }
        );
    }

    #[test]
    fn validates_viewports_counts_and_edge_references() {
        for width in [f64::NAN, f64::INFINITY, -100.0, 0.0, 47.0, 100_001.0] {
            assert!(Graph::new(1, &[], width, 400.0).is_err());
            assert!(Graph::new(1, &[], 640.0, width).is_err());
        }
        assert!(Graph::new(2049, &[], 640.0, 400.0).is_err());
        for pairs in [&[0][..], &[0, 3], &[1, 1]] {
            assert!(Graph::new(3, pairs, 640.0, 400.0).is_err());
        }
    }

    #[test]
    fn duplicate_and_reversed_edges_do_not_add_extra_springs() {
        let graph = Graph::new(3, &[1, 0, 0, 1, 2, 1], 640.0, 400.0).unwrap();
        assert_eq!(graph.edges, vec![(0, 1), (1, 2)]);
    }

    #[test]
    fn repeated_ticks_keep_coordinates_finite_bounded_and_count_stable() {
        for count in [0, 1, 2, 27, 64, 256] {
            let pairs: Vec<u32> = (1..count).flat_map(|index| [index - 1, index]).collect();
            let mut graph = Graph::new(count, &pairs, 640.0, 400.0).unwrap();
            for frame in 0..300 {
                graph.tick(if frame % 10 == 0 { 10.0 } else { 1.0 / 60.0 });
                assert_eq!(graph.nodes.len(), count as usize);
                for node in &graph.nodes {
                    assert!(node.x.is_finite() && node.y.is_finite());
                    assert!(node.vx.is_finite() && node.vy.is_finite());
                    assert!((NODE_RADIUS..=640.0 - NODE_RADIUS).contains(&node.x));
                    assert!((NODE_RADIUS..=400.0 - NODE_RADIUS).contains(&node.y));
                }
            }
        }
    }

    #[test]
    fn same_inputs_produce_the_same_simulation_and_long_pauses_are_capped() {
        let mut a = Graph::new(5, &[0, 1, 1, 2], 640.0, 400.0).unwrap();
        let mut b = Graph::new(5, &[1, 2, 1, 0], 640.0, 400.0).unwrap();
        for _ in 0..100 {
            a.tick(1.0 / 60.0);
            b.tick(1.0 / 60.0);
        }
        assert_eq!(a.nodes, b.nodes);
        a.tick(f64::MAX);
        b.tick(MAX_DELTA);
        assert_eq!(a.nodes, b.nodes);
    }

    #[test]
    fn invalid_time_steps_and_failed_resizes_do_not_change_state() {
        let mut graph = Graph::new(5, &[], 640.0, 400.0).unwrap();
        let original = graph.nodes.clone();
        for delta in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
            graph.tick(delta);
            assert_eq!(graph.nodes, original);
        }
        assert!(graph.resize(0.0, 400.0).is_err());
        assert_eq!(graph.nodes, original);
        assert_eq!(graph.width, 640.0);
        graph.resize(48.0, 48.0).unwrap();
        graph.tick(1.0 / 60.0);
        for node in graph.nodes {
            assert_eq!((node.x, node.y), (24.0, 24.0));
        }
    }
}
