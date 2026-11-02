//! Piece markup, shared by the landing page and posts (ADR 0253, #331).
//!
//! Each function turns validated data into theme-neutral `ob-home-*` markup
//! (the classes the bundled stylesheet already styles) and escapes every
//! value. Addresses are checked again here, so a piece built in code is held
//! to the rule a parsed one is. A function returns an empty string when there
//! is nothing safe to show.
//!
//! **Embeds.** A video or map is a privacy-enhanced, lazy-loaded frame with a
//! title, followed by a plain link to the same thing, so the page still has
//! the link where frames are blocked or cannot run. The frame address is
//! rebuilt from validated parts (a provider and an id, or two coordinates),
//! never copied from the input. In portable output ([`Mode::Portable`]) the
//! frame is dropped and the link stays.

use crate::embed::{self, Embed};
use crate::escape::{attr, text};
use crate::landing::{
    render_inert_markdown, safe_address, Button, ButtonStyle, Callout, Contact, Faq, ImageSection,
    MapProvider, MapSection, OpeningHours, SocialLinks, Video, VideoProvider,
};
use crate::piece::Piece;

/// Where the markup is going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A page of the site: embeds are frames with a link beneath.
    Page,
    /// A portable export: embeds are links.
    Portable,
}

/// A piece in a post: its markup inside a wrapper that names the kind.
pub fn post_piece(piece: &Piece, mode: Mode) -> String {
    let inner = match piece {
        Piece::Button(v) => buttons(std::slice::from_ref(v)),
        Piece::Image(v) => image(v),
        Piece::Video(v) => video(v, mode),
        Piece::Map(v) => map(v, mode),
        Piece::Hours(v) => hours(v),
        Piece::Contact(v) => contact(v),
        Piece::Social(v) => social(v),
        Piece::Faq(v) => faq(v),
        Piece::Callout(v) => callout(v),
    };
    if inner.is_empty() {
        return String::new();
    }
    format!(
        "<div class=\"ob-piece ob-piece-{}\">\n{inner}</div>\n",
        piece.kind()
    )
}

/// An image with its description, or nothing if the address is not one the
/// page may link to.
pub fn picture_tag(src: &str, alt: &str, lazy: bool) -> String {
    if !safe_address(src, true) {
        return String::new();
    }
    format!(
        "<img class=\"ob-home-image\" src=\"{}\" alt=\"{}\"{}>\n",
        attr(src),
        attr(alt),
        if lazy { " loading=\"lazy\"" } else { "" }
    )
}

/// A row of buttons. A button whose address is not allowed is left out.
pub fn buttons(buttons: &[Button]) -> String {
    let links: String = buttons
        .iter()
        .filter(|b| safe_address(&b.href, false))
        .map(|b| {
            let style = match b.style {
                ButtonStyle::Primary => "primary",
                ButtonStyle::Secondary => "secondary",
            };
            let rel = if b.href.to_ascii_lowercase().starts_with("https:") {
                " rel=\"noopener noreferrer\""
            } else {
                ""
            };
            format!(
                "<a class=\"ob-home-button ob-home-button-{style}\" href=\"{}\"{rel}>{}</a>\n",
                attr(&b.href),
                text(&b.label)
            )
        })
        .collect();
    if links.is_empty() {
        String::new()
    } else {
        format!("<p class=\"ob-home-actions\">\n{links}</p>\n")
    }
}

pub fn image(v: &ImageSection) -> String {
    let img = picture_tag(&v.src, &v.alt, true);
    if img.is_empty() {
        return String::new();
    }
    let caption = if v.caption.trim().is_empty() {
        String::new()
    } else {
        format!("<figcaption>{}</figcaption>\n", text(&v.caption))
    };
    format!("<figure class=\"ob-home-figure\">\n{img}{caption}</figure>\n")
}

/// The address a video is watched at, and the frame that plays it in place.
fn video_embed(v: &Video) -> Embed {
    let (frame_src, provider) = match v.provider {
        VideoProvider::Youtube => (
            format!("https://www.youtube-nocookie.com/embed/{}", v.video),
            "youtube",
        ),
        // `dnt` asks Vimeo not to track the viewer.
        VideoProvider::Vimeo => (
            format!("https://player.vimeo.com/video/{}?dnt=1", v.video),
            "vimeo",
        ),
    };
    Embed {
        provider,
        frame_src,
        title: v.title.clone(),
        link: v.provider.watch_url(&v.video),
        link_label: format!("Watch {} on {}", v.title, v.provider.label()),
    }
}

/// The ids a provider's address can hold, checked again at render time.
fn video_id_ok(v: &Video) -> bool {
    match v.provider {
        VideoProvider::Youtube => {
            v.video.len() == 11
                && v.video
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }
        VideoProvider::Vimeo => {
            (1..=12).contains(&v.video.len()) && v.video.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

pub fn video(v: &Video, mode: Mode) -> String {
    if !video_id_ok(v) {
        return String::new();
    }
    embed_markup(&video_embed(v), "ob-home-video", mode)
}

pub fn map(v: &MapSection, mode: Mode) -> String {
    if !(v.lat.is_finite()
        && (-90.0..=90.0).contains(&v.lat)
        && v.lon.is_finite()
        && (-180.0..=180.0).contains(&v.lon))
    {
        return String::new();
    }
    let (frame_src, provider) = match v.provider {
        MapProvider::Openstreetmap => (
            format!(
                "https://www.openstreetmap.org/export/embed.html?bbox={:.6},{:.6},{:.6},{:.6}&layer=mapnik&marker={:.6},{:.6}",
                (v.lon - 0.01).max(-180.0),
                (v.lat - 0.006).max(-90.0),
                (v.lon + 0.01).min(180.0),
                (v.lat + 0.006).min(90.0),
                v.lat,
                v.lon
            ),
            "openstreetmap",
        ),
    };
    let embed = Embed {
        provider,
        frame_src,
        title: format!("Map of {}", v.label),
        link: v.map_url(),
        link_label: format!("{} on the map", v.label),
    };
    embed_markup(&embed, "ob-home-map", mode)
}

/// A frame with its link beneath, or in portable output the link alone.
fn embed_markup(embed: &Embed, class: &str, mode: Mode) -> String {
    match mode {
        Mode::Page => {
            let html = embed::html(embed);
            html.replacen(
                &format!("class=\"ob-embed ob-embed-{}\"", embed.provider),
                &format!("class=\"ob-embed ob-embed-{} {class}\"", embed.provider),
                1,
            )
        }
        Mode::Portable => format!(
            "<p class=\"ob-embed-link ob-embed-{} {class}\"><a href=\"{}\" rel=\"noopener noreferrer\">{}</a></p>\n",
            embed.provider,
            attr(&embed.link),
            text(&embed.link_label)
        ),
    }
}

pub fn hours(v: &OpeningHours) -> String {
    if v.rows.is_empty() {
        return String::new();
    }
    let mut inner = String::from(
        "<table class=\"ob-home-hours\">\n<caption>Opening hours</caption>\n<tbody>\n",
    );
    for row in &v.rows {
        inner.push_str(&format!(
            "<tr><th scope=\"row\">{}</th><td>{}</td></tr>\n",
            text(&row.days),
            text(&row.hours)
        ));
    }
    inner.push_str("</tbody>\n</table>\n");
    if !v.note.trim().is_empty() {
        inner.push_str(&format!(
            "<p class=\"ob-home-note\">{}</p>\n",
            text(&v.note)
        ));
    }
    inner
}

pub fn contact(v: &Contact) -> String {
    let mut lines = Vec::new();
    if !v.email.is_empty() && safe_address(&format!("mailto:{}", v.email), false) {
        lines.push(format!(
            "<a class=\"ob-home-link\" href=\"mailto:{}\">{}</a>",
            attr(&v.email),
            text(&v.email)
        ));
    }
    let number: String = v
        .phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    if !number.is_empty() && safe_address(&format!("tel:{number}"), false) {
        lines.push(format!(
            "<a class=\"ob-home-link\" href=\"tel:{}\">{}</a>",
            attr(&number),
            text(&v.phone)
        ));
    }
    if !v.address.trim().is_empty() {
        lines.push(text(&v.address));
    }
    if lines.is_empty() {
        return String::new();
    }
    let items: String = lines
        .iter()
        .map(|line| format!("<p>{line}</p>\n"))
        .collect();
    format!("<address class=\"ob-home-contact\">\n{items}</address>\n")
}

pub fn social(v: &SocialLinks) -> String {
    let items: String = v
        .items
        .iter()
        .filter(|link| link.href.starts_with("https://") && safe_address(&link.href, false))
        .map(|link| {
            format!(
                "<li><a class=\"ob-home-link\" rel=\"me noopener noreferrer\" href=\"{}\">{}</a></li>\n",
                attr(&link.href),
                text(&link.label)
            )
        })
        .collect();
    if items.is_empty() {
        String::new()
    } else {
        format!("<ul class=\"ob-home-social\">\n{items}</ul>\n")
    }
}

pub fn faq(v: &Faq) -> String {
    let mut inner = String::new();
    for item in &v.items {
        inner.push_str(&format!(
            "<details class=\"ob-home-faq-item\">\n<summary>{}</summary>\n<div class=\"ob-prose\">{}</div>\n</details>\n",
            text(&item.question),
            render_inert_markdown(&item.answer, 0)
        ));
    }
    inner
}

pub fn callout(v: &Callout) -> String {
    if v.body.trim().is_empty() {
        return String::new();
    }
    let title = if v.title.trim().is_empty() {
        String::new()
    } else {
        format!(
            "<p class=\"ob-home-callout-title\"><strong>{}</strong></p>\n",
            text(&v.title)
        )
    };
    format!(
        "<aside class=\"ob-home-callout-box\">\n{title}<div class=\"ob-prose\">{}</div>\n</aside>\n",
        render_inert_markdown(&v.body, 0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::landing::{CalloutTone, HoursRow};

    fn video_piece(provider: VideoProvider, id: &str) -> Video {
        Video {
            provider,
            video: id.into(),
            title: "A \"tour\" <b>".into(),
        }
    }

    #[test]
    fn a_video_is_a_lazy_titled_privacy_enhanced_frame_with_a_link() {
        let html = video(
            &video_piece(VideoProvider::Youtube, "dQw4w9WgXcQ"),
            Mode::Page,
        );
        assert!(
            html.contains("src=\"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ\""),
            "{html}"
        );
        assert!(html.contains("loading=\"lazy\""));
        assert!(html.contains("title=\"A &quot;tour&quot; &lt;b&gt;\""));
        assert!(html.contains("href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\""));
        assert!(html.contains("ob-home-video"));
        let vimeo = video(&video_piece(VideoProvider::Vimeo, "12345"), Mode::Page);
        assert!(
            vimeo.contains("src=\"https://player.vimeo.com/video/12345?dnt=1\""),
            "{vimeo}"
        );
        assert!(vimeo.contains("href=\"https://vimeo.com/12345\""));
    }

    #[test]
    fn a_video_with_a_hostile_id_renders_nothing() {
        for id in ["\" onload=\"x", "a/b", "", "dQw4w9WgXc\""] {
            assert_eq!(
                video(&video_piece(VideoProvider::Youtube, id), Mode::Page),
                ""
            );
        }
        assert_eq!(
            video(&video_piece(VideoProvider::Vimeo, "12a"), Mode::Page),
            ""
        );
    }

    #[test]
    fn portable_output_degrades_an_embed_to_its_link() {
        let html = video(
            &video_piece(VideoProvider::Youtube, "dQw4w9WgXcQ"),
            Mode::Portable,
        );
        assert!(!html.contains("<iframe"));
        assert!(
            html.starts_with("<p class=\"ob-embed-link ob-embed-youtube ob-home-video\">"),
            "{html}"
        );
        let m = MapSection {
            provider: MapProvider::Openstreetmap,
            label: "Shop".into(),
            lat: 51.5,
            lon: -0.12,
        };
        let html = map(&m, Mode::Portable);
        assert!(
            !html.contains("<iframe") && html.contains("openstreetmap.org/?mlat=51.500000"),
            "{html}"
        );
    }

    #[test]
    fn a_map_frame_is_built_from_the_coordinates_only() {
        let m = MapSection {
            provider: MapProvider::Openstreetmap,
            label: "The \"shop\"".into(),
            lat: 51.5,
            lon: -0.12,
        };
        let html = map(&m, Mode::Page);
        assert!(html.contains("src=\"https://www.openstreetmap.org/export/embed.html?bbox=-0.130000,51.494000,-0.110000,51.506000&amp;layer=mapnik&amp;marker=51.500000,-0.120000\""), "{html}");
        assert!(html.contains("title=\"Map of The &quot;shop&quot;\""));
        assert!(html.contains("loading=\"lazy\""));
        let off = MapSection { lat: f64::NAN, ..m };
        assert_eq!(map(&off, Mode::Page), "");
    }

    #[test]
    fn small_pieces_escape_and_skip_unsafe_addresses() {
        let b = Button {
            label: "<i>Go</i>".into(),
            href: "javascript:alert(1)".into(),
            style: ButtonStyle::Primary,
        };
        assert_eq!(buttons(&[b]), "");
        let i = ImageSection {
            src: "/a.png".into(),
            alt: "A \"door\"".into(),
            caption: "<b>x</b>".into(),
        };
        let html = image(&i);
        assert!(
            html.contains("alt=\"A &quot;door&quot;\"") && html.contains("&lt;b&gt;"),
            "{html}"
        );
        let h = OpeningHours {
            rows: vec![HoursRow {
                days: "<s>".into(),
                hours: "9".into(),
            }],
            note: String::new(),
        };
        assert!(hours(&h).contains("&lt;s&gt;"));
        let c = Callout {
            tone: CalloutTone::Info,
            title: String::new(),
            body: "<script>x</script>".into(),
        };
        assert!(!callout(&c).contains("<script>"));
    }

    #[test]
    fn a_post_piece_is_wrapped_with_its_kind() {
        let piece = Piece::Button(Button {
            label: "Read".into(),
            href: "/about/".into(),
            style: ButtonStyle::Secondary,
        });
        let html = post_piece(&piece, Mode::Page);
        assert!(
            html.starts_with("<div class=\"ob-piece ob-piece-button\">\n"),
            "{html}"
        );
        assert!(html.contains("ob-home-button-secondary"));
    }
}
