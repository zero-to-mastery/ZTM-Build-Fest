//! The notifier for a desktop orb can't notify on: it shows nothing.

use error_stack::Report;

use super::notifier::{Notifier, NotifyError, Urgency};
use crate::ids::AgentId;

/// Shows nothing, and always succeeds.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoneNotifier;

impl Notifier for NoneNotifier {
    fn name(&self) -> &'static str {
        "none"
    }

    fn notify(
        &self,
        _title: &str,
        _body: &str,
        _urgency: Urgency,
        _agent: AgentId,
    ) -> Result<(), Report<NotifyError>> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::NoneNotifier;
    use crate::feat::notify::notifier::{Notifier, Urgency};
    use crate::ids::AgentId;

    #[rstest::rstest]
    fn none_notifier_shows_nothing_and_succeeds() {
        // Given the notifier for a desktop orb can't notify on.
        let notifier = NoneNotifier;

        // When notifying that agent 1 finished.
        let result = notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(1));

        // Then it succeeds.
        assert!(result.is_ok(), "the none notifier should always succeed");
    }
}
