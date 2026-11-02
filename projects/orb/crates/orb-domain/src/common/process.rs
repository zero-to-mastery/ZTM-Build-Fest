//! A process's parents, as `ps -A -o pid=,ppid=` lists them: which pane a
//! Claude runs in, and which window orb runs in.

use std::collections::HashMap;

/// Hops [`ancestry`] gives up after, so a bad table can't loop forever.
const MAX_DEPTH: usize = 64;

/// Each pid's parent in `ps -A -o pid=,ppid=` output; unreadable lines are
/// skipped.
pub fn parse_parents(stdout: &str) -> HashMap<u32, u32> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect()
}

/// `pid`, then its parent, grandparent and so on up to a process with no
/// known parent (or pid 1, whose parent is 0), at most [`MAX_DEPTH`] long.
pub fn ancestry(pid: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    std::iter::successors(Some(pid), |pid| {
        parents.get(pid).copied().filter(|&parent| parent != 0)
    })
    .take(MAX_DEPTH)
    .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{MAX_DEPTH, ancestry, parse_parents};

    #[rstest::rstest]
    fn parse_parents_reads_each_pid_and_its_parent() {
        // Given `ps` output with right-aligned columns and a junk line.
        let stdout = "    1     0\n  412     1\nnot a process\n60745 57407\n";

        // When parsing it.
        let parents = parse_parents(stdout);

        // Then each readable line maps its pid to its parent.
        assert_eq!(
            parents,
            HashMap::from([(1, 0), (412, 1), (60745, 57407)]),
            "every readable pid should map to its parent"
        );
    }

    #[rstest::rstest]
    fn ancestry_walks_up_to_the_first_process() {
        // Given claude under fish under a zmx daemon under launchd.
        let parents = HashMap::from([(1, 0), (100, 1), (200, 100), (300, 200)]);

        // When walking claude's ancestry.
        let chain = ancestry(300, &parents);

        // Then it runs from claude up to pid 1.
        assert_eq!(chain, [300, 200, 100, 1], "the walk should stop at pid 1");
    }

    #[rstest::rstest]
    fn ancestry_of_an_unknown_pid_is_just_itself() {
        // Given a table that doesn't know the pid.
        let parents = HashMap::from([(1, 0)]);

        // When walking its ancestry.
        let chain = ancestry(42, &parents);

        // Then only the pid itself comes back.
        assert_eq!(chain, [42], "an unknown pid has no parents");
    }

    #[rstest::rstest]
    fn ancestry_stops_after_a_cycle() {
        // Given two processes that name each other as parent.
        let parents = HashMap::from([(7, 8), (8, 7)]);

        // When walking the ancestry.
        let chain = ancestry(7, &parents);

        // Then the walk gives up at the depth limit.
        assert_eq!(chain.len(), MAX_DEPTH, "a cycle should stop at MAX_DEPTH");
    }
}
