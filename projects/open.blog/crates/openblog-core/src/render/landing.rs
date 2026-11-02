//! The home page built from landing sections (ADR 0247, #324).
//!
//! Every section renders from the validated [`LandingPage`] alone, as
//! theme-neutral `ob-home-*` markup that reads nothing but `--ob-*` tokens.
//! Every field is escaped. Rich text, FAQ answers and call-out bodies go
//! through [`render_inert_markdown`], so a tag typed into any of them is shown
//! as text. A link address is checked again here, so a page built in code is
//! held to the rule a parsed file is.
//!
//! The home page has exactly one `<h1>` and its headings never skip a level:
//! the first section that has a heading of its own (a welcome banner, latest
//! posts, series or a featured post with a heading) takes the `<h1>`; if text
//! or a piece comes before any of those, the site title takes it first. Every
//! other section heading is an `<h2>`, and Markdown headings are set as `<h2>`
//! in rich text and as bold text inside a call-out or an answer.

use crate::escape::{attr, text};
use crate::landing::{
    render_inert_markdown, BusinessFacts, Callout, Contact, Faq, FeaturedPost, ImageSection,
    LandingPage, LatestPosts, MapSection, OpeningHours, RichText, Section, SectionKind,
    SeriesSection, SocialLinks, Video, Welcome,
};
use crate::theme::Theme;

use super::piece::{self, Mode};
use super::Renderer;

/// What a section needs from the page while it renders.
struct Context<'t> {
    theme: &'t Theme,
    /// Posts a latest-posts section lists when it does not say.
    per_page: usize,
    /// Pages of older posts, for the pager under the first latest-posts list.
    page_count: usize,
    /// Whether the page's `<h1>` has been written.
    h1: bool,
    /// Whether a latest-posts section has been written.
    latest_seen: bool,
}

impl Context<'_> {
    /// The level the next section heading takes, and the claim on the `<h1>`.
    fn take_level(&mut self) -> u8 {
        if self.h1 {
            2
        } else {
            self.h1 = true;
            1
        }
    }
}

impl Renderer<'_> {
    /// The landing sections, in order, ready to sit inside the container.
    pub(super) fn landing_sections(
        &self,
        theme: &Theme,
        landing: &LandingPage,
        per_page: usize,
        page_count: usize,
    ) -> String {
        let mut cx = Context {
            theme,
            per_page,
            page_count,
            h1: false,
            latest_seen: false,
        };
        let mut out = String::new();
        let mut pager_used = false;
        for section in landing.sections.iter().filter(|s| !s.hidden) {
            let before = cx.h1;
            let mut html = self.landing_section(&mut cx, section, &mut pager_used);
            if html.is_empty() {
                continue;
            }
            if !before && !cx.h1 {
                // Text or a piece before any heading of its own: the site
                // title is the page's primary heading, written first.
                html.insert_str(0, &self.site_title_heading(&mut cx));
            }
            out.push_str(&html);
        }
        if !cx.h1 {
            out.insert_str(0, &self.site_title_heading(&mut cx));
        }
        out
    }

    fn site_title_heading(&self, cx: &mut Context<'_>) -> String {
        cx.h1 = true;
        self.heading(
            cx.theme,
            1,
            &self.site.config.title,
            "ob-section-heading ob-home-title",
        )
    }

    /// A heading that names its section: `id` on the heading, and the level
    /// from the page's heading order.
    fn landing_heading(&self, cx: &mut Context<'_>, id: &str, label: &str) -> String {
        let level = cx.take_level();
        self.heading(cx.theme, level, label, "ob-section-heading")
            .replace(
                &format!("<h{level} class=\"ob-title\""),
                &format!(
                    "<h{level} id=\"ob-home-{}-title\" class=\"ob-title\"",
                    attr(id)
                ),
            )
    }

    fn landing_wrap(&self, section: &Section, labelled: bool, inner: &str, extra: &str) -> String {
        let id = attr(&section.id);
        let labelled = if labelled {
            format!(" aria-labelledby=\"ob-home-{id}-title\"")
        } else {
            String::new()
        };
        format!(
            "<section class=\"ob-section ob-home-section ob-home-{}{extra}\" id=\"ob-home-{id}\"{labelled}>\n{inner}</section>\n",
            section.kind.name()
        )
    }

    fn landing_section(
        &self,
        cx: &mut Context<'_>,
        section: &Section,
        pager_used: &mut bool,
    ) -> String {
        match &section.kind {
            SectionKind::Welcome(v) => self.landing_welcome(cx, section, v),
            SectionKind::RichText(v) => self.landing_rich_text(section, v),
            SectionKind::LatestPosts(v) => self.landing_latest(cx, section, v, pager_used),
            SectionKind::Series(v) => self.landing_series(cx, section, v),
            SectionKind::FeaturedPost(v) => self.landing_featured(cx, section, v),
            SectionKind::Buttons(v) => {
                let actions = piece::buttons(&v.items);
                if actions.is_empty() {
                    String::new()
                } else {
                    self.landing_wrap(section, false, &actions, "")
                }
            }
            SectionKind::Image(v) => self.landing_image(section, v),
            SectionKind::Video(v) => self.landing_video(section, v),
            SectionKind::Map(v) => self.landing_map(section, v),
            SectionKind::OpeningHours(v) => self.landing_hours(section, v),
            SectionKind::Contact(v) => self.landing_contact(section, v),
            SectionKind::SocialLinks(v) => self.landing_social(section, v),
            SectionKind::Faq(v) => self.landing_faq(section, v),
            SectionKind::Callout(v) => self.landing_callout(section, v),
            SectionKind::BusinessFacts(v) => self.landing_business(cx, section, v),
        }
    }

    fn landing_welcome(&self, cx: &mut Context<'_>, section: &Section, v: &Welcome) -> String {
        let mut inner = self.landing_heading(cx, &section.id, &v.heading);
        if !v.subheading.trim().is_empty() {
            inner.push_str(&format!(
                "<p class=\"ob-home-lede\">{}</p>\n",
                text(&v.subheading)
            ));
        }
        if let Some(image) = &v.image {
            inner.push_str(&piece::picture_tag(&image.src, &image.alt, false));
        }
        if let Some(button) = &v.button {
            inner.push_str(&piece::buttons(std::slice::from_ref(button)));
        }
        self.landing_wrap(section, true, &inner, "")
    }

    fn landing_rich_text(&self, section: &Section, v: &RichText) -> String {
        if v.markdown.trim().is_empty() {
            return String::new();
        }
        let html = render_inert_markdown(&v.markdown, 2);
        self.landing_wrap(section, false, &html, " ob-prose")
    }

    fn landing_latest(
        &self,
        cx: &mut Context<'_>,
        section: &Section,
        v: &LatestPosts,
        pager_used: &mut bool,
    ) -> String {
        let shown = v
            .count
            .map_or(cx.per_page, |count| count as usize)
            .min(self.site.posts.len());
        let indices: Vec<usize> = (0..shown).collect();
        let mut inner = self.landing_heading(cx, &section.id, &v.heading);
        inner.push_str(&self.post_list(cx.theme, &indices));
        // The pager continues the list only where page 2 starts after it, and
        // only once, under the first list that does.
        if !*pager_used && cx.page_count > 1 && shown == cx.per_page {
            *pager_used = true;
            inner.push_str(&self.pager(1, cx.page_count));
        } else if !cx.latest_seen && self.site.posts.len() > shown {
            // The first list stops short of the rest and carries no pager:
            // a plain link keeps every post reachable.
            inner.push_str("<p class=\"ob-home-all\"><a class=\"ob-home-link\" href=\"/archive/\">All posts</a></p>
");
        }
        cx.latest_seen = true;
        self.landing_wrap(section, true, &inner, "")
    }

    fn landing_series(&self, cx: &mut Context<'_>, section: &Section, v: &SeriesSection) -> String {
        if !self.site.series.iter().any(|s| !s.posts.is_empty()) {
            return String::new();
        }
        let mut inner = self.landing_heading(cx, &section.id, &v.heading);
        inner.push_str(&self.series_cards(cx.theme));
        inner.push('\n');
        self.landing_wrap(section, true, &inner, "")
    }

    /// The business facts from `openblog.json` under their own heading; nothing when none are stated.
    fn landing_business(
        &self,
        cx: &mut Context<'_>,
        section: &Section,
        v: &BusinessFacts,
    ) -> String {
        let block = self.site.config.business.block_html();
        if block.is_empty() {
            return String::new();
        }
        let mut inner = self.landing_heading(cx, &section.id, &v.heading);
        inner.push_str(&block);
        self.landing_wrap(section, true, &inner, "")
    }

    fn landing_featured(
        &self,
        cx: &mut Context<'_>,
        section: &Section,
        v: &FeaturedPost,
    ) -> String {
        let Some(index) = self.site.posts.iter().position(|p| p.slug == v.post) else {
            return String::new();
        };
        let labelled = !v.heading.trim().is_empty();
        let mut inner = String::new();
        if labelled {
            inner.push_str(&self.landing_heading(cx, &section.id, &v.heading));
        }
        inner.push_str(&self.post_list(cx.theme, &[index]));
        self.landing_wrap(section, labelled, &inner, "")
    }

    fn landing_image(&self, section: &Section, v: &ImageSection) -> String {
        self.landing_piece(section, piece::image(v), "")
    }

    fn landing_video(&self, section: &Section, v: &Video) -> String {
        self.landing_piece(section, piece::video(v, Mode::Page), "")
    }

    fn landing_map(&self, section: &Section, v: &MapSection) -> String {
        self.landing_piece(section, piece::map(v, Mode::Page), "")
    }

    /// A piece's markup in its section, or nothing when it has none to show.
    fn landing_piece(&self, section: &Section, inner: String, extra: &str) -> String {
        if inner.is_empty() {
            String::new()
        } else {
            self.landing_wrap(section, false, &inner, extra)
        }
    }

    fn landing_hours(&self, section: &Section, v: &OpeningHours) -> String {
        self.landing_piece(section, piece::hours(v), "")
    }

    fn landing_contact(&self, section: &Section, v: &Contact) -> String {
        self.landing_piece(section, piece::contact(v), "")
    }

    fn landing_social(&self, section: &Section, v: &SocialLinks) -> String {
        self.landing_piece(section, piece::social(v), "")
    }

    fn landing_faq(&self, section: &Section, v: &Faq) -> String {
        self.landing_piece(section, piece::faq(v), "")
    }

    fn landing_callout(&self, section: &Section, v: &Callout) -> String {
        let extra = format!(" ob-home-callout-{}", v.tone.value());
        self.landing_piece(section, piece::callout(v), &extra)
    }
}
