//! The loop's side of the control socket: applies an agent's request on the
//! loop's thread and answers it.

use std::sync::mpsc::Sender;

use orb_domain::feat::control::change;
use orb_domain::feat::control::pane_control::{PaneReply, PaneRequest};
use orb_domain::feat::control::protocol::{ApiError, ErrorCode};
use orb_domain::ids::PaneId;
use orb_term::Pane;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::App;

impl App {
    /// Applies an agent's request and answers it. A refusal goes back to the
    /// caller only: nothing reaches the message box, and no key sequence or
    /// toast is dismissed.
    pub(super) fn control(&mut self, request: PaneRequest, reply: &Sender<PaneReply>) {
        let answer = match request {
            PaneRequest::Change(change) => {
                let applied = change::apply(&mut self.state.write(), &change);
                applied.map(|commands| {
                    for command in &commands {
                        self.execute(command);
                    }
                    None
                })
            }
            PaneRequest::Send { pane, text } => self.live_pane(pane).map(|live| {
                live.paste(&text);
                None
            }),
            PaneRequest::Keys { pane, keys } => self.live_pane(pane).map(|live| {
                for key in &keys {
                    live.key(key);
                }
                None
            }),
            PaneRequest::Run { pane, line } => self.run_line(pane, line),
            PaneRequest::Launch { pane, line } => self.launch(pane, line),
            PaneRequest::Prompt { pane, text } => self.live_pane(pane).map(|live| {
                live.paste(&text);
                live.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
                None
            }),
            PaneRequest::Read { pane, lines } => {
                self.live_pane(pane).map(|live| Some(live.text(lines)))
            }
        };
        let _ = reply.send(answer);
    }

    /// Pane `id`'s client; `not_found` "no live pane" when it has none (a
    /// settled session, a broken pane) or its client has exited. A pane added
    /// earlier in this turn gets its client first: on a miss the panes are
    /// matched to the layouts once before refusing.
    fn live_pane(&mut self, id: PaneId) -> Result<&Pane, ApiError> {
        let live = |app: &Self| app.panes.get(&id).is_some_and(|pane| !pane.has_exited());
        if !live(self) {
            self.reconcile();
        }
        self.panes
            .get(&id)
            .filter(|pane| !pane.has_exited())
            .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no live pane"))
    }

    /// Types `line`, an agent's start line, as a run does, unless a line
    /// already waits in pane `id` (a restored agent's resume command): then
    /// `pane_busy`. From then on the pane tells its child images don't work.
    fn launch(&mut self, id: PaneId, line: String) -> PaneReply {
        self.live_pane(id)?.answer_graphics(false);
        if self.typing.contains_key(&id) {
            return Err(ApiError::new(
                ErrorCode::PaneBusy,
                "a command waits to be typed in this pane",
            ));
        }
        self.run_line(id, line)
    }

    /// Types `line` and Enter into pane `id`. Until the pane's program has
    /// printed anything, the line waits for that first output, as a resumed
    /// agent's command does, unless a line already waits there.
    fn run_line(&mut self, id: PaneId, line: String) -> PaneReply {
        let printed = self.live_pane(id)?.has_output();
        match (
            printed || self.typing.contains_key(&id),
            self.panes.get(&id),
        ) {
            (true, Some(pane)) => pane.type_line(&line),
            _ => {
                self.typing.insert(id, line);
            }
        }
        Ok(None)
    }
}
