//! Content profiles augment posts with field-specific authoring and rendering
//! behavior without creating new document kinds.

use crate::frontmatter::FrontMatter;

pub const ARTICLE_ID: &str = "article";
pub const RECIPE_ID: &str = "recipe";
pub const RESEARCH_ID: &str = "research";
pub const VIDEO_ID: &str = "video";
pub const FIELD_JOURNAL_ID: &str = "field-journal";
pub const JOB_ID: &str = "job";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileFieldKind {
    Text,
    Number,
    Duration,
    ProductionStatus,
}

impl ProfileFieldKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Duration => "duration",
            Self::ProductionStatus => "production-status",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileField {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ProfileFieldKind,
    pub help: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContentProfile {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub fields: &'static [ProfileField],
}

const RECIPE_FIELDS: &[ProfileField] = &[
    ProfileField {
        key: "servings",
        label: "Servings",
        kind: ProfileFieldKind::Number,
        help: "Number of servings.",
    },
    ProfileField {
        key: "yield",
        label: "Yield",
        kind: ProfileFieldKind::Text,
        help: "What the recipe makes, such as 12 cookies.",
    },
    ProfileField {
        key: "prepTime",
        label: "Prep time",
        kind: ProfileFieldKind::Duration,
        help: "A readable duration such as 20 min.",
    },
    ProfileField {
        key: "cookTime",
        label: "Cook time",
        kind: ProfileFieldKind::Duration,
        help: "A readable duration such as 1 hour.",
    },
    ProfileField {
        key: "totalTime",
        label: "Total time",
        kind: ProfileFieldKind::Duration,
        help: "Optional total duration.",
    },
    ProfileField {
        key: "cuisine",
        label: "Cuisine",
        kind: ProfileFieldKind::Text,
        help: "Cuisine or food tradition.",
    },
    ProfileField {
        key: "category",
        label: "Category",
        kind: ProfileFieldKind::Text,
        help: "Meal or recipe category.",
    },
    ProfileField {
        key: "calories",
        label: "Calories",
        kind: ProfileFieldKind::Text,
        help: "Free text such as 520 kcal.",
    },
];

const RESEARCH_FIELDS: &[ProfileField] = &[
    ProfileField {
        key: "doi",
        label: "DOI",
        kind: ProfileFieldKind::Text,
        help: "DOI assigned to this work, as a DOI name or https://doi.org URL.",
    },
    ProfileField {
        key: "license",
        label: "License",
        kind: ProfileFieldKind::Text,
        help: "Absolute URL of the license that applies to this work.",
    },
];

const VIDEO_FIELDS: &[ProfileField] = &[
    ProfileField {
        key: "productionStatus",
        label: "Production status",
        kind: ProfileFieldKind::ProductionStatus,
        help: "Idea, scripting, storyboarding, generating, editing, scheduled, or released.",
    },
    ProfileField {
        key: "seasonNumber",
        label: "Season number",
        kind: ProfileFieldKind::Number,
        help: "Optional season number used in the production summary.",
    },
    ProfileField {
        key: "episodeNumber",
        label: "Episode number",
        kind: ProfileFieldKind::Number,
        help: "Optional episode number used in the production summary.",
    },
    ProfileField {
        key: "productionCredits",
        label: "Production credits",
        kind: ProfileFieldKind::Text,
        help: "Concise creator, direction, animation, or editing credits.",
    },
    ProfileField {
        key: "videoUrl",
        label: "YouTube URL",
        kind: ProfileFieldKind::Text,
        help: "Public YouTube watch, short, or Shorts URL.",
    },
    ProfileField {
        key: "duration",
        label: "Duration",
        kind: ProfileFieldKind::Duration,
        help: "Readable duration such as 12 min 34 sec.",
    },
    ProfileField {
        key: "thumbnail",
        label: "Video thumbnail",
        kind: ProfileFieldKind::Text,
        help: "Site-relative or absolute thumbnail URL for video discovery.",
    },
    ProfileField {
        key: "aiDisclosure",
        label: "AI assistance disclosure",
        kind: ProfileFieldKind::Text,
        help: "A concise, creator-authored note describing meaningful AI assistance.",
    },
];

const FIELD_JOURNAL_FIELDS: &[ProfileField] = &[
    ProfileField {
        key: "activity",
        label: "Activity",
        kind: ProfileFieldKind::Text,
        help: "Activity type, such as Hike, Paddle, or Field survey.",
    },
    ProfileField {
        key: "location",
        label: "Location",
        kind: ProfileFieldKind::Text,
        help: "A publishable place name; avoid sensitive or private locations.",
    },
    ProfileField {
        key: "locationPrivacy",
        label: "Location privacy",
        kind: ProfileFieldKind::Text,
        help: "exact, trimmed, approximate, or hidden. Hidden is the safe default.",
    },
    ProfileField {
        key: "distanceKm",
        label: "Distance (km)",
        kind: ProfileFieldKind::Number,
        help: "Route distance in kilometres.",
    },
    ProfileField {
        key: "elevationGainM",
        label: "Elevation gain (m)",
        kind: ProfileFieldKind::Number,
        help: "Accumulated elevation gain in metres.",
    },
    ProfileField {
        key: "duration",
        label: "Duration",
        kind: ProfileFieldKind::Duration,
        help: "Readable duration such as 2 hr 15 min.",
    },
    ProfileField {
        key: "conditions",
        label: "Conditions",
        kind: ProfileFieldKind::Text,
        help: "Creator-observed weather, trail, water, or habitat conditions.",
    },
];

const PROFILES: &[ContentProfile] = &[
    ContentProfile {
        id: ARTICLE_ID,
        label: "Article",
        description: "A general-purpose article with standard publishing metadata.",
        fields: &[],
    },
    ContentProfile {
        id: RECIPE_ID,
        label: "Recipe",
        description: "A recipe with ingredients, steps, timing, servings, and structured data.",
        fields: RECIPE_FIELDS,
    },
    ContentProfile {
        id: RESEARCH_ID,
        label: "Research",
        description: "A research article with portable references and scholarly metadata.",
        fields: RESEARCH_FIELDS,
    },
    ContentProfile {
        id: VIDEO_ID,
        label: "Video production",
        description: "A video companion page with production metadata and discovery markup.",
        fields: VIDEO_FIELDS,
    },
    ContentProfile {
        id: FIELD_JOURNAL_ID,
        label: "Field journal",
        description:
            "An outdoor field note with route, conditions, observations, and location privacy.",
        fields: FIELD_JOURNAL_FIELDS,
    },
    ContentProfile {
        id: JOB_ID,
        label: "Job",
        description: "One piece of completed trade work: trade, service, town, dates, and before and after images.",
        fields: &[],
    },
];

pub fn catalog() -> &'static [ContentProfile] {
    PROFILES
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileBehavior {
    Article,
    Recipe,
    Research,
    Video,
    FieldJournal,
    Job,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileResolution {
    pub id: String,
    pub behavior: ProfileBehavior,
    pub warnings: Vec<String>,
}

/// Resolve the profile used by a post, including recipe markers supported by
/// earlier open.blog releases.
pub fn resolve(front_matter: &FrontMatter) -> ProfileResolution {
    if let Some(authored_id) = canonical_id(front_matter) {
        let normalized_id = authored_id.to_ascii_lowercase();
        let known = is_known(&normalized_id);
        let id = if known {
            normalized_id.clone()
        } else {
            authored_id
        };
        let behavior = match normalized_id.as_str() {
            RECIPE_ID => ProfileBehavior::Recipe,
            RESEARCH_ID => ProfileBehavior::Research,
            VIDEO_ID => ProfileBehavior::Video,
            FIELD_JOURNAL_ID => ProfileBehavior::FieldJournal,
            JOB_ID => ProfileBehavior::Job,
            _ => ProfileBehavior::Article,
        };
        let mut warnings = Vec::new();
        if !known {
            warnings.push(format!(
                "unknown content profile `{id}`; rendering as an article"
            ));
        }
        if legacy_recipe(front_matter) && behavior != ProfileBehavior::Recipe {
            warnings.push(format!("profile `{id}` overrides the legacy recipe marker"));
        }
        return ProfileResolution {
            id,
            behavior,
            warnings,
        };
    }
    if legacy_recipe(front_matter) {
        return ProfileResolution {
            id: RECIPE_ID.into(),
            behavior: ProfileBehavior::Recipe,
            warnings: Vec::new(),
        };
    }
    ProfileResolution {
        id: ARTICLE_ID.into(),
        behavior: ProfileBehavior::Article,
        warnings: Vec::new(),
    }
}

fn is_known(id: &str) -> bool {
    catalog().iter().any(|profile| profile.id == id)
}

fn canonical_id(front_matter: &FrontMatter) -> Option<String> {
    front_matter
        .get("profile")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn legacy_recipe(front_matter: &FrontMatter) -> bool {
    front_matter.get_bool("recipe") == Some(true)
        || ["type", "layout", "kind"]
            .iter()
            .filter_map(|key| front_matter.get(key))
            .any(|value| value.trim().eq_ignore_ascii_case(RECIPE_ID))
}
