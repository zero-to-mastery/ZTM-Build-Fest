//! How far the search index has got: the startup indexing's progress, and why
//! search is unavailable when the index can't be opened.

/// The search index's progress and failure, as the search picker shows them.
/// Written only by the search actor. Indexing is still running while
/// `indexed < total`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchProgress {
    /// Transcripts the startup indexing has read so far.
    pub indexed: usize,
    /// Transcripts the startup indexing queued.
    pub total: usize,
    /// Why the index couldn't be opened, even after recreating it.
    pub error: Option<String>,
}
