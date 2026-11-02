-- Rotation entries: one row per listened album, shown on the index page and
-- served to the blog island. Musicfeed ids are sequential u64s (the blog and
-- templates rely on them), so `id` is a rowid alias rather than a UUID.
CREATE TABLE rotation_entries(
    id INTEGER PRIMARY KEY,
    /* corresponds to domain `RotationEntry.listened_date` (chrono NaiveDate,
    stored as ISO-8601 TEXT via the sqlx chrono feature) */
    listened_date TEXT NOT NULL,
    /* String fields must exist: the form requires artist and album, and the
    metadata lookup cannot remove them */
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    /* Option<String>/Option<i32> fields may be omitted: a metadata miss yields
    no cover or year, and `note` is empty when the form sends none */
    cover TEXT,
    year INTEGER,
    note TEXT
);
