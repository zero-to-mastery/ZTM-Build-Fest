//! A shared reflection's place in a series (ADR 0038).
//!
//! There is no collaborative-series entity. A placement is the two front matter values an
//! ordinary Post already uses, `series` and `seriesOrder`, so title, description, theme, cover,
//! ordering and navigation all come from the existing series model and the site's own
//! `content/series/<slug>.md`. A participant never writes any of those. What a placement adds to
//! the private record is the reference itself, which is public output and therefore part of what
//! every author approves (ADR 0020).

use crate::collaboration::{
    valid_text, AuthorizationAction, AuthorizationTarget, SharedPublication,
};
use crate::model::Site;
use crate::slug;

/// Front matter keys, identical to the ones an ordinary Post uses.
pub const SERIES_KEY: &str = "series";
pub const SERIES_ORDER_KEY: &str = "seriesOrder";

pub const MAX_SERIES_REFERENCE_BYTES: usize = 120;

/// The series a publication joins and, optionally, its explicit position.
#[derive(Clone, Debug, serde::Deserialize, PartialEq, Eq, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeriesPlacement {
    /// Any title one line long. The site slugifies it exactly as it does a Post's `series`.
    pub series: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

/// Why a placement was refused. It never repeats the submitted value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesError {
    /// Blank, over-long, multi-line, or made of control or direction characters.
    Reference,
    /// The text has no letter or digit, so no series address can be made from it.
    NoAddress,
}

impl std::fmt::Display for SeriesError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Reference => "invalid series title",
            Self::NoAddress => "a series title needs at least one letter or digit",
        })
    }
}

impl std::error::Error for SeriesError {}

impl SeriesPlacement {
    /// Trim and check a placement. Every Unicode title with a letter or digit is accepted.
    pub fn new(series: &str, order: Option<u32>) -> Result<Self, SeriesError> {
        let series = series.trim();
        if !valid_text(series, MAX_SERIES_REFERENCE_BYTES) {
            return Err(SeriesError::Reference);
        }
        if slug::slugify(series).is_empty() {
            return Err(SeriesError::NoAddress);
        }
        Ok(Self {
            series: series.to_string(),
            order,
        })
    }

    pub fn validate(&self) -> Result<(), SeriesError> {
        Self::new(&self.series, self.order).and_then(|clean| {
            if clean == *self {
                Ok(())
            } else {
                Err(SeriesError::Reference)
            }
        })
    }

    /// How a person reads it: "<title>, part N", or the title alone when no position is set.
    pub fn label(&self) -> String {
        match self.order {
            Some(order) => format!("{}, part {order}", self.series),
            None => self.series.clone(),
        }
    }

    /// The approvable form. A tag no user text can contain (control characters are refused)
    /// keeps it from ever equalling a title or source value.
    pub(crate) fn binding_values(&self) -> [String; 2] {
        [
            format!("\u{0}series\u{0}{}", self.series),
            format!(
                "\u{0}seriesOrder\u{0}{}",
                self.order.map(|n| n.to_string()).unwrap_or_default()
            ),
        ]
    }
}

impl SharedPublication {
    /// The record with its series placement set or, with `None`, removed. A change alters
    /// public output, so callers reconcile approvals in the same write (`ApprovalSet::reconcile`);
    /// the binding is recomputed on every read, so a missed call still fails closed.
    pub fn with_series(&self, placement: Option<SeriesPlacement>) -> Result<Self, SeriesError> {
        if let Some(placement) = &placement {
            placement.validate()?;
        }
        let mut record = self.clone();
        record.series = placement;
        Ok(record)
    }

    /// Set, change or remove the placement as `admin_user`, against the placement revision they
    /// read (ADR 0039). Only a holder of [`AuthorizationAction::PlaceInSeries`] may do it. A
    /// request that changes nothing returns the record unchanged, with the same revision. The
    /// caller stores the result and reconciles approvals in the same write (ADR 0038).
    pub fn place_in_series(
        &self,
        admin_user: &str,
        identities: &crate::invitation::Identities<'_>,
        placement: Option<SeriesPlacement>,
        expected_revision: u64,
    ) -> Result<Self, PlacementError> {
        self.authorize(
            admin_user,
            identities,
            AuthorizationAction::PlaceInSeries,
            AuthorizationTarget::Publication,
        )
        .map_err(|_| PlacementError::Denied)?;
        if self.series_revision != expected_revision {
            return Err(PlacementError::Stale);
        }
        if placement == self.series {
            return Ok(self.clone());
        }
        let mut next = self
            .with_series(placement)
            .map_err(PlacementError::Invalid)?;
        next.series_revision = self
            .series_revision
            .checked_add(1)
            .ok_or(PlacementError::Stale)?;
        Ok(next)
    }
}

pub(crate) fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// Why a placement change was refused (ADR 0039). None of them repeats a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementError {
    /// The requester may not arrange this publication. Callers answer it exactly as they answer
    /// an unknown publication.
    Denied,
    /// The placement changed since the requester read it.
    Stale,
    Invalid(SeriesError),
}

/// One existing series a coordinator can choose, from the public site only.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesChoice {
    pub slug: String,
    pub name: String,
    /// Published parts. Drafts, scheduled posts and unpublished shared publications are not in
    /// the public site this is read from, so they are never counted.
    pub parts: usize,
    /// Whether the site has a `content/series/<slug>.md` for it.
    pub defined: bool,
}

/// The series readers of `site` can see, in the site's own listing order.
pub fn series_choices(site: &Site) -> Vec<SeriesChoice> {
    site.series
        .iter()
        .map(|series| SeriesChoice {
            slug: series.slug.clone(),
            name: series.name.clone(),
            parts: series.posts.len(),
            defined: series.source.is_some(),
        })
        .collect()
}

/// One part in a previewed reading order.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPart {
    /// A published part's title and address; absent for this publication, which has neither yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub order: Option<u32>,
    pub this_publication: bool,
}

/// Where a placement would put this publication in its series, read from the public site.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesOrderPreview {
    pub slug: String,
    pub name: String,
    pub defined: bool,
    /// The site owner's plain-text description, empty when there is none.
    pub description: String,
    pub parts: Vec<PreviewPart>,
}

/// The reading order `placement` would produce, by the ordering the site already applies:
/// explicit positions first (ties by date), then unordered parts by date. This publication is not
/// published yet, so it is placed as the newest part. `include_self` is false once it has been
/// published and is already one of the site's posts.
pub fn order_preview(
    site: &Site,
    placement: &SeriesPlacement,
    include_self: bool,
) -> SeriesOrderPreview {
    let slug = slug::slugify(&placement.series);
    let existing = site.series_by_slug(&slug);
    let mut parts: Vec<PreviewPart> = existing
        .map(|series| {
            series
                .posts
                .iter()
                .map(|&index| {
                    let post = &site.posts[index];
                    PreviewPart {
                        title: Some(post.title.clone()),
                        url: Some(post.url.clone()),
                        order: post.series_order,
                        this_publication: false,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if include_self {
        let position = match placement.order {
            Some(order) => parts
                .iter()
                .take_while(|part| part.order.is_some_and(|other| other <= order))
                .count(),
            None => parts.len(),
        };
        parts.insert(
            position,
            PreviewPart {
                title: None,
                url: None,
                order: placement.order,
                this_publication: true,
            },
        );
    }
    SeriesOrderPreview {
        name: existing
            .map(|series| series.name.clone())
            .unwrap_or_else(|| crate::model::humanize(&slug)),
        defined: existing.is_some_and(|series| series.source.is_some()),
        description: existing
            .map(|series| series.description_text.clone())
            .unwrap_or_default(),
        slug,
        parts,
    }
}

pub const MAX_SERIES_PREMISE_BYTES: usize = 500;

/// Why a new series definition was refused. It never repeats a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefinitionError {
    Title(SeriesError),
    /// Over-long, multi-line, or made of control or direction characters.
    Premise,
}

/// A new `content/series/<slug>.md`, written by a site owner (ADR 0039).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesDefinition {
    pub slug: String,
    /// The content-relative path, `series/<slug>.md`.
    pub path: String,
    pub source: String,
}

/// The series file for `title` and an optional one-line recurring premise. The title is checked
/// like a placement reference, so a placement with the same title addresses this file. The
/// premise becomes the `description` and, with every ASCII punctuation character escaped, the
/// page's prose, so it reads exactly as written and never becomes markup.
pub fn series_definition(title: &str, premise: &str) -> Result<SeriesDefinition, DefinitionError> {
    let title = SeriesPlacement::new(title, None).map_err(DefinitionError::Title)?;
    let premise = premise.trim();
    if !premise.is_empty() && !valid_text(premise, MAX_SERIES_PREMISE_BYTES) {
        return Err(DefinitionError::Premise);
    }
    let slug = slug::slugify(&title.series);
    let mut fields = std::collections::BTreeMap::new();
    fields.insert(
        "name".to_string(),
        crate::frontmatter::Value::Scalar(title.series.clone()),
    );
    let mut body = String::new();
    if !premise.is_empty() {
        fields.insert(
            "description".to_string(),
            crate::frontmatter::Value::Scalar(premise.to_string()),
        );
        body = crate::assembly::escape_markdown(premise);
    }
    Ok(SeriesDefinition {
        path: format!("series/{slug}.md"),
        source: crate::frontmatter::compose(&fields, &body),
        slug,
    })
}
