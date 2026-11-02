use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub struct Node {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    // Attached label rectangle relative to the node: left, top, right, bottom.
    pub label: Option<[f64; 4]>,
    pub locked: bool,
    pub hidden: bool,
}

#[derive(Deserialize)]
pub struct Input {
    pub nodes: Vec<Node>,
    pub intensity: u8,
    pub height: f64,
    pub anchors: Option<Vec<[f64; 2]>>,
}

fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}

fn boxes(node: &Node, p: [f64; 2]) -> [[f64; 4]; 2] {
    let r = node.radius + 3.0;
    let mut result = [
        [p[0] - r, p[1] - r, p[0] + r, p[1] + r],
        [p[0], p[1], p[0], p[1]],
    ];
    if let Some(b) = node.label {
        result[1] = [p[0] + b[0], p[1] + b[1], p[0] + b[2], p[1] + b[3]];
    }
    result
}

fn overlap(a: &Node, pa: [f64; 2], b: &Node, pb: [f64; 2]) -> f64 {
    if a.hidden || b.hidden {
        return 0.0;
    }
    overlap_boxes(boxes(a, pa), boxes(b, pb))
}

fn overlap_boxes(a: [[f64; 4]; 2], b: [[f64; 4]; 2]) -> f64 {
    let mut area = 0.0;
    for a in a {
        for b in b {
            if a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1] {
                continue;
            }
            area += (a[2].min(b[2]) - a[0].max(b[0])).max(0.0)
                * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
        }
    }
    area
}

fn valid(node: &Node, p: [f64; 2], origin: [f64; 2], limit: f64, height: f64) -> bool {
    distance(p, origin) <= limit * limit + 1e-8
        && p[0] >= 32.0
        && p[0] <= 868.0
        && p[1] >= 28.0
        && p[1] <= height - 60.0
        && boxes(node, p)
            .iter()
            .all(|b| b[0] >= 18.0 && b[2] <= 882.0 && b[1] >= 18.0 && b[3] <= height - 40.0)
}

fn local_cost(
    input: &Input,
    bounds_cache: &[[[f64; 4]; 2]],
    i: usize,
    p: [f64; 2],
    skip: Option<usize>,
) -> f64 {
    let node = &input.nodes[i];
    let bounds = boxes(node, p);
    let mut cost = distance(p, [node.x, node.y]) * 0.015;
    for (j, other) in input.nodes.iter().enumerate() {
        if j != i && Some(j) != skip && !other.hidden {
            cost += overlap_boxes(bounds, bounds_cache[j]);
        }
    }
    cost
}

// Bounded deterministic coordinate descent. Each accepted move reduces overlap
// plus a tether penalty; no seed, clock or continuous simulation is involved.
pub fn refine(input: Input) -> Result<Vec<[f64; 2]>, String> {
    if input.nodes.len() > 2048
        || input.intensity > 10
        || !input.height.is_finite()
        || input.height < 160.0
        || input.height > 2000.0
    {
        return Err("Invalid refinement dimensions or intensity".into());
    }
    for node in &input.nodes {
        if !node.x.is_finite()
            || !node.y.is_finite()
            || !node.radius.is_finite()
            || node.radius < 0.0
            || node.radius > 100.0
            || node
                .label
                .is_some_and(|b| b.iter().any(|v| !v.is_finite()) || b[0] > b[2] || b[1] > b[3])
        {
            return Err("Invalid refinement node".into());
        }
    }
    if input
        .anchors
        .as_ref()
        .is_some_and(|a| a.len() > 2048 || a.iter().flatten().any(|v| !v.is_finite()))
    {
        return Err("Invalid refinement anchors".into());
    }
    let mut positions: Vec<_> = input.nodes.iter().map(|n| [n.x, n.y]).collect();
    let mut bounds_cache: Vec<_> = input.nodes.iter().map(|n| boxes(n, [n.x, n.y])).collect();
    if input.intensity == 0 {
        return Ok(positions);
    }
    let limit = f64::from(input.intensity) * 6.0;
    for pass in 0..(4 + usize::from(input.intensity) * 2) {
        let mut changed = false;
        for (i, node) in input.nodes.iter().enumerate() {
            if node.locked || node.hidden {
                continue;
            }
            let origin = [node.x, node.y];
            let current = positions[i];
            let mut candidates = if let Some(anchors) = &input.anchors {
                let mut points = anchors.clone();
                points.sort_by(|a, b| distance(*a, current).total_cmp(&distance(*b, current)));
                points.truncate(12);
                points
            } else {
                let step = if pass < 4 { 6.0 } else { 3.0 };
                (-1..=1)
                    .flat_map(|x| {
                        (-1..=1).map(move |y| {
                            [
                                current[0] + f64::from(x) * step,
                                current[1] + f64::from(y) * step,
                            ]
                        })
                    })
                    .collect()
            };
            candidates.retain(|p| valid(node, *p, origin, limit, input.height));
            let mut best_delta = -1e-7;
            let mut best = None;
            let baseline = local_cost(&input, &bounds_cache, i, current, None);
            for p in candidates {
                if input.anchors.is_some()
                    && positions.iter().enumerate().any(|(j, q)| {
                        j != i
                            && (input.nodes[j].locked || input.nodes[j].hidden)
                            && distance(*q, p) < 0.1
                    })
                {
                    continue;
                }
                let occupant = if input.anchors.is_some() {
                    positions
                        .iter()
                        .enumerate()
                        .find(|(j, q)| *j != i && distance(**q, p) < 0.1)
                        .map(|(j, _)| j)
                } else {
                    None
                };
                if let Some(j) = occupant {
                    let other = &input.nodes[j];
                    if other.locked
                        || other.hidden
                        || !valid(other, current, [other.x, other.y], limit, input.height)
                        || !input
                            .anchors
                            .as_ref()
                            .unwrap()
                            .iter()
                            .any(|a| distance(*a, current) < 0.1)
                    {
                        continue;
                    }
                }
                // Fixed nodes also reserve their associated anchor, even when
                // their current layout position is not on that anchor.
                if input.anchors.as_ref().is_some_and(|anchors| {
                    anchors.iter().enumerate().any(|(j, a)| {
                        j != i
                            && input.nodes.get(j).is_some_and(|n| n.hidden || n.locked)
                            && distance(*a, p) < 0.1
                    })
                }) {
                    continue;
                }
                let mut delta = local_cost(&input, &bounds_cache, i, p, occupant) - baseline;
                if let Some(j) = occupant {
                    delta += overlap(node, current, &input.nodes[j], positions[j]);
                    delta += local_cost(&input, &bounds_cache, j, current, Some(i))
                        - local_cost(&input, &bounds_cache, j, positions[j], Some(i));
                    delta += overlap(node, p, &input.nodes[j], current)
                        - overlap(node, current, &input.nodes[j], positions[j]);
                }
                if delta < best_delta {
                    best_delta = delta;
                    best = Some((p, occupant));
                }
            }
            if let Some((p, other)) = best {
                if let Some(j) = other {
                    positions[j] = current;
                    bounds_cache[j] = boxes(&input.nodes[j], current);
                }
                positions[i] = p;
                bounds_cache[i] = boxes(node, p);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Ok(positions)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(x: f64) -> Node {
        Node {
            x,
            y: 100.0,
            radius: 6.0,
            label: Some([-35.0, 7.0, 35.0, 20.0]),
            locked: false,
            hidden: false,
        }
    }
    fn input() -> Input {
        Input {
            nodes: vec![node(400.0), node(402.0), node(404.0)],
            intensity: 5,
            height: 280.0,
            anchors: None,
        }
    }
    #[test]
    fn deterministic_bounded_and_reduces_overlap() {
        let result = refine(input()).unwrap();
        assert_eq!(result, refine(input()).unwrap());
        let initial = input();
        let before = overlap(
            &initial.nodes[0],
            [400.0, 100.0],
            &initial.nodes[1],
            [402.0, 100.0],
        );
        let after = overlap(&initial.nodes[0], result[0], &initial.nodes[1], result[1]);
        assert!(after < before);
        for (n, p) in initial.nodes.iter().zip(result) {
            assert!(valid(n, p, [n.x, n.y], 30.0, 280.0));
        }
    }
    #[test]
    fn fixed_and_hidden_never_move() {
        let mut data = input();
        data.nodes[0].locked = true;
        data.nodes[1].hidden = true;
        let result = refine(data).unwrap();
        assert_eq!(result[0], [400.0, 100.0]);
        assert_eq!(result[1], [402.0, 100.0]);
    }
    #[test]
    fn zero_intensity_is_exact() {
        let mut data = input();
        data.intensity = 0;
        assert_eq!(
            refine(data).unwrap(),
            vec![[400.0, 100.0], [402.0, 100.0], [404.0, 100.0]]
        );
    }
    #[test]
    fn swaps_movable_pairs_on_occupied_anchors_but_never_locked_pairs() {
        let mut left = node(400.0);
        left.label = Some([5.0, 7.0, 65.0, 20.0]);
        let mut right = node(440.0);
        right.label = Some([-65.0, 7.0, -5.0, 20.0]);
        let anchors = vec![[400.0, 100.0], [440.0, 100.0]];
        let input = |nodes| Input {
            nodes,
            intensity: 10,
            height: 280.0,
            anchors: Some(anchors.clone()),
        };
        assert_eq!(
            refine(input(vec![left.clone(), right.clone()])).unwrap(),
            vec![anchors[1], anchors[0]]
        );
        right.locked = true;
        assert_eq!(refine(input(vec![left, right])).unwrap(), anchors);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let mut data = input();
        data.intensity = 11;
        assert!(refine(data).is_err());
        let mut data = input();
        data.nodes[0].x = f64::NAN;
        assert!(refine(data).is_err());
        let mut data = input();
        data.nodes = vec![node(400.0); 2049];
        assert!(refine(data).is_err());
    }
    #[test]
    fn snapping_uses_only_anchors_and_reserves_hidden_points() {
        let mut data = input();
        data.nodes[1].hidden = true;
        let anchors = vec![[400.0, 100.0], [420.0, 100.0], [404.0, 100.0]];
        data.anchors = Some(anchors.clone());
        let result = refine(data).unwrap();
        assert_eq!(result[1], [402.0, 100.0]);
        for i in [0, 2] {
            assert!(anchors.contains(&result[i]));
            assert_ne!(result[i], anchors[1]);
        }
    }

    #[test]
    fn off_ring_locked_pairs_reserve_their_anchor() {
        let mut data = input();
        data.nodes[1].locked = true;
        data.anchors = Some(vec![[400.0, 100.0], [420.0, 100.0], [404.0, 100.0]]);
        let result = refine(data).unwrap();
        assert_eq!(result[1], [402.0, 100.0]);
        assert_ne!(result[0], [420.0, 100.0]);
        assert_ne!(result[2], [420.0, 100.0]);
    }
}
