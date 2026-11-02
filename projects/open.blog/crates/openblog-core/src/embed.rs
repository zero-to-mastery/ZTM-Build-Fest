//! Rich embeds for links that stand alone in their own paragraph.
//!
//! A paragraph whose only content is a link to a supported service (or the bare
//! URL, or Hashnode's `%[url]` embed syntax) becomes an embedded frame with a
//! plain link underneath, so feed readers and no-iframe contexts still get the
//! link. Links inside sentences are never touched.
//!
//! Only URLs that parse into known, validated parts are embedded; the frame's
//! address is rebuilt from those parts, never copied from the input.

use crate::escape::{attr, text};

/// Origins used by frames produced by this module. Preview security policies
/// consume the same allowlist so adding a provider cannot silently break them.
pub const FRAME_SOURCES: &str = "https://codepen.io https://www.youtube-nocookie.com https://player.vimeo.com https://www.openstreetmap.org";

/// A recognised embed: the frame address and what to call it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Embed {
    pub provider: &'static str,
    pub frame_src: String,
    pub title: String,
    pub link: String,
    pub link_label: String,
}

fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Return the canonical id from a supported YouTube URL. Requiring the exact
/// host and the platform's 11-character id keeps the rebuilt embed URL safe.
pub fn youtube_video_id(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    let candidate = match host {
        "youtu.be" => path.split(['?', '#', '/']).next()?,
        "youtube.com" | "m.youtube.com" => {
            if let Some(path) = path.strip_prefix("watch?") {
                path.split('&').find_map(|part| part.strip_prefix("v="))?
            } else {
                let path = path.strip_prefix("shorts/")?;
                path.split(['?', '#', '/']).next()?
            }
        }
        _ => return None,
    };
    (candidate.len() == 11
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then(|| candidate.to_string())
}

fn youtube(url: &str) -> Option<Embed> {
    let id = youtube_video_id(url)?;
    Some(Embed {
        provider: "youtube",
        frame_src: format!("https://www.youtube-nocookie.com/embed/{id}"),
        title: format!("YouTube video {id}"),
        link: format!("https://www.youtube.com/watch?v={id}"),
        link_label: "Watch on YouTube".to_string(),
    })
}

/// `https://codepen.io/<user>/pen/<id>` (also `/full/`, `/details/`, `/embed/`,
/// `/debug/`, and `team/<team>/pen/<id>`), with any query string.
fn codepen(url: &str) -> Option<Embed> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let path = rest.strip_prefix("codepen.io/")?;
    let path = path.split(['?', '#']).next().unwrap_or("");
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (owner, kind, id) = match segments.as_slice() {
        ["team", team, kind, id, ..] => (format!("team/{team}"), *kind, *id),
        [user, kind, id, ..] => ((*user).to_string(), *kind, *id),
        _ => return None,
    };
    let owner_ok = owner
        .split('/')
        .all(|part| part == "team" || safe_segment(part));
    if !owner_ok
        || !safe_segment(id)
        || !matches!(
            kind,
            "pen" | "full" | "details" | "embed" | "debug" | "live"
        )
    {
        return None;
    }
    Some(Embed {
        provider: "codepen",
        frame_src: format!("https://codepen.io/{owner}/embed/{id}?default-tab=result"),
        title: format!("CodePen embed {id}"),
        link: format!("https://codepen.io/{owner}/pen/{id}"),
        link_label: "See the Pen on CodePen".to_string(),
    })
}

/// The embed for a URL, if a supported service recognises it.
pub fn detect(url: &str) -> Option<Embed> {
    let url = url.trim();
    // Hashnode's embed syntax: %[https://...]
    let url = url
        .strip_prefix("%[")
        .and_then(|u| u.strip_suffix(']'))
        .unwrap_or(url)
        .trim();
    youtube(url).or_else(|| codepen(url))
}

pub fn html(embed: &Embed) -> String {
    format!(
        "<figure class=\"ob-embed ob-embed-{provider}\"><iframe src=\"{src}\" title=\"{title}\" loading=\"lazy\" allowfullscreen allow=\"clipboard-write\" referrerpolicy=\"strict-origin-when-cross-origin\"></iframe><figcaption><a href=\"{link}\" rel=\"noopener\">{label}</a></figcaption></figure>\n",
        provider = embed.provider,
        src = attr(&embed.frame_src),
        title = attr(&embed.title),
        link = attr(&embed.link),
        label = text(&embed.link_label),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_codepen_urls_and_rebuilds_the_frame_address() {
        let e = detect("https://codepen.io/mnichols08/pen/oNOxOQG").unwrap();
        assert_eq!(
            e.frame_src,
            "https://codepen.io/mnichols08/embed/oNOxOQG?default-tab=result"
        );
        assert_eq!(e.link, "https://codepen.io/mnichols08/pen/oNOxOQG");
        assert_eq!(
            detect("https://codepen.io/mnichols08/pen/QWorpOL?editors=1111")
                .unwrap()
                .frame_src,
            "https://codepen.io/mnichols08/embed/QWorpOL?default-tab=result"
        );
        assert!(detect("http://www.codepen.io/a/full/b").is_some());
        assert!(
            detect("%[https://codepen.io/a/pen/b]").is_some(),
            "Hashnode embed syntax"
        );
        assert_eq!(
            detect("https://codepen.io/team/acme/pen/xyz")
                .unwrap()
                .frame_src,
            "https://codepen.io/team/acme/embed/xyz?default-tab=result"
        );
    }

    #[test]
    fn recognises_youtube_watch_short_and_shorts_urls() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://youtu.be/dQw4w9WgXcQ?si=example",
            "https://youtube.com/shorts/dQw4w9WgXcQ",
        ] {
            let embed = detect(url).unwrap();
            assert_eq!(embed.provider, "youtube");
            assert_eq!(
                embed.frame_src,
                "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
            );
            assert_eq!(embed.link, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        }
    }

    #[test]
    fn rejects_anything_else() {
        for url in [
            "https://codepen.io/mnichols08",
            "https://codepen.io/mnichols08/pens/popular",
            "https://codepen.io/a/pen/b\"><script>",
            "https://evilcodepen.io/a/pen/b",
            "https://codepen.io.evil.com/a/pen/b",
            "javascript:alert(1)",
            "https://github.com/a/b",
            "https://codepen.io/a/pen/",
        ] {
            assert!(detect(url).is_none(), "{url}");
        }
    }

    #[test]
    fn html_escapes_and_keeps_a_link_for_feeds() {
        let out = html(&detect("https://codepen.io/a/pen/b").unwrap());
        assert!(out.starts_with("<figure class=\"ob-embed ob-embed-codepen\"><iframe src=\"https://codepen.io/a/embed/b?default-tab=result\""));
        assert!(out.contains("loading=\"lazy\""));
        assert!(out.contains(
            "<a href=\"https://codepen.io/a/pen/b\" rel=\"noopener\">See the Pen on CodePen</a>"
        ));
    }
}
