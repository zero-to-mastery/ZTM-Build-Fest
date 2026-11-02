use serde::Deserialize;

#[derive(Deserialize)]
pub struct Input {
    account: String,
    names: Vec<String>,
    compact: bool,
    #[serde(default)]
    round: bool,
}
fn hash(value: &str) -> u32 {
    value.bytes().fold(2166136261u32, |n, b| {
        (n ^ u32::from(b)).wrapping_mul(16777619)
    })
}
// Stable overview coordinates depend on identity, never the current node count.
pub fn positions(input: Input) -> Result<Vec<[f64; 2]>, String> {
    if input.names.len() > 2048 {
        return Err("Stable overview supports at most 2048 nodes".into());
    }
    Ok(input
        .names
        .iter()
        .map(|name| {
            let key = format!("{}:{name}", input.account);
            let angle = f64::from(hash(&key)) / f64::from(u32::MAX) * std::f64::consts::TAU;
            let radius = (f64::from(hash(&format!("{key}:radius"))) / f64::from(u32::MAX)).sqrt();
            let spread_x = match (input.round, input.compact) {
                (true, true) => 88.0,
                (true, false) => 192.0,
                _ => 368.0,
            };
            [
                450.0 + angle.cos() * radius * spread_x,
                if input.compact {
                    126.0 + angle.sin() * radius * 88.0
                } else {
                    270.0 + angle.sin() * radius * 192.0
                },
            ]
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subsets_and_reordering_preserve_coordinates() {
        let run = |names: Vec<String>| {
            positions(Input {
                account: "tester".into(),
                names,
                compact: false,
                round: false,
            })
            .unwrap()
        };
        let all = run(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(run(vec!["c".into(), "a".into()]), vec![all[2], all[0]]);
        assert_eq!(all, run(vec!["a".into(), "b".into(), "c".into()]));
    }
    #[test]
    fn round_overview_stays_within_a_circle() {
        let points = positions(Input { account: "tester".into(), names: (0..64).map(|i| i.to_string()).collect(), compact: false, round: true }).unwrap();
        for [x, y] in points {
            assert!(((x - 450.0).powi(2) + (y - 270.0).powi(2)).sqrt() <= 192.0 + 1e-9);
        }
    }
}
