use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const DIMENSIONS: [&str; 6] = [
    "interface",
    "services",
    "data",
    "systems",
    "tooling",
    "automation",
];

#[derive(Deserialize)]
pub struct Input {
    pub repositories: Vec<Repository>,
}

#[derive(Clone, Deserialize)]
pub struct Repository {
    pub name: String,
    #[serde(default)]
    pub languages: BTreeMap<String, f64>,
    #[serde(default)]
    pub language_names: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub role: String,
}

#[derive(Serialize)]
pub struct Evidence {
    pub repository: String,
    pub reason: String,
    pub contribution: f64,
}

#[derive(Serialize)]
pub struct Dimension {
    pub id: String,
    pub score: f64,
    pub evidence: Vec<Evidence>,
}

#[derive(Serialize)]
pub struct RepositoryAffinity {
    pub repository: String,
    pub dimensions: Vec<f64>,
}

#[derive(Serialize)]
pub struct NodeAffinity {
    pub node: String,
    pub dimensions: Vec<f64>,
}

#[derive(Serialize)]
pub struct Profile {
    pub dimensions: Vec<Dimension>,
    pub repositories: Vec<RepositoryAffinity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<NodeAffinity>,
    pub signature: String,
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn contains_any(values: &[String], candidates: &[&str]) -> bool {
    values.iter().any(|value| {
        let value = normalized(value);
        candidates.iter().any(|candidate| value == *candidate)
    })
}

fn role_weight(role: &str) -> f64 {
    match role {
        "featured" => 1.35,
        "supporting" => 1.0,
        "experimental" => 0.65,
        "historical" => 0.4,
        "" => 0.85,
        _ => 0.85,
    }
}

fn normalized_language(value: &str) -> String {
    // Language punctuation carries meaning: C, C++ and C# are distinct.
    normalized(&value.replace('+', "plus").replace('#', "sharp"))
}

fn language_share(repository: &Repository, candidates: &[&str]) -> f64 {
    let total: f64 = repository
        .languages
        .values()
        .filter(|value| value.is_finite() && **value > 0.0)
        .sum();
    if total > 0.0 {
        return repository
            .languages
            .iter()
            .filter(|(name, value)| {
                candidates
                    .iter()
                    .any(|candidate| normalized_language(name) == normalized_language(candidate))
                    && value.is_finite()
                    && **value > 0.0
            })
            .map(|(_, value)| *value / total)
            .sum::<f64>()
            .clamp(0.0, 1.0);
    }
    let names: BTreeSet<_> = repository
        .language_names
        .iter()
        .map(|name| normalized_language(name))
        .filter(|name| !name.is_empty())
        .collect();
    let matching = names
        .iter()
        .filter(|name| {
            candidates
                .iter()
                .any(|candidate| **name == normalized_language(candidate))
        })
        .count();
    matching as f64 / names.len().max(1) as f64
}

fn language_names_for(repository: &Repository, candidates: &[&str]) -> Vec<String> {
    if repository
        .languages
        .values()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return repository
            .languages
            .iter()
            .filter(|(name, value)| {
                value.is_finite()
                    && **value > 0.0
                    && candidates.iter().any(|candidate| {
                        normalized_language(name) == normalized_language(candidate)
                    })
            })
            .map(|(name, _)| name.clone())
            .collect();
    }
    repository
        .language_names
        .iter()
        .filter(|name| {
            candidates
                .iter()
                .any(|candidate| normalized_language(name) == normalized_language(candidate))
        })
        .cloned()
        .collect()
}

fn dimensions_for(repository: &Repository) -> Vec<(f64, Vec<String>)> {
    let topics: Vec<_> = repository
        .topics
        .iter()
        .map(|topic| normalized(topic))
        .collect();
    let mut result = vec![(0.0, Vec::new()); DIMENSIONS.len()];
    let mut add = |index: usize, value: f64, reason: String| {
        if value > 0.0 {
            result[index].0 += value;
            result[index].1.push(reason);
        }
    };

    let interface_topics = [
        "frontend",
        "interface",
        "ui",
        "webcomponents",
        "accessibility",
        "designsystem",
        "react",
        "vue",
        "svelte",
        "angular",
        "css",
        "html",
    ];
    let service_topics = [
        "backend",
        "server",
        "api",
        "rest",
        "graphql",
        "authentication",
        "websocket",
        "express",
        "nodejs",
        "services",
    ];
    let data_topics = [
        "database",
        "postgresql",
        "postgres",
        "sqlite",
        "mysql",
        "mongodb",
        "prisma",
        "orm",
        "analytics",
        "etl",
        "dataprocessing",
    ];
    let system_topics = [
        "systemsprogramming",
        "native",
        "performance",
        "wasm",
        "webassembly",
        "embedded",
        "operatingsystems",
        "compiler",
    ];
    let tooling_topics = [
        "cli",
        "developer-tools",
        "developertools",
        "library",
        "testing",
        "buildtools",
        "codegeneration",
        "linter",
        "developerutilities",
        "tooling",
    ];
    let automation_topics = [
        "github-actions",
        "githubactions",
        "cicd",
        "deployment",
        "docker",
        "infrastructure",
        "automation",
        "scripting",
        "releaseautomation",
        "platform",
    ];
    let topic_sets = [
        &interface_topics[..],
        &service_topics[..],
        &data_topics[..],
        &system_topics[..],
        &tooling_topics[..],
        &automation_topics[..],
    ];
    for (index, candidates) in topic_sets.iter().enumerate() {
        let matched: Vec<_> = repository
            .topics
            .iter()
            .filter(|topic| {
                let normalized_topic = normalized(topic);
                candidates
                    .iter()
                    .any(|candidate| normalized_topic == normalized(candidate))
            })
            .cloned()
            .collect();
        if !matched.is_empty() {
            add(index, 0.7, format!("topic: {}", matched.join(", ")));
        }
    }

    let interface_languages = ["html", "css", "scss", "sass", "vue", "svelte"];
    let interface_share = language_share(repository, &interface_languages);
    add(
        0,
        interface_share * 0.8,
        format!(
            "language: {}",
            language_names_for(repository, &interface_languages).join(", ")
        ),
    );
    let app_languages = language_share(repository, &["typescript", "javascript", "jsx", "tsx"]);
    if contains_any(&topics, &interface_topics) {
        let names = language_names_for(repository, &["typescript", "javascript", "jsx", "tsx"]);
        if !names.is_empty() {
            add(
                0,
                app_languages * 0.45,
                format!("language: {} paired with interface topic", names.join(", ")),
            );
        }
    }

    let service_languages = ["go", "java", "kotlin", "php", "ruby", "csharp"];
    let service_share = language_share(repository, &service_languages);
    add(
        1,
        service_share * 0.22,
        format!(
            "service language: {}",
            language_names_for(repository, &service_languages).join(", ")
        ),
    );
    if contains_any(&topics, &service_topics) && app_languages > 0.0 {
        let names = language_names_for(repository, &["typescript", "javascript", "jsx", "tsx"]);
        add(
            1,
            app_languages * 0.35,
            format!("language: {} paired with service topic", names.join(", ")),
        );
    }

    let data_languages = ["sql", "plpgsql"];
    let data_share = language_share(repository, &data_languages);
    add(
        2,
        data_share * 0.75,
        format!(
            "data language: {}",
            language_names_for(repository, &data_languages).join(", ")
        ),
    );

    let systems_languages = ["rust", "c", "c++", "assembly", "zig"];
    let systems_share = language_share(repository, &systems_languages);
    add(
        3,
        systems_share * 0.8,
        format!(
            "systems language: {}",
            language_names_for(repository, &systems_languages).join(", ")
        ),
    );
    let go_share = language_share(repository, &["go"]);
    if go_share > 0.0 {
        add(3, go_share * 0.22, "systems language: Go".into());
    }

    let tooling_languages = ["rust", "python", "javascript", "typescript"];
    let tooling_share = language_share(repository, &tooling_languages);
    if contains_any(&topics, &tooling_topics) {
        let names = language_names_for(repository, &tooling_languages);
        add(
            4,
            tooling_share * 0.35,
            format!("language: {} paired with tooling topic", names.join(", ")),
        );
    }

    let automation_languages = ["shell", "bash", "powershell", "makefile", "nix"];
    let automation_share = language_share(repository, &automation_languages);
    add(
        5,
        automation_share * 0.7,
        format!(
            "automation language: {}",
            language_names_for(repository, &automation_languages).join(", ")
        ),
    );
    if contains_any(&topics, &automation_topics) {
        let script_languages = ["python", "javascript", "typescript"];
        let script_share = language_share(repository, &script_languages);
        let names = language_names_for(repository, &script_languages);
        if script_share > 0.0 {
            add(
                5,
                script_share * 0.25,
                format!(
                    "language: {} paired with automation topic",
                    names.join(", ")
                ),
            );
        }
    }

    result
}

pub fn analyze(input: Input) -> Result<Profile, String> {
    if input.repositories.len() > 256 {
        return Err("At most 256 repositories are supported".into());
    }
    let mut totals = [0.0; 6];
    let mut evidence: Vec<Vec<Evidence>> = (0..6).map(|_| Vec::new()).collect();
    let mut repositories = Vec::with_capacity(input.repositories.len());
    let mut total_text_bytes = 0usize;

    for repository in &input.repositories {
        if repository.name.is_empty() || repository.name.len() > 512 {
            return Err("Repository names must contain 1 to 512 bytes".into());
        }
        if repository.languages.len() > 100
            || repository.language_names.len() > 100
            || repository.topics.len() > 200
            || repository.topics.iter().any(|topic| topic.len() > 200)
            || repository
                .language_names
                .iter()
                .any(|language| language.len() > 200)
        {
            return Err(format!("Too much evidence for {}", repository.name));
        }
        if !["", "featured", "supporting", "experimental", "historical"]
            .contains(&repository.role.as_str())
        {
            return Err(format!("Unknown project role for {}", repository.name));
        }
        total_text_bytes += repository.name.len()
            + repository.role.len()
            + repository.topics.iter().map(String::len).sum::<usize>()
            + repository
                .language_names
                .iter()
                .map(String::len)
                .sum::<usize>()
            + repository.languages.keys().map(String::len).sum::<usize>();
        if total_text_bytes > 1_000_000 {
            return Err("Developer profile evidence exceeds 1 MiB".into());
        }
        if repository
            .languages
            .values()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(format!(
                "Invalid language proportions for {}",
                repository.name
            ));
        }
        let role_factor = role_weight(&repository.role);
        let raw = dimensions_for(repository);
        let mut affinity = Vec::with_capacity(6);
        for (index, (base, reasons)) in raw.into_iter().enumerate() {
            let contribution = (base.min(1.0) * role_factor).clamp(0.0, 1.0);
            affinity.push(contribution);
            if contribution > 0.0 {
                totals[index] += contribution;
                let role = if repository.role.is_empty() {
                    "unassigned"
                } else {
                    repository.role.as_str()
                };
                evidence[index].push(Evidence {
                    repository: repository.name.clone(),
                    reason: format!("{}; {} project role weight", reasons.join("; "), role),
                    contribution,
                });
            }
        }
        repositories.push(RepositoryAffinity {
            repository: repository.name.clone(),
            dimensions: affinity,
        });
    }

    let dimensions: Vec<_> = DIMENSIONS
        .iter()
        .enumerate()
        .map(|(index, id)| Dimension {
            id: (*id).into(),
            score: (totals[index] / (totals[index] + 2.0)).clamp(0.0, 1.0),
            evidence: std::mem::take(&mut evidence[index]),
        })
        .collect();
    let mut strongest: Vec<_> = dimensions
        .iter()
        .filter(|dimension| dimension.score >= 0.2)
        .collect();
    strongest.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.id.cmp(&right.id))
    });
    let signature = if strongest.is_empty() {
        "No profile evidence in the selected repositories".into()
    } else {
        format!(
            "Strongest evidence: {}",
            strongest
                .iter()
                .take(3)
                .map(|dimension| dimension.id.as_str())
                .collect::<Vec<_>>()
                .join(" · ")
        )
    };

    Ok(Profile {
        dimensions,
        repositories,
        nodes: Vec::new(),
        signature,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str, language: &str, topics: &[&str], role: &str) -> Repository {
        Repository {
            name: name.into(),
            languages: BTreeMap::from([(language.into(), 100.0)]),
            language_names: vec![],
            topics: topics.iter().map(|topic| (*topic).into()).collect(),
            role: role.into(),
        }
    }

    fn input(repositories: Vec<Repository>) -> Input {
        Input { repositories }
    }

    #[test]
    fn profile_is_deterministic_and_evidence_is_traceable() {
        let data = input(vec![repo(
            "owner/ui",
            "TypeScript",
            &["react", "accessibility"],
            "featured",
        )]);
        let first = serde_json::to_string(&analyze(data).unwrap()).unwrap();
        let second = serde_json::to_string(
            &analyze(input(vec![repo(
                "owner/ui",
                "TypeScript",
                &["react", "accessibility"],
                "featured",
            )]))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(first, second);
        let result = analyze(input(vec![repo(
            "owner/ui",
            "TypeScript",
            &["react"],
            "featured",
        )]))
        .unwrap();
        let interface = result
            .dimensions
            .iter()
            .find(|dimension| dimension.id == "interface")
            .unwrap();
        assert_eq!(interface.evidence[0].repository, "owner/ui");
        assert!(interface.evidence[0].reason.contains("topic"));
    }

    #[test]
    fn language_topics_and_mixed_evidence_are_combined() {
        let result = analyze(input(vec![repo(
            "owner/app",
            "Rust",
            &["react", "api", "cli"],
            "",
        )]))
        .unwrap();
        for expected in ["interface", "services", "systems", "tooling"] {
            assert!(
                result
                    .dimensions
                    .iter()
                    .find(|dimension| dimension.id == expected)
                    .unwrap()
                    .score
                    > 0.0
            );
        }
    }

    #[test]
    fn showcase_roles_are_bounded_weights_and_unassigned_work_still_counts() {
        let score = |role| {
            analyze(input(vec![repo("owner/tool", "Rust", &["cli"], role)]))
                .unwrap()
                .dimensions
                .iter()
                .find(|dimension| dimension.id == "systems")
                .unwrap()
                .score
        };
        assert!(score("featured") > score("supporting"));
        assert!(score("supporting") > score("experimental"));
        assert!(score("experimental") > score("historical"));
        assert!(score("supporting") > 0.0);
    }

    #[test]
    fn empty_missing_and_unknown_evidence_produce_no_invented_profile() {
        let empty = analyze(input(vec![])).unwrap();
        assert!(empty
            .dimensions
            .iter()
            .all(|dimension| dimension.score == 0.0 && dimension.evidence.is_empty()));
        let unknown = Repository {
            name: "owner/unknown".into(),
            languages: BTreeMap::new(),
            language_names: vec!["MadeUp".into()],
            topics: vec!["misc".into()],
            role: "".into(),
        };
        assert!(analyze(input(vec![unknown]))
            .unwrap()
            .dimensions
            .iter()
            .all(|dimension| dimension.score == 0.0));
    }

    #[test]
    fn language_shares_normalize_and_missing_details_fall_back_to_names() {
        let mut mixed = repo("owner/mixed", "", &[], "");
        mixed.languages = BTreeMap::from([("Rust".into(), 75.0), ("HTML".into(), 25.0)]);
        let profile = analyze(input(vec![mixed])).unwrap();
        let systems = profile.repositories[0].dimensions[3];
        let interface = profile.repositories[0].dimensions[0];
        assert!(systems > interface);
        let fallback = analyze(input(vec![repo("owner/html", "HTML", &[], "")])).unwrap();
        assert!(fallback.repositories[0].dimensions[0] > 0.0);
    }

    #[test]
    fn csharp_is_service_evidence_not_c_or_cpp_systems_evidence() {
        for language in ["C#", "csharp", "C-Sharp"] {
            let profile = analyze(input(vec![repo("owner/service", language, &[], "")])).unwrap();
            assert!(profile.repositories[0].dimensions[1] > 0.0, "{language}");
            assert_eq!(profile.repositories[0].dimensions[3], 0.0, "{language}");
        }
        for language in ["C", "C++"] {
            let profile = analyze(input(vec![repo("owner/native", language, &[], "")])).unwrap();
            assert_eq!(profile.repositories[0].dimensions[1], 0.0, "{language}");
            assert!(profile.repositories[0].dimensions[3] > 0.0, "{language}");
        }
    }

    #[test]
    fn fallback_counts_each_distinct_language_and_keeps_its_reasons() {
        let mut fallback = repo("owner/web", "HTML", &[], "");
        fallback.languages.clear();
        fallback.language_names = vec!["HTML".into(), "CSS".into(), "Rust".into(), "html".into()];
        let mut measured = repo("owner/web", "HTML", &[], "");
        measured.languages = BTreeMap::from([
            ("HTML".into(), 1.0),
            ("CSS".into(), 1.0),
            ("Rust".into(), 1.0),
        ]);
        let expected = analyze(input(vec![measured])).unwrap().repositories[0]
            .dimensions
            .clone();
        let actual = analyze(input(vec![fallback.clone()])).unwrap();
        assert_eq!(actual.repositories[0].dimensions, expected);
        fallback.languages.insert("HTML".into(), 0.0);
        let zero_bytes = analyze(input(vec![fallback])).unwrap();
        assert_eq!(zero_bytes.repositories[0].dimensions, expected);
        assert!(zero_bytes.dimensions[0].evidence[0].reason.contains("HTML"));
        assert!(zero_bytes.dimensions[0].evidence[0].reason.contains("CSS"));
    }

    #[test]
    fn malformed_or_oversized_inputs_are_rejected() {
        assert!(serde_json::from_str::<Input>("{").is_err());
        assert!(analyze(input(
            (0..257)
                .map(|index| repo(&format!("owner/{index}"), "Rust", &[], ""))
                .collect()
        ))
        .is_err());
        let mut too_many_topics = repo("owner/topics", "Rust", &[], "");
        too_many_topics.topics = (0..201).map(|index| format!("topic-{index}")).collect();
        assert!(analyze(input(vec![too_many_topics])).is_err());
        let mut bad = repo("owner/bad", "Rust", &[], "");
        bad.languages.insert("Rust".into(), -1.0);
        assert!(analyze(input(vec![bad])).is_err());
    }
}
