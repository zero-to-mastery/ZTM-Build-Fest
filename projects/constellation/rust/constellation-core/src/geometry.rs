pub(crate) const NODE_RADIUS: f64 = 24.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Node {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
}

pub(crate) fn direction(a: &Node, b: &Node) -> (f64, f64, f64) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distance = dx.hypot(dy);
    if distance < 1e-9 {
        // A fixed direction separates coincident nodes without random jitter.
        (1.0, 0.0, 0.0)
    } else {
        (dx / distance, dy / distance, distance)
    }
}

pub(crate) fn separate(a: &mut Node, b: &mut Node) {
    let (dx, dy, distance) = direction(a, b);
    let overlap = 2.0 * NODE_RADIUS - distance;
    if overlap > 0.0 {
        a.x -= dx * overlap / 2.0;
        a.y -= dy * overlap / 2.0;
        b.x += dx * overlap / 2.0;
        b.y += dy * overlap / 2.0;
    }
}

pub(crate) fn constrain(node: &mut Node, width: f64, height: f64) {
    let x = node.x.clamp(NODE_RADIUS, width - NODE_RADIUS);
    let y = node.y.clamp(NODE_RADIUS, height - NODE_RADIUS);
    if x != node.x {
        node.vx = 0.0;
    }
    if y != node.y {
        node.vy = 0.0;
    }
    node.x = x;
    node.y = y;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collisions_separate_overlapping_and_coincident_nodes() {
        for offset in [0.0, 10.0, 47.0] {
            let mut a = Node {
                x: 100.0,
                y: 100.0,
                ..Node::default()
            };
            let mut b = Node {
                x: 100.0 + offset,
                y: 100.0,
                ..Node::default()
            };
            let center = (a.x + b.x) / 2.0;
            separate(&mut a, &mut b);
            assert!((direction(&a, &b).2 - 2.0 * NODE_RADIUS).abs() < 1e-9);
            assert_eq!((a.x + b.x) / 2.0, center);
        }
    }

    #[test]
    fn separated_nodes_are_unchanged() {
        let mut a = Node::default();
        let mut b = Node {
            x: 200.0,
            ..Node::default()
        };
        let original = (a, b);
        separate(&mut a, &mut b);
        assert_eq!((a, b), original);
    }

    #[test]
    fn bounds_keep_the_whole_node_inside_and_stop_outward_velocity() {
        let mut node = Node {
            x: -10.0,
            y: 500.0,
            vx: -20.0,
            vy: 30.0,
        };
        constrain(&mut node, 320.0, 240.0);
        assert_eq!(
            node,
            Node {
                x: NODE_RADIUS,
                y: 240.0 - NODE_RADIUS,
                vx: 0.0,
                vy: 0.0
            }
        );
    }
}
