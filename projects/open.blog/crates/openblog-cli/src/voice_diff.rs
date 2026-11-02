//! A small unified diff between two texts, for `openblog voice diff`.
//!
//! Line based, with three lines of context. Pure and dependency free. Very large pairs (more than
//! 16 million line comparisons) fall back to showing the whole old text removed and the whole new
//! text added, which is always correct if not minimal.

const CONTEXT: usize = 3;
const MAX_CELLS: usize = 16_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Keep,
    Remove,
    Add,
}

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

fn edit_script(old: &[&str], new: &[&str]) -> Vec<(Op, usize)> {
    let (n, m) = (old.len(), new.len());
    if (n + 1).saturating_mul(m + 1) > MAX_CELLS {
        return (0..n)
            .map(|i| (Op::Remove, i))
            .chain((0..m).map(|j| (Op::Add, j)))
            .collect();
    }
    // lcs[i][j]: the longest common run of old[i..] and new[j..].
    let mut lcs = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[at(i, j)] = if old[i] == new[j] {
                lcs[at(i + 1, j + 1)] + 1
            } else {
                lcs[at(i + 1, j)].max(lcs[at(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut script = Vec::new();
    while i < n || j < m {
        if i < n && j < m && old[i] == new[j] {
            script.push((Op::Keep, i));
            i += 1;
            j += 1;
        } else if j >= m || (i < n && lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
            script.push((Op::Remove, i));
            i += 1;
        } else {
            script.push((Op::Add, j));
            j += 1;
        }
    }
    script
}

/// The unified diff of `old` to `new`, or an empty string if they are equal.
pub fn unified(old_name: &str, new_name: &str, old: &str, new: &str) -> String {
    if old == new {
        return String::new();
    }
    let (a, b) = (lines(old), lines(new));
    let script = edit_script(&a, &b);
    // Positions in each file for every step, so a hunk header can be written.
    let mut old_at = Vec::with_capacity(script.len());
    let mut new_at = Vec::with_capacity(script.len());
    let (mut i, mut j) = (0usize, 0usize);
    for (op, _) in &script {
        old_at.push(i);
        new_at.push(j);
        match op {
            Op::Keep => {
                i += 1;
                j += 1;
            }
            Op::Remove => i += 1,
            Op::Add => j += 1,
        }
    }
    let changed: Vec<usize> = script
        .iter()
        .enumerate()
        .filter(|(_, (op, _))| *op != Op::Keep)
        .map(|(k, _)| k)
        .collect();
    let mut out = format!("--- {old_name}\n+++ {new_name}\n");
    let mut k = 0;
    while k < changed.len() {
        let first = changed[k];
        let mut last = first;
        while k + 1 < changed.len() && changed[k + 1] <= last + 2 * CONTEXT + 1 {
            k += 1;
            last = changed[k];
        }
        k += 1;
        let start = first.saturating_sub(CONTEXT);
        let end = (last + CONTEXT + 1).min(script.len());
        let old_count = script[start..end]
            .iter()
            .filter(|(op, _)| *op != Op::Add)
            .count();
        let new_count = script[start..end]
            .iter()
            .filter(|(op, _)| *op != Op::Remove)
            .count();
        let old_start = if old_count == 0 {
            old_at[start]
        } else {
            old_at[start] + 1
        };
        let new_start = if new_count == 0 {
            new_at[start]
        } else {
            new_at[start] + 1
        };
        out.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        for (op, index) in &script[start..end] {
            match op {
                Op::Keep => out.push_str(&format!(" {}\n", a[*index])),
                Op::Remove => out.push_str(&format!("-{}\n", a[*index])),
                Op::Add => out.push_str(&format!("+{}\n", b[*index])),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_texts_have_no_diff() {
        assert_eq!(unified("a", "b", "x\ny", "x\ny"), "");
    }

    #[test]
    fn a_changed_line_shows_as_removed_and_added_with_context() {
        let diff = unified(
            "rough",
            "polished",
            "one\ntwo teh\nthree",
            "one\ntwo the\nthree",
        );
        assert_eq!(
            diff,
            "--- rough\n+++ polished\n@@ -1,3 +1,3 @@\n one\n-two teh\n+two the\n three\n"
        );
    }

    #[test]
    fn far_apart_changes_make_separate_hunks() {
        let old: Vec<String> = (1..=30).map(|n| format!("line {n}")).collect();
        let mut new = old.clone();
        new[1] = "changed 2".into();
        new[27] = "changed 28".into();
        let diff = unified("a", "b", &old.join("\n"), &new.join("\n"));
        assert_eq!(diff.matches("@@ -").count(), 2, "{diff}");
        assert!(diff.contains("-line 2\n+changed 2\n") && diff.contains("-line 28\n+changed 28\n"));
    }

    #[test]
    fn additions_and_deletions_at_the_ends() {
        let diff = unified("a", "b", "keep", "new first\nkeep\nnew last");
        assert!(diff.contains("+new first\n keep\n+new last\n"), "{diff}");
        let diff = unified("a", "b", "gone", "");
        assert!(diff.contains("@@ -1,1 +0,0 @@\n-gone\n"), "{diff}");
    }
}
