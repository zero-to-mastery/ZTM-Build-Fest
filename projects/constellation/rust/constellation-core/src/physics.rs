use crate::geometry::{constrain, direction, separate, Node, NODE_RADIUS};

const REPULSION: f64 = 30_000.0;
const SPRING_LENGTH: f64 = 120.0;
const SPRING_STRENGTH: f64 = 3.0;
const CENTER_STRENGTH: f64 = 0.25;
const DAMPING: f64 = 4.0;
const MAX_SPEED: f64 = 300.0;

fn spring_force(a: &Node, b: &Node) -> (f64, f64) {
    let (dx, dy, distance) = direction(a, b);
    let force = SPRING_STRENGTH * (distance - SPRING_LENGTH);
    (dx * force, dy * force)
}

pub(crate) fn step(
    nodes: &mut [Node],
    edges: &[(usize, usize)],
    forces: &mut [(f64, f64)],
    width: f64,
    height: f64,
    delta: f64,
) {
    for (node, force) in nodes.iter().zip(forces.iter_mut()) {
        *force = (
            (width / 2.0 - node.x) * CENTER_STRENGTH,
            (height / 2.0 - node.y) * CENTER_STRENGTH,
        );
    }
    for a in 0..nodes.len() {
        for b in a + 1..nodes.len() {
            let (dx, dy, distance) = direction(&nodes[a], &nodes[b]);
            let force = REPULSION / (distance * distance + NODE_RADIUS * NODE_RADIUS);
            forces[a].0 -= dx * force;
            forces[a].1 -= dy * force;
            forces[b].0 += dx * force;
            forces[b].1 += dy * force;
        }
    }
    for &(a, b) in edges {
        let (fx, fy) = spring_force(&nodes[a], &nodes[b]);
        forces[a].0 += fx;
        forces[a].1 += fy;
        forces[b].0 -= fx;
        forces[b].1 -= fy;
    }
    let damping = (-DAMPING * delta).exp();
    for (node, &(fx, fy)) in nodes.iter_mut().zip(forces.iter()) {
        node.vx = (node.vx + fx * delta) * damping;
        node.vy = (node.vy + fy * delta) * damping;
        let speed = node.vx.hypot(node.vy);
        if speed > MAX_SPEED {
            node.vx *= MAX_SPEED / speed;
            node.vy *= MAX_SPEED / speed;
        }
        node.x += node.vx * delta;
        node.y += node.vy * delta;
    }
    // Two passes reduce overlaps introduced while resolving neighboring pairs.
    // Dense graphs in a tiny viewport may still overlap; bounds take priority.
    for _ in 0..2 {
        for a in 0..nodes.len() {
            for b in a + 1..nodes.len() {
                let (left, right) = nodes.split_at_mut(b);
                separate(&mut left[a], &mut right[0]);
            }
        }
        for node in nodes.iter_mut() {
            constrain(node, width, height);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn springs_attract_stretched_nodes_and_repel_compressed_nodes() {
        let a = Node::default();
        let mut b = Node {
            x: 240.0,
            ..Node::default()
        };
        assert!(spring_force(&a, &b).0 > 0.0);
        assert_eq!(spring_force(&a, &b).1, 0.0);
        b.x = 60.0;
        assert!(spring_force(&a, &b).0 < 0.0);
        b.x = SPRING_LENGTH;
        assert_eq!(spring_force(&a, &b), (0.0, 0.0));
    }

    #[test]
    fn unconnected_nodes_repel_symmetrically() {
        let mut nodes = [
            Node {
                x: 155.0,
                y: 150.0,
                ..Node::default()
            },
            Node {
                x: 205.0,
                y: 150.0,
                ..Node::default()
            },
        ];
        step(
            &mut nodes,
            &[],
            &mut [(0.0, 0.0); 2],
            360.0,
            300.0,
            1.0 / 120.0,
        );
        assert!(nodes[0].x < 155.0);
        assert!(nodes[1].x > 205.0);
        assert!((nodes[0].vx + nodes[1].vx).abs() < 1e-9);
    }

    #[test]
    fn damping_reduces_velocity_without_applied_force() {
        let mut nodes = [Node {
            x: 200.0,
            y: 150.0,
            vx: 100.0,
            vy: 0.0,
        }];
        step(
            &mut nodes,
            &[],
            &mut [(0.0, 0.0)],
            400.0,
            300.0,
            1.0 / 120.0,
        );
        assert!(nodes[0].vx > 0.0 && nodes[0].vx < 100.0);
    }
}
