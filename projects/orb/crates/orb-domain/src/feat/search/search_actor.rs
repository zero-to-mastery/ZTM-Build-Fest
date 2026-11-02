//! The search actor — owns `AppState.search` and the search index's only
//! connection.
//!
//! At startup it indexes every live agent's transcript, newest chat first,
//! one transcript per message so queries run in between. Before each query it
//! reads what each transcript gained since the last read, and it answers
//! previews from the index.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use error_stack::Report;
use kameo::mailbox;
use kameo::prelude::{Actor, ActorRef, Context, Message, Spawn};

use super::index::{AgentKey, Hit, SearchIndex, SearchIndexError, snippet};
use super::state::SearchProgress;
use crate::AppState;
use crate::command::SearchCommand;
use crate::common::{Log, Outcome, Reporter, State};
use crate::feat::harness::{HarnessId, Harnesses};
use crate::feat::picker::list::PickerItem;
use crate::feat::picker::state::{PickerState, hit_label};
use crate::feat::sessions::sessions_actor::to_ms;
use crate::feat::sessions::state::{Agent, Project, Sessions};

/// What the search actor needs to start.
pub struct SearchActorDeps {
    pub state: State,
    /// Every harness, to read each agent's transcript in its own format.
    pub harnesses: Harnesses,
    /// `~/.orb/userdata/search.sqlite`.
    pub index_path: PathBuf,
    /// Tells the frontend loop what changed and what the picker should show.
    pub report: Reporter,
    /// orb's log file.
    pub log: Log,
}

/// Owns [`SearchProgress`] and the search index. Reports the search picker's
/// rows and preview; the frontend loop shows them unless they're stale.
pub struct SearchActor {
    state: State,
    harnesses: Harnesses,
    /// `None` when the index couldn't be opened; then every message is a no-op.
    index: Option<SearchIndex>,
    report: Reporter,
    log: Log,
    /// Transcripts the startup indexing hasn't read yet, newest chat first,
    /// with the harness each agent runs in.
    queue: VecDeque<(AgentKey, HarnessId, PathBuf)>,
}

/// Index the next queued transcript. The actor sends it to itself.
#[derive(Debug)]
pub struct IndexNext;

/// Spawns the search actor with a mailbox that never refuses a message.
/// Must be called inside a tokio runtime, once `AppState` holds the agents.
pub fn spawn_search_actor(deps: SearchActorDeps) -> ActorRef<SearchActor> {
    SearchActor::spawn_with_mailbox(deps, mailbox::unbounded())
}

impl Actor for SearchActor {
    type Args = SearchActorDeps;
    type Error = kameo::error::Infallible;

    fn on_start(
        args: Self::Args,
        actor_ref: ActorRef<Self>,
    ) -> impl Future<Output = Result<Self, Self::Error>> + Send {
        let actor = Self::start(args);
        if !actor.queue.is_empty() {
            let _ = actor_ref.tell(IndexNext).try_send();
        }
        std::future::ready(Ok(actor))
    }
}

impl Message<IndexNext> for SearchActor {
    type Reply = ();

    async fn handle(
        &mut self,
        _msg: IndexNext,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.index_next(ctx.actor_ref());
    }
}

impl Message<SearchCommand> for SearchActor {
    type Reply = ();

    fn handle(
        &mut self,
        msg: SearchCommand,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        match msg {
            SearchCommand::SearchTranscripts { query } => self.search(&query),
            SearchCommand::LoadSearchPreview {
                hit,
                path,
                prompt_offset,
            } => self.preview(hit, &path, prompt_offset),
        }
        std::future::ready(())
    }
}

impl SearchActor {
    /// Opens the index, drops the agents that are gone, queues every live
    /// transcript newest chat first and reports the indexing as not started.
    /// When the index can't be opened, says why in `AppState.search` and
    /// leaves the queue empty.
    fn start(deps: SearchActorDeps) -> Self {
        let SearchActorDeps {
            state,
            harnesses,
            index_path,
            report,
            log,
        } = deps;
        let mut index = match SearchIndex::open(&index_path) {
            Ok(index) => index,
            Err(failure) => {
                log.error_on_change("search: open", "couldn't open the search index", &failure);
                state.write().search.error = Some(reason(&failure));
                report.changed();
                return Self {
                    state,
                    harnesses,
                    index: None,
                    report,
                    log,
                    queue: VecDeque::new(),
                };
            }
        };
        let (keys, queue) = {
            let app = state.read();
            let mut agents: Vec<&Agent> = live(&app.sessions).map(|(_, agent)| agent).collect();
            agents.sort_by_key(|agent| Reverse((agent.last_chat(), agent.id.0)));
            let keys: HashSet<AgentKey> = agents.iter().map(|agent| key(agent)).collect();
            let queue: VecDeque<(AgentKey, HarnessId, PathBuf)> = agents
                .iter()
                .filter_map(|agent| {
                    Some((key(agent), agent.harness.clone(), agent.transcript.clone()?))
                })
                .collect();
            (keys, queue)
        };
        // A failure leaves the rows; the next catch-up retries.
        if let Err(report) = index.retain_agents(&keys) {
            log.error_on_change(
                "search: retain",
                "couldn't drop gone agents from the search index",
                &report,
            );
        }
        state.write().search = SearchProgress {
            indexed: 0,
            total: queue.len(),
            error: None,
        };
        report.changed();
        Self {
            state,
            harnesses,
            index: Some(index),
            report,
            log,
            queue,
        }
    }

    /// Indexes the next queued transcript and counts it, then asks for the
    /// one after while any are left. A failure leaves that transcript's saved
    /// offset alone, so the next catch-up retries it. An agent whose harness
    /// orb doesn't know, or whose transcript file is gone, is counted but not
    /// read.
    fn index_next(&mut self, me: &ActorRef<Self>) {
        let Some((key, harness, path)) = self.queue.pop_front() else {
            return;
        };
        if let Some(index) = &mut self.index
            && let Some(harness) = self.harnesses.get(&harness)
            && path.exists()
            && let Err(report) =
                index.index_transcript(key, &path, |path, offset, prompt_offset| {
                    harness.messages(path, offset, prompt_offset)
                })
        {
            self.log.error_on_change(
                &format!("search: index {}", path.display()),
                &format!("couldn't index {}", path.display()),
                &report,
            );
        }
        self.state.write().search.indexed += 1;
        self.report.changed();
        if !self.queue.is_empty() {
            let _ = me.tell(IndexNext).try_send();
        }
    }

    /// Brings the index up to date and reports what `query` finds for the
    /// search picker. Skipped when `query` is no longer the picker's typed
    /// text, which also collapses keystrokes queued behind a slow query. A
    /// failed query reports no rows. Then reports the first row's preview,
    /// since the rows arrive with it selected and no keystroke selects it.
    fn search(&mut self, query: &str) {
        let Some(index) = &mut self.index else {
            return;
        };
        if self
            .state
            .read()
            .picker
            .as_ref()
            .and_then(PickerState::search_query)
            != Some(query)
        {
            return;
        }
        catch_up(index, &self.state, &self.harnesses, &self.queue, &self.log);
        let found = match index.query(query) {
            Ok(found) => found,
            Err(report) => {
                self.log
                    .error_on_change("search: query", "couldn't run the search query", &report);
                return;
            }
        };
        let items = rows(&self.state.read(), found.hits);
        let first = match items.first() {
            Some(PickerItem::Hit {
                id,
                path,
                prompt_offset,
                ..
            }) => Some((*id, path.clone(), *prompt_offset)),
            _ => None,
        };
        self.report.report(Outcome::Hits {
            query: query.to_owned(),
            items,
            overflow: found.overflow,
        });
        if let Some((hit, path, prompt_offset)) = first {
            self.preview(hit, &path, prompt_offset);
        }
    }

    /// Reports the exchange of hit `hit` for the search picker's preview; the
    /// loop drops it if another row is selected by now. A failed read reports
    /// nothing.
    fn preview(&self, hit: i64, path: &Path, prompt_offset: u64) {
        let Some(index) = &self.index else {
            return;
        };
        let messages = match index.exchange(path, prompt_offset) {
            Ok(messages) => messages,
            Err(report) => {
                self.log.error_on_change(
                    "search: preview",
                    &format!("couldn't read the search preview from {}", path.display()),
                    &report,
                );
                return;
            }
        };
        self.report.report(Outcome::HitPreview { hit, messages });
    }
}

/// Drops the rows of agents gone from `state`, then reads what each live
/// agent's current transcript gained since the last read. Transcripts still
/// in the startup `queue` are left to it, and a missing file, or one whose
/// agent's harness orb doesn't know, is skipped.
fn catch_up(
    index: &mut SearchIndex,
    state: &State,
    harnesses: &Harnesses,
    queue: &VecDeque<(AgentKey, HarnessId, PathBuf)>,
    log: &Log,
) {
    let (keys, current) = {
        let app = state.read();
        let keys: HashSet<AgentKey> = live(&app.sessions).map(|(_, agent)| key(agent)).collect();
        let current: Vec<(AgentKey, HarnessId, PathBuf)> = live(&app.sessions)
            .filter_map(|(_, agent)| {
                Some((key(agent), agent.harness.clone(), agent.transcript.clone()?))
            })
            .collect();
        (keys, current)
    };
    if let Err(report) = index.retain_agents(&keys) {
        log.error_on_change(
            "search: retain",
            "couldn't drop gone agents from the search index",
            &report,
        );
    }
    for (key, harness, path) in current {
        if queue.iter().any(|(_, _, queued)| *queued == path) {
            continue;
        }
        let Some(harness) = harnesses.get(&harness) else {
            continue;
        };
        let Ok(len) = fs::metadata(&path).map(|meta| meta.len()) else {
            continue;
        };
        // An unreadable saved offset counts as changed.
        if index.transcript_offset(&path).ok().flatten() != Some(len)
            && let Err(report) =
                index.index_transcript(key, &path, |path, offset, prompt_offset| {
                    harness.messages(path, offset, prompt_offset)
                })
        {
            log.error_on_change(
                &format!("search: index {}", path.display()),
                &format!("couldn't index {}", path.display()),
                &report,
            );
        }
    }
}

/// `hits` as picker rows, labelled from `app`. A hit whose agent (by id and
/// creation time) isn't live any more is left out.
fn rows(app: &AppState, hits: Vec<Hit>) -> Vec<PickerItem> {
    let labels: HashMap<AgentKey, (String, usize)> = live(&app.sessions)
        .map(|(project, agent)| (key(agent), hit_label(&app.sessions, project, agent)))
        .collect();
    hits.into_iter()
        .filter_map(|hit| {
            let (label, split) = labels.get(&(hit.agent, hit.born))?.clone();
            let (snippet, lit) = snippet(&hit.text, &hit.lit);
            Some(PickerItem::Hit {
                id: hit.id,
                agent: hit.agent,
                label,
                split,
                snippet,
                lit,
                text_lit: hit.lit,
                path: hit.path,
                prompt_offset: hit.prompt_offset,
            })
        })
        .collect()
}

/// How the index names `agent`.
fn key(agent: &Agent) -> AgentKey {
    (agent.id, to_ms(agent.created_at))
}

/// Every agent with its project, minus those being deleted. Settled and
/// `Gone` agents count: their messages stay searchable.
fn live(sessions: &Sessions) -> impl Iterator<Item = (&Project, &Agent)> {
    sessions
        .projects
        .iter()
        .flat_map(|project| project.agents.iter().map(move |agent| (project, agent)))
        .filter(|(_, agent)| !sessions.is_deleting(agent))
}

/// What went wrong opening the index, for the picker's error line.
fn reason(report: &Report<SearchIndexError>) -> String {
    report
        .downcast_ref::<rusqlite::Error>()
        .map(ToString::to_string)
        .or_else(|| {
            report
                .downcast_ref::<std::io::Error>()
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "the index can't be opened".to_owned())
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use serde_json::json;

    use kameo::prelude::ActorRef;

    use super::{SearchActor, SearchActorDeps, spawn_search_actor};
    use crate::command::SearchCommand;
    use crate::common::{Log, Outcome, Reporter, State};
    use crate::feat::harness::Harnesses;
    use crate::feat::harness::claude::ClaudeCode;
    use crate::feat::harness::claude::supervisor::ClaudeSupervisor;
    use crate::feat::harness::claude::transcript::read_messages;
    use crate::feat::picker::list::PickerItem;
    use crate::feat::picker::state::PickerState;
    use crate::feat::search::index::SearchIndex;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, sessions_for,
    };
    use crate::feat::sessions::transcript::Role;
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
    use crate::{AppState, Focus};

    /// A prompt line the user typed.
    fn prompt(text: &str) -> String {
        json!({"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": text}})
            .to_string()
    }

    /// A reply line holding one text block Claude wrote.
    fn reply(text: &str) -> String {
        json!({
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {"content": [{"type": "text", "text": text}]}
        })
        .to_string()
    }

    /// Writes `lines`, each ended by a newline, to `name` in `dir`.
    fn transcript(dir: &Path, name: &str, lines: &[String]) -> io::Result<PathBuf> {
        let path = dir.join(name);
        std::fs::write(&path, format!("{}\n", lines.join("\n")))?;
        Ok(path)
    }

    /// Agent `id`, created at unix ms `born_ms`, last chatted in at second
    /// `last_chat_secs`.
    fn agent(id: i64, born_ms: u64, transcript: Option<PathBuf>, last_chat_secs: u64) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: None,
            cwd: "/tmp".into(),
            transcript,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: UNIX_EPOCH + Duration::from_millis(born_ms),
            last_activity_at: UNIX_EPOCH + Duration::from_secs(last_chat_secs),
            unseen: false,
            model: None,
        }
    }

    /// One project `orb` holding `agents`.
    fn app(agents: Vec<Agent>) -> AppState {
        AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "orb".to_owned(),
                    root: PathBuf::from("/repo"),
                    created_at: UNIX_EPOCH,
                    agents,
                    repo: true,
                    removed: false,
                    kind: ProjectKind::Normal,
                }],
                ..Sessions::default()
            },
            ..AppState::default()
        }
    }

    fn deps(state: &State, index_path: PathBuf) -> SearchActorDeps {
        let claude = ClaudeCode::new(Arc::new(ClaudeSupervisor::new(Vec::new())), PathBuf::new());
        SearchActorDeps {
            state: state.clone(),
            harnesses: Harnesses::new(vec![Arc::new(claude)]),
            index_path,
            report: showing(state),
            log: Log::default(),
        }
    }

    /// A reporter that shows reported rows and previews in `state`'s picker
    /// through the same guarded setters the frontend loop uses.
    fn showing(state: &State) -> Reporter {
        let state = state.clone();
        Reporter::new(move |outcome| {
            let mut app = state.write();
            let Some(picker) = &mut app.picker else {
                return;
            };
            match outcome {
                Outcome::Hits {
                    query,
                    items,
                    overflow,
                } => picker.show_hits(&query, items, overflow),
                Outcome::HitPreview { hit, messages } => picker.show_search_preview(hit, messages),
                _ => {}
            }
        })
    }

    /// The agents whose messages a second connection to the index at `path`
    /// finds for `query`, in result order.
    fn indexed(path: &Path, query: &str) -> io::Result<Vec<AgentId>> {
        let found = SearchIndex::open(path)
            .and_then(|index| index.query(query))
            .map_err(|report| io::Error::other(format!("{report:?}")))?;
        Ok(found.hits.into_iter().map(|hit| hit.agent).collect())
    }

    /// Opens the search picker with `text` typed into it.
    fn searching(state: &State, text: &str) {
        let mut picker = PickerState::search(Focus::Sidebar);
        for ch in text.chars() {
            let _ = picker.insert(ch);
        }
        state.write().picker = Some(picker);
    }

    /// The agent and snippet of each hit row the search picker shows.
    fn hit_rows(state: &State) -> Vec<(AgentId, String)> {
        let app = state.read();
        app.picker
            .iter()
            .flat_map(PickerState::shown)
            .filter_map(|(item, _)| match item {
                PickerItem::Hit { agent, snippet, .. } => Some((*agent, snippet.clone())),
                _ => None,
            })
            .collect()
    }

    /// Asks the actor to run `query`, waiting until it has.
    async fn search(actor: &ActorRef<SearchActor>, query: &str) -> io::Result<()> {
        actor
            .ask(SearchCommand::SearchTranscripts {
                query: query.to_owned(),
            })
            .await
            .map_err(|err| io::Error::other(format!("{err:?}")))
    }

    /// The preview request for the search picker's selected hit.
    fn selected_preview(state: &State) -> Option<SearchCommand> {
        let app = state.read();
        let (hit, path, prompt_offset) = app.picker.as_ref()?.selected_hit()?;
        Some(SearchCommand::LoadSearchPreview {
            hit,
            path: path.to_path_buf(),
            prompt_offset,
        })
    }

    /// Asks the actor to load `request`, waiting until it has.
    async fn load_preview(
        actor: &ActorRef<SearchActor>,
        request: Option<SearchCommand>,
    ) -> io::Result<()> {
        let request = request.ok_or_else(|| io::Error::other("no hit selected"))?;
        actor
            .ask(request)
            .await
            .map_err(|err| io::Error::other(format!("{err:?}")))
    }

    /// The role and text of each message in the search picker's preview.
    fn preview_messages(state: &State) -> Option<Vec<(Role, String)>> {
        let app = state.read();
        let preview = app.picker.as_ref()?.search_preview()?;
        Some(
            preview
                .messages
                .iter()
                .map(|(_, role, text)| (*role, text.clone()))
                .collect(),
        )
    }

    /// Waits for the startup indexing to finish.
    async fn backfilled(state: &State) -> bool {
        eventually(|| {
            let search = &state.read().search;
            search.total > 0 && search.indexed == search.total
        })
        .await
    }

    /// Polls `done` until it holds, for up to 5 s.
    async fn eventually<F>(done: F) -> bool
    where
        F: Fn() -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            if Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        true
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn startup_indexes_every_live_agents_transcript() -> io::Result<()> {
        // Given two agents whose transcripts say `alpha` and `bravo`.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("alpha words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("bravo words")])?;
        let state = State::new(app(vec![
            agent(1, 1_000, Some(a), 20),
            agent(2, 2_000, Some(b), 10),
        ]));
        let index_path = dir.path().join("search.sqlite");

        // When the actor starts and the backfill finishes.
        let _actor = spawn_search_actor(deps(&state, index_path.clone()));
        let done = eventually(|| {
            let search = &state.read().search;
            search.total == 2 && search.indexed == 2
        })
        .await;

        // Then the index file finds both words.
        let found = (
            indexed(&index_path, "alpha")?,
            indexed(&index_path, "bravo")?,
        );
        assert!(
            done && found == (vec![AgentId(1)], vec![AgentId(2)]),
            "both transcripts should be indexed, saw {found:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn startup_skips_a_deleted_transcript_without_logging() -> io::Result<()> {
        // Given an agent whose transcript file was deleted.
        let dir = tempfile::tempdir()?;
        let gone = dir.path().join("gone.jsonl");
        let state = State::new(app(vec![agent(1, 1_000, Some(gone), 10)]));
        let log_path = dir.path().join("orb.log");
        let deps = SearchActorDeps {
            log: Log::new(log_path.clone()),
            ..deps(&state, dir.path().join("search.sqlite"))
        };

        // When the actor starts and the backfill finishes.
        let _actor = spawn_search_actor(deps);
        let done = backfilled(&state).await;

        // Then nothing is logged for it.
        let logged = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            done && logged.is_empty(),
            "a deleted transcript should be skipped quietly, logged {logged:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn unopenable_index_sets_the_search_error() -> io::Result<()> {
        // Given an index path that is a directory.
        let dir = tempfile::tempdir()?;
        let state = State::new(app(Vec::new()));

        // When the actor starts.
        let actor = spawn_search_actor(deps(&state, dir.path().to_path_buf()));
        actor.wait_for_startup().await;

        // Then search reports why it is unavailable.
        assert!(
            state.read().search.error.is_some(),
            "an unopenable index should set the search error"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test]
    async fn query_during_backfill_lists_only_indexed_transcripts() -> io::Result<()> {
        // Given agents 1 and 2 both saying `shared`, only agent 1's
        // transcript indexed by an earlier run, and the picker searching it.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("shared words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("shared words")])?;
        let index_path = dir.path().join("search.sqlite");
        SearchIndex::open(&index_path)
            .and_then(|mut index| index.index_transcript((AgentId(1), 1_000), &a, read_messages))
            .map_err(|report| io::Error::other(format!("{report:?}")))?;
        let state = State::new(app(vec![
            agent(1, 1_000, Some(a), 20),
            agent(2, 2_000, Some(b), 10),
        ]));
        searching(&state, "shared");

        // When the query reaches the actor ahead of its startup indexing (a
        // current-agent runtime runs the actor only once the test awaits).
        let actor = spawn_search_actor(deps(&state, index_path));
        search(&actor, "shared").await?;

        // Then only the already indexed agent is listed; agent 2 waits for
        // the backfill.
        let rows = hit_rows(&state);
        assert_eq!(
            rows,
            vec![(AgentId(1), "shared words".to_owned())],
            "only indexed transcripts should be listed during backfill"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_finds_a_message_added_since_the_last_query() -> io::Result<()> {
        // Given a backfilled transcript that then gains a prompt.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("old words")])?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a.clone()), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        transcript(
            dir.path(),
            "a.jsonl",
            &[prompt("old words"), prompt("fresh words")],
        )?;
        searching(&state, "fresh");

        // When searching for the new prompt.
        search(&actor, "fresh").await?;

        // Then it is listed.
        let rows = hit_rows(&state);
        assert!(
            done && rows == vec![(AgentId(1), "fresh words".to_owned())],
            "a prompt added since the backfill should be found, saw {rows:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_drops_the_rows_of_an_agent_gone_from_state() -> io::Result<()> {
        // Given agents 1 and 2 saying `shared`, backfilled, then agent 2
        // gone from the app state.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("shared words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("shared words")])?;
        let state = State::new(app(vec![
            agent(1, 1_000, Some(a), 20),
            agent(2, 2_000, Some(b), 10),
        ]));
        let index_path = dir.path().join("search.sqlite");
        let actor = spawn_search_actor(deps(&state, index_path.clone()));
        let done = backfilled(&state).await;
        for project in &mut state.write().sessions.projects {
            project.agents.retain(|agent| agent.id != AgentId(2));
        }
        searching(&state, "shared");

        // When searching.
        search(&actor, "shared").await?;

        // Then the index holds `shared` only for agent 1.
        let found = indexed(&index_path, "shared")?;
        assert!(
            done && found == vec![AgentId(1)],
            "a gone agent's rows should leave the index, saw {found:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_still_matches_the_transcript_before_clear() -> io::Result<()> {
        // Given a backfilled transcript, then `/clear` moving the agent to a
        // new one.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("before words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("after words")])?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        for project in &mut state.write().sessions.projects {
            for agent in &mut project.agents {
                agent.transcript = Some(b.clone());
            }
        }
        searching(&state, "before");

        // When searching for the earlier transcript's prompt.
        search(&actor, "before").await?;

        // Then it is still listed.
        let rows = hit_rows(&state);
        assert!(
            done && rows == vec![(AgentId(1), "before words".to_owned())],
            "the transcript before /clear should still match, saw {rows:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn stale_query_leaves_the_picker_rows_unchanged() -> io::Result<()> {
        // Given the picker listing the `alpha` row for `alpha`.
        let dir = tempfile::tempdir()?;
        let a = transcript(
            dir.path(),
            "a.jsonl",
            &[prompt("alpha words"), prompt("bravo words")],
        )?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "alpha");
        search(&actor, "alpha").await?;

        // When a query for text no longer typed arrives.
        search(&actor, "bravo").await?;

        // Then the rows are still the `alpha` ones.
        let rows = hit_rows(&state);
        assert!(
            done && rows == vec![(AgentId(1), "alpha words".to_owned())],
            "a stale query should leave the rows alone, saw {rows:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_labels_a_hit_with_its_project_and_session_title() -> io::Result<()> {
        // Given a backfilled agent titled `fix` in project `orb`, running in
        // a session the user named `login`.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("some words")])?;
        let mut app = app(vec![Agent {
            title: Some("fix".to_owned()),
            ..agent(1, 1_000, Some(a), 20)
        }]);
        app.sessions.sessions = sessions_for(&app.sessions.projects);
        for session in &mut app.sessions.sessions {
            session.name = Some("login".to_owned());
        }
        let state = State::new(app);
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "words");

        // When searching.
        search(&actor, "words").await?;

        // Then the row is labelled `orb/login` with the title after `orb/`.
        let label = state
            .read()
            .picker
            .as_ref()
            .and_then(PickerState::selected)
            .and_then(|item| match item {
                PickerItem::Hit { label, split, .. } => Some((label.clone(), *split)),
                _ => None,
            });
        assert!(
            done && label == Some(("orb/login".to_owned(), 4)),
            "the hit should be labelled with its project and session title, saw {label:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn preview_for_a_hit_no_longer_selected_is_not_written() -> io::Result<()> {
        // Given two hit rows for `shared` and the selection moved off the
        // first one after its preview was asked for.
        let dir = tempfile::tempdir()?;
        let a = transcript(
            dir.path(),
            "a.jsonl",
            &[prompt("shared one"), prompt("shared two")],
        )?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "shared");
        search(&actor, "shared").await?;
        let request = selected_preview(&state);
        if let Some(picker) = &mut state.write().picker {
            picker.next();
        }

        // When the first row's preview arrives.
        load_preview(&actor, request).await?;

        // Then no preview is shown.
        let messages = preview_messages(&state);
        assert!(
            done && messages.is_none(),
            "a preview for a hit no longer selected should not be written, saw {messages:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_shows_the_first_hits_preview() -> io::Result<()> {
        // Given a prompt and its reply, and the search picker open on
        // `question`.
        let dir = tempfile::tempdir()?;
        let a = transcript(
            dir.path(),
            "a.jsonl",
            &[prompt("question words"), reply("answer text")],
        )?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "question");

        // When the query runs.
        search(&actor, "question").await?;

        // Then the first row's exchange is already in the preview.
        let messages = preview_messages(&state);
        assert!(
            done && messages
                == Some(vec![
                    (Role::User, "question words".to_owned()),
                    (Role::Assistant, "answer text".to_owned()),
                ]),
            "a query should load the first hit's preview, saw {messages:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn preview_for_the_selected_hit_shows_its_exchange() -> io::Result<()> {
        // Given a prompt and its reply, with the prompt's hit row selected.
        let dir = tempfile::tempdir()?;
        let a = transcript(
            dir.path(),
            "a.jsonl",
            &[prompt("question words"), reply("answer text")],
        )?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "question");
        search(&actor, "question").await?;

        // When the selected hit's preview is loaded.
        load_preview(&actor, selected_preview(&state)).await?;

        // Then it shows the prompt, then the reply.
        let messages = preview_messages(&state);
        assert!(
            done && messages
                == Some(vec![
                    (Role::User, "question words".to_owned()),
                    (Role::Assistant, "answer text".to_owned()),
                ]),
            "the preview should be the hit's exchange, saw {messages:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn backfill_counts_up_one_transcript_at_a_time() -> io::Result<()> {
        // Given two agents with transcripts, and a reporter that records
        // the indexing progress each time the actor reports to the frontend.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("alpha words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("bravo words")])?;
        let state = State::new(app(vec![
            agent(1, 1_000, Some(a), 20),
            agent(2, 2_000, Some(b), 10),
        ]));
        let seen: Arc<Mutex<Vec<(usize, usize)>>> = Arc::default();
        let report = {
            let state = state.clone();
            let seen = Arc::clone(&seen);
            Reporter::new(move |_| {
                let progress = {
                    let search = &state.read().search;
                    (search.indexed, search.total)
                };
                seen.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(progress);
            })
        };

        // When the actor starts and the backfill finishes.
        let _actor = spawn_search_actor(SearchActorDeps {
            report,
            ..deps(&state, dir.path().join("search.sqlite"))
        });
        let done = backfilled(&state).await;

        // Then the frontend saw 0, 1, then 2 of 2 indexed.
        let seen = seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(
            done && seen == vec![(0, 2), (1, 2), (2, 2)],
            "progress should count each transcript as it is indexed, saw {seen:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_lists_a_settled_agents_messages() -> io::Result<()> {
        // Given a backfilled settled agent.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("settled words")])?;
        let mut app = app(vec![agent(1, 1_000, Some(a), 20)]);
        app.sessions.sessions = sessions_for(&app.sessions.projects);
        if let Some(session) = app.sessions.sessions.get_mut(0) {
            session.settled_at = Some(UNIX_EPOCH + Duration::from_secs(30));
        }
        let state = State::new(app);
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "settled");

        // When searching.
        search(&actor, "settled").await?;

        // Then its message is listed.
        let rows = hit_rows(&state);
        assert!(
            done && rows == vec![(AgentId(1), "settled words".to_owned())],
            "a settled agent's messages should match, saw {rows:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_ignores_the_project_filter() -> io::Result<()> {
        // Given a backfilled agent in `orb` and the sidebar filtered to
        // another project.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("global words")])?;
        let state = State::new(app(vec![agent(1, 1_000, Some(a), 20)]));
        state.write().sessions.filter = Some(ProjectId(2));
        let actor = spawn_search_actor(deps(&state, dir.path().join("search.sqlite")));
        let done = backfilled(&state).await;
        searching(&state, "global");

        // When searching.
        search(&actor, "global").await?;

        // Then the `orb` agent's message is still listed.
        let rows = hit_rows(&state);
        assert!(
            done && rows == vec![(AgentId(1), "global words".to_owned())],
            "the project filter should not narrow search, saw {rows:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread")]
    async fn query_drops_the_rows_of_an_agent_being_deleted() -> io::Result<()> {
        // Given agents 1 and 2 saying `shared`, backfilled, then agent 2
        // being deleted.
        let dir = tempfile::tempdir()?;
        let a = transcript(dir.path(), "a.jsonl", &[prompt("shared words")])?;
        let b = transcript(dir.path(), "b.jsonl", &[prompt("shared words")])?;
        let state = State::new(app(vec![
            agent(1, 1_000, Some(a), 20),
            agent(2, 2_000, Some(b), 10),
        ]));
        let index_path = dir.path().join("search.sqlite");
        let actor = spawn_search_actor(deps(&state, index_path.clone()));
        let done = backfilled(&state).await;
        state.write().sessions.deleting.insert(SessionId(2));
        searching(&state, "shared");

        // When searching.
        search(&actor, "shared").await?;

        // Then the index holds `shared` only for agent 1.
        let found = indexed(&index_path, "shared")?;
        assert!(
            done && found == vec![AgentId(1)],
            "an agent being deleted should leave the index, saw {found:?}"
        );
        Ok(())
    }
}
