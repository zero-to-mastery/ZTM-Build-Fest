//! The jobs archive: `/jobs/`, one archive per trade, and one per service
//! within a trade (ADR 0286). Pure grouping of the site's job posts; the
//! renderer turns each archive into pages the way it does for tags.

use std::collections::BTreeMap;

use crate::model::{humanize, Site};

pub const JOBS_URL: &str = "/jobs/";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobArchiveKind {
    All,
    Trade,
    Service,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobArchive {
    pub kind: JobArchiveKind,
    /// The address of the first page, ending in `/`.
    pub url: String,
    pub title: String,
    pub description: String,
    pub trade: Option<String>,
    pub service: Option<String>,
    /// Indices into `Site::posts`, newest first.
    pub posts: Vec<usize>,
}

impl JobArchive {
    /// How many pages the archive needs at `per_page` posts a page (0 means
    /// one page with everything).
    pub fn page_count(&self, per_page: usize) -> usize {
        if per_page == 0 {
            1
        } else {
            self.posts.len().div_ceil(per_page).max(1)
        }
    }

    pub fn page_url(&self, page_number: usize) -> String {
        if page_number <= 1 {
            self.url.clone()
        } else {
            format!("{}page/{page_number}/", self.url)
        }
    }
}

/// Every archive the site's jobs call for: all jobs, then each trade in
/// name order, then each trade's services in name order. A site with no jobs
/// gets none, so nothing empty is ever emitted.
pub fn plan(site: &Site) -> Vec<JobArchive> {
    let mut all = Vec::new();
    let mut trades: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut services: BTreeMap<(&str, &str), Vec<usize>> = BTreeMap::new();
    for (index, post) in site.posts.iter().enumerate() {
        let Some(job) = &post.job else { continue };
        all.push(index);
        trades.entry(&job.trade).or_default().push(index);
        services
            .entry((&job.trade, &job.service))
            .or_default()
            .push(index);
    }
    if all.is_empty() {
        return Vec::new();
    }
    let mut archives = vec![JobArchive {
        kind: JobArchiveKind::All,
        url: JOBS_URL.into(),
        title: "Jobs".into(),
        description: "Finished work, newest first.".into(),
        trade: None,
        service: None,
        posts: all,
    }];
    for (trade, posts) in trades {
        let name = humanize(trade);
        archives.push(JobArchive {
            kind: JobArchiveKind::Trade,
            url: format!("{JOBS_URL}{trade}/"),
            title: format!("{name} jobs"),
            description: format!("Finished {} work, newest first.", name.to_lowercase()),
            trade: Some(trade.into()),
            service: None,
            posts,
        });
    }
    for ((trade, service), posts) in services {
        let (trade_name, service_name) = (humanize(trade), humanize(service));
        archives.push(JobArchive {
            kind: JobArchiveKind::Service,
            url: format!("{JOBS_URL}{trade}/{service}/"),
            title: format!("{service_name} ({trade_name})"),
            description: format!(
                "Finished {} jobs in {}, newest first.",
                service_name.to_lowercase(),
                trade_name.to_lowercase()
            ),
            trade: Some(trade.into()),
            service: Some(service.into()),
            posts,
        });
    }
    archives
}
