//! Evidence-to-geometry only. Labels are identifiers; clients own presentation.
use crate::profile_evidence::{self, Profile, Repository, DIMENSIONS};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, f64::consts::TAU};

#[derive(Deserialize)]
pub struct Record {
    #[serde(flatten)]
    pub evidence: Repository,
    pub updated_day: Option<i32>,
    pub created_year: Option<i32>,
}
#[derive(Deserialize)]
pub struct Input {
    pub repositories: Vec<Record>,
    pub mode: String,
    pub reference_day: i32,
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub rotations: [f64; 4],
    /// Round orbits: the horizontal spread equals the vertical one.
    #[serde(default)]
    pub round: bool,
}
#[derive(Serialize)]
pub struct Placement {
    pub repository: String,
    pub category: String,
    pub band: usize,
    pub sector: Option<usize>,
    pub strength: f64,
    pub position: [f64; 2],
}
#[derive(Serialize)]
pub struct Ray {
    pub dimension: String,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub label: [f64; 2],
}
#[derive(Serialize)]
pub struct Output {
    pub mode: String,
    pub profile: Profile,
    pub placements: Vec<Placement>,
    pub rays: Vec<Ray>,
    pub bands: Vec<String>,
    pub radii: Vec<f64>,
    pub guides: Vec<Guide>,
}
#[derive(Serialize)]
pub struct Guide {
    pub text: String,
    pub position: [f64; 2],
}
fn round(n: f64) -> f64 {
    (n * 1000.0).round() / 1000.0
}
pub fn layout(mut input: Input) -> Result<Output, String> {
    if !["identity", "capability", "showcase", "activity", "era"].contains(&input.mode.as_str()) {
        return Err("Unknown semantic ring meaning".into());
    }
    if !(0..=2932896).contains(&input.reference_day)
        || input
            .rotations
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 3600.0)
    {
        return Err("Invalid semantic reference day or rotation".into());
    }
    input
        .repositories
        .sort_by(|a, b| a.evidence.name.cmp(&b.evidence.name));
    if input
        .repositories
        .windows(2)
        .any(|r| r[0].evidence.name == r[1].evidence.name)
    {
        return Err("Duplicate semantic repository".into());
    }
    for r in &input.repositories {
        if r.updated_day.is_some_and(|d| !(0..=2932896).contains(&d))
            || r.created_year.is_some_and(|y| !(1970..=9999).contains(&y))
        {
            return Err("Invalid semantic repository date".into());
        }
    }
    let mut profile = profile_evidence::analyze(profile_evidence::Input {
        repositories: input
            .repositories
            .iter()
            .map(|r| r.evidence.clone())
            .collect(),
    })?;
    profile.nodes = profile
        .repositories
        .iter()
        .map(|r| profile_evidence::NodeAffinity {
            node: r.repository.clone(),
            dimensions: r.dimensions.clone(),
        })
        .collect();
    let observed_eras: Vec<_> = input
        .repositories
        .iter()
        .filter_map(|r| r.created_year)
        .map(|y| y / 5 * 5)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    // At most five dated bands, even for unusually long histories.
    let first = *observed_eras.first().unwrap_or(&1970);
    let last = *observed_eras.last().unwrap_or(&first);
    let era_width = (((last - first + 5) as f64 / 25.0).ceil() as i32).max(1) * 5;
    let eras: Vec<_> = if observed_eras.is_empty() {
        vec![]
    } else {
        (first..=last).step_by(era_width as usize).collect()
    };
    let bands: Vec<String> = match input.mode.as_str() {
        "capability" => vec![
            "strong evidence",
            "moderate evidence",
            "limited evidence",
            "no evidence",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        "showcase" => vec![
            "featured",
            "supporting",
            "experimental",
            "historical",
            "unassigned",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        "activity" => vec![
            "updated within 30 days",
            "updated 31–180 days ago",
            "updated 181–365 days ago",
            "updated over 365 days ago",
            "update unavailable or future",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        "era" => eras
            .iter()
            .map(|y| format!("{}–{} creation metadata", y, y + era_width - 1))
            .chain(["creation unavailable".into()])
            .collect(),
        _ => vec!["identity".into()],
    };
    let mut placements = Vec::new();
    for (record, affinity) in input.repositories.iter().zip(&profile.repositories) {
        // Strict comparison gives mixed/tied evidence a stable dimension-order tie break.
        let mut sector = 0;
        for i in 1..6 {
            if affinity.dimensions[i] > affinity.dimensions[sector] {
                sector = i;
            }
        }
        let strength = affinity.dimensions[sector];
        let (band, category, sector) = match input.mode.as_str() {
            "capability" => (
                if strength >= 0.67 {
                    0
                } else if strength >= 0.34 {
                    1
                } else if strength > 0.0 {
                    2
                } else {
                    3
                },
                if strength > 0.0 {
                    DIMENSIONS[sector]
                } else {
                    "no evidence"
                }
                .to_string(),
                if strength > 0.0 { Some(sector) } else { None },
            ),
            "showcase" => {
                let b = ["featured", "supporting", "experimental", "historical"]
                    .iter()
                    .position(|r| *r == record.evidence.role)
                    .unwrap_or(4);
                (b, bands[b].clone(), None)
            }
            "activity" => {
                let age = record
                    .updated_day
                    .filter(|d| *d <= input.reference_day)
                    .map(|d| input.reference_day - d);
                let b = match age {
                    Some(0..=30) => 0,
                    Some(31..=180) => 1,
                    Some(181..=365) => 2,
                    Some(_) => 3,
                    None => 4,
                };
                (b, bands[b].clone(), None)
            }
            "era" => {
                let b = record
                    .created_year
                    .map(|y| ((y - first) / era_width) as usize)
                    .unwrap_or(eras.len());
                (b, bands[b].clone(), None)
            }
            _ => (0, "identity".into(), None),
        };
        placements.push(Placement {
            repository: record.evidence.name.clone(),
            category,
            band,
            sector,
            strength,
            position: [0.0; 2],
        });
    }
    let mut groups: BTreeMap<(usize, Option<usize>), Vec<usize>> = BTreeMap::new();
    for (i, p) in placements.iter().enumerate() {
        groups.entry((p.band, p.sector)).or_default().push(i);
    }
    let spread_x = match (input.round, input.compact) {
        (true, true) => 88.0,
        (true, false) => 192.0,
        _ => 368.0,
    };
    let radii: Vec<_> = (0..bands.len())
        .map(|b| 0.38 + 0.59 * b as f64 / (bands.len() - 1).max(1) as f64)
        .collect();
    for ((band, sector), indices) in groups {
        for (j, i) in indices.iter().enumerate() {
            let fraction = (j as f64 + 0.5) / indices.len() as f64;
            let angle = if let Some(s) = sector {
                -TAU / 4.0 + TAU * s as f64 / 6.0 + (fraction - 0.5) * TAU / 7.0
            } else {
                -TAU / 4.0 + fraction * TAU
            } + input.rotations[if input.mode == "capability" {
                0
            } else {
                band.min(3)
            }]
            .to_radians();
            placements[*i].position = [
                round(450.0 + spread_x * radii[band] * angle.cos()),
                round(
                    if input.compact { 126.0 } else { 270.0 }
                        + if input.compact { 88.0 } else { 192.0 } * radii[band] * angle.sin(),
                ),
            ];
        }
    }
    let core = if input.compact { 13.0 } else { 23.0 };
    let rays = profile
        .dimensions
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let a = -TAU / 4.0 + TAU * (i as f64 + 0.5) / 6.0;
            let point = |r: f64| [round(r * a.cos()), round(r * a.sin())];
            Ray {
                dimension: d.id.clone(),
                start: point(core + 5.0),
                end: point(core + 5.0 + 30.0 * d.score),
                label: point(core + 46.0),
            }
        })
        .collect();
    let cy = if input.compact { 126.0 } else { 270.0 };
    let sy = if input.compact { 88.0 } else { 192.0 };
    let mut guides: Vec<_> = bands
        .iter()
        .enumerate()
        .map(|(i, text)| Guide {
            text: format!("{}: {}", i + 1, text),
            position: [
                round(458.0 + spread_x / 2.0 * radii[i]),
                round(cy - sy * radii[i] * (TAU / 12.0).cos()),
            ],
        })
        .collect();
    if input.mode == "capability" {
        for (i, id) in DIMENSIONS.iter().enumerate() {
            let angle = -TAU / 4.0 + TAU * i as f64 / 6.0 + input.rotations[0].to_radians();
            guides.push(Guide {
                text: (*id).into(),
                position: [
                    round(450.0 + 380.0 * angle.cos()),
                    round(cy + (sy + 12.0) * angle.sin()),
                ],
            });
        }
    }
    Ok(Output {
        mode: input.mode,
        profile,
        placements,
        rays,
        bands,
        radii,
        guides,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_extreme_and_rotated_geometry_is_bounded() {
        for mode in ["identity", "capability", "showcase", "activity", "era"] {
            assert!(run(mode, serde_json::json!([])).placements.is_empty());
            let data = serde_json::json!({"mode":mode,"reference_day":2932896,"compact":true,"rotations":[3600,-3600,0,42],"repositories":(0..256).map(|i|serde_json::json!({"name":format!("repo/{i}"),"topics":["api","cli","react"],"created_year":1970+i*30,"updated_day":i*100})).collect::<Vec<_>>()});
            let output = layout(serde_json::from_value(data).unwrap()).unwrap();
            assert!(output.bands.len() <= 6);
            for p in output.placements {
                assert!((32.0..=868.0).contains(&p.position[0]));
                assert!((28.0..=220.0).contains(&p.position[1]));
            }
        }
        for (reference, rotation) in [(-1, 0.0), (20000, f64::INFINITY), (20000, 3601.0)] {
            let input = Input {
                repositories: vec![],
                mode: "era".into(),
                reference_day: reference,
                compact: false,
                rotations: [rotation; 4],
                round: false,
            };
            assert!(layout(input).is_err());
        }
    }
    fn run(mode: &str, records: serde_json::Value) -> Output {
        layout(
            serde_json::from_value(
                serde_json::json!({"mode":mode,"reference_day":20000,"repositories":records}),
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn mixed_missing_and_deterministic() {
        let records = serde_json::json!([{"name":"b","topics":["api","react"]},{"name":"a"}]);
        let a = run("capability", records.clone());
        let b = run("capability", records);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        assert_eq!(a.placements[0].category, "no evidence");
        assert_eq!(a.placements[1].category, "interface");
        assert_eq!(a.placements[1].band, 1);
        assert_eq!(a.placements[1].position, [450.0, 159.28]);
        assert!(a
            .placements
            .iter()
            .flat_map(|p| p.position)
            .all(f64::is_finite));
    }
    #[test]
    fn roles_and_date_boundaries() {
        for (i, role) in ["featured", "supporting", "experimental", "historical", ""]
            .iter()
            .enumerate()
        {
            assert_eq!(
                run("showcase", serde_json::json!([{"name":"a","role":role}])).placements[0].band,
                i
            );
        }
        for (age, band) in [
            (0, 0),
            (30, 0),
            (31, 1),
            (180, 1),
            (181, 2),
            (365, 2),
            (366, 3),
            (-1, 4),
        ] {
            assert_eq!(
                run(
                    "activity",
                    serde_json::json!([{"name":"a","updated_day":20000-age}])
                )
                .placements[0]
                    .band,
                band
            );
        }
        let eras = run(
            "era",
            serde_json::json!([{"name":"a","created_year":2019},{"name":"b","created_year":2020},{"name":"c"}]),
        );
        assert_eq!(
            eras.placements.iter().map(|p| p.band).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }
    #[test]
    fn bounded_and_order_independent() {
        let a = run("capability", serde_json::json!([{"name":"b"},{"name":"a"}]));
        let b = run("capability", serde_json::json!([{"name":"a"},{"name":"b"}]));
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        for records in [
            serde_json::json!([{"name":"a"},{"name":"a"}]),
            serde_json::json!((0..257)
                .map(|i| serde_json::json!({"name":i.to_string()}))
                .collect::<Vec<_>>()),
        ] {
            assert!(layout(
                serde_json::from_value(
                    serde_json::json!({"mode":"era","reference_day":20000,"repositories":records})
                )
                .unwrap()
            )
            .is_err());
        }
    }
}
