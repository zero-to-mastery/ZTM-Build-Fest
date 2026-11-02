//! A line of text being typed, such as a picker's filter, with a cursor that
//! moves and edits by whole graphemes.

use unicode_segmentation::UnicodeSegmentation;

/// A line of text being typed, with a grapheme cursor.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextInput {
    /// The typed text.
    text: String,
    /// A grapheme index into `text`.
    cursor: usize,
}

impl TextInput {
    /// `text`, with the cursor at its end.
    pub fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            cursor: text.graphemes(true).count(),
        }
    }

    /// Types `ch` at the cursor. Line breaks are dropped.
    pub fn insert(&mut self, ch: char) {
        if matches!(ch, '\n' | '\r') {
            return;
        }
        let at = self.byte_at(self.cursor);
        self.text.insert(at, ch);
        self.cursor = self
            .text
            .get(..at + ch.len_utf8())
            .map_or(0, |typed| typed.graphemes(true).count());
    }

    /// Deletes the grapheme before the cursor.
    pub fn backspace(&mut self) {
        let Some(before) = self.cursor.checked_sub(1) else {
            return;
        };
        let start = self.byte_at(before);
        self.text
            .replace_range(start..self.byte_at(self.cursor), "");
        self.cursor = before;
    }

    /// Deletes back from the cursor to the previous `/` or space. A `/` or
    /// space right before the cursor goes with it: `~/dev/` becomes `~/`.
    pub fn delete_word(&mut self) {
        let before: Vec<&str> = self.text.graphemes(true).take(self.cursor).collect();
        let separator = |g: &&str| *g == "/" || g.chars().all(char::is_whitespace);
        let mut from = before.len();
        if before.last().is_some_and(separator) {
            from -= 1;
        }
        from -= before.get(..from).map_or(0, |word| {
            word.iter().rev().take_while(|&g| !separator(g)).count()
        });
        let (start, end) = (self.byte_at(from), self.byte_at(self.cursor));
        self.text.replace_range(start..end, "");
        self.cursor = from;
    }

    /// Moves the cursor one grapheme left.
    pub fn cursor_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    /// Moves the cursor one grapheme right.
    pub fn cursor_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.text.graphemes(true).count());
    }

    /// Moves the cursor to grapheme `index`, or to the end when the text is
    /// shorter.
    pub fn cursor_to(&mut self, index: usize) {
        self.cursor = index.min(self.text.graphemes(true).count());
    }

    /// The typed text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The cursor, as a grapheme index into [`text`](Self::text).
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// The byte offset of grapheme `index` in the text, or its end.
    fn byte_at(&self, index: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .nth(index)
            .map_or(self.text.len(), |(at, _)| at)
    }
}

#[cfg(test)]
mod tests {
    use super::TextInput;

    /// `e` followed by a combining acute accent: one grapheme, two chars.
    const E_ACUTE: &str = "e\u{301}";

    #[rstest::rstest]
    fn new_puts_the_cursor_after_the_last_grapheme() {
        // Given / When text holding a multi-codepoint grapheme.
        let input = TextInput::new(&format!("a{E_ACUTE}"));

        // Then the cursor is after both graphemes.
        assert_eq!(input.cursor(), 2, "the cursor should count graphemes");
    }

    #[rstest::rstest]
    fn insert_types_at_the_cursor() {
        // Given "ab" typed, with the cursor between the two.
        let mut input = TextInput::new("ab");
        input.cursor_left();

        // When typing "x".
        input.insert('x');

        // Then it lands at the cursor.
        assert_eq!(input.text(), "axb", "insert should type at the cursor");
    }

    #[rstest::rstest]
    fn insert_drops_line_breaks() {
        // Given "ab" typed.
        let mut input = TextInput::new("ab");

        // When typing a line break.
        input.insert('\n');

        // Then the text is unchanged.
        assert_eq!(input.text(), "ab", "a line break shouldn't be typed");
    }

    #[rstest::rstest]
    fn backspace_deletes_the_grapheme_before_the_cursor() {
        // Given "abc" typed, with the cursor before "c".
        let mut input = TextInput::new("abc");
        input.cursor_left();

        // When deleting.
        input.backspace();

        // Then "b" is gone.
        assert_eq!(
            input.text(),
            "ac",
            "backspace should delete before the cursor"
        );
    }

    #[rstest::rstest]
    fn backspace_deletes_a_whole_multi_codepoint_grapheme() {
        // Given "a" and an accented "e" typed.
        let mut input = TextInput::new(&format!("a{E_ACUTE}"));

        // When deleting.
        input.backspace();

        // Then the accent goes with its letter.
        assert_eq!(input.text(), "a", "backspace should delete the grapheme");
    }

    #[rstest::rstest]
    fn cursor_left_steps_over_a_whole_multi_codepoint_grapheme() {
        // Given "a" and an accented "e" typed, the cursor at the end.
        let mut input = TextInput::new(&format!("a{E_ACUTE}"));

        // When moving left and typing "x".
        input.cursor_left();
        input.insert('x');

        // Then "x" lands before the accented "e", not inside it.
        assert_eq!(
            input.text(),
            format!("ax{E_ACUTE}"),
            "the cursor should move by graphemes"
        );
    }

    #[rstest::rstest]
    fn cursor_right_stops_at_the_end() {
        // Given "ab" typed, the cursor at the end.
        let mut input = TextInput::new("ab");

        // When moving right.
        input.cursor_right();

        // Then the cursor stays at the end.
        assert_eq!(input.cursor(), 2, "the cursor shouldn't pass the end");
    }

    #[rstest::rstest]
    #[case("~/dev/orb", "~/dev/")]
    #[case("~/dev/", "~/")]
    #[case("~/", "")]
    #[case("foo bar", "foo ")]
    #[case("foo ", "")]
    fn delete_word_deletes_back_to_a_separator(#[case] text: &str, #[case] expected: &str) {
        // Given text typed with the cursor at its end.
        let mut input = TextInput::new(text);

        // When deleting a word.
        input.delete_word();

        // Then the text up to the previous separator remains.
        assert_eq!(input.text(), expected, "delete_word on {text:?}");
    }
}
