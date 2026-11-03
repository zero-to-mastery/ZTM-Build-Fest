# ZTM Build Fest 2026
## MusicFeed — Publish your favourites

MusicFeed is a personal music log that sends what I'm listening to to my blog, [Crusty Metallian](https://crusty-metallian.net). I can record an album once, and it appears in the music widget on the blog's front page—no manual site edits needed. The goal is to help visitors discover music they might not otherwise encounter.

### Try it

- **Listen:** Visit [Crusty Metallian](https://crusty-metallian.net) to see the MusicFeed widget on the front page.
- **MusicFeed service:** [musicfeed.crusty-metallian.net](https://musicfeed.crusty-metallian.net) (hosted on Railway).

The service provides the form for adding entries and the API used by the blog widget. Form submissions are protected by HTTP Basic Authentication; I'm currently the only user authorized to add entries. Visitors can see the music on the blog; they don't need to download or run MusicFeed.

### How it works

I add an artist, album, and optional note through MusicFeed. The service looks up release-year and cover-art metadata when available, saves the entry, and makes it available to the blog widget. A lookup miss doesn't prevent an entry from being saved; a background task can retry missing metadata later.

### Built with

- Rust and [Axum](https://github.com/tokio-rs/axum) for the web service
- [Tera](https://github.com/Keats/tera) templates and [Datastar](https://data-star.dev/) for the interactive form and live updates
- SQLite for persistent storage
- MusicBrainz and the Cover Art Archive for album metadata

The project builds on my [Axum-Tera-Datastar starter](https://github.com/crustyrustacean/axum-tera-datastar).

### About the project

This is my [ZTM Build Fest 2026](https://github.com/zero-to-mastery/ZTM-Build-Fest) project. I use AI to help brainstorm and guide development, and my own harness, [Rho Code](https://rho-code.dev), as a research assistant, pair programmer, and reviewer.
