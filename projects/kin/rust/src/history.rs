//! The canonical event history one engine instance holds.
//!
//! The host keeps the same history in its session arena (event-arena.js) and
//! sends Rust only what changed: `kin_history_append` adds records after the
//! ones already held, `kin_history_truncate` drops records from the end, and
//! `kin_history_reset` empties it. Projections and commands then replay this
//! history instead of receiving it whole in every request.
//!
//! Records are stored exactly as received: one contiguous byte buffer and an
//! `(offset, length)` span per record, in local arrival order. Each record is
//! checked when it is appended; replay decodes them again (zero-copy decoding
//! is a later slice).
//!
//! Append batch layout: u32 record count, then one u32 length per record,
//! then the records' bytes back to back.
//!
//! Checkpoint: the history also keeps the `Replay` of its first N records
//! (replay/mod.rs), built in one identity context (target household and
//! bindings). A projection then applies only the records after N, provided
//! all of them come strictly later in replay order than the last record
//! applied. Equal logical times could make an earlier decision concurrent
//! with a new archive, so those rebuild instead. A different context, or a
//! truncation below N, also rebuilds. Either way the result equals a replay
//! of the whole history.
//!
//! Two logs: an engine instance holds the household history and, apart from
//! it, the chat log (#109). Chat events are encrypted under the chat key, are
//! far more numerous than household events, and never enter the KINS
//! projection, so they get their own log with its own cap
//! (`MAX_CHAT_EVENT_COUNT`) and their own checkpoint. Each log refuses the
//! other's events, so neither count eats into the other's.
//!
//! A third log holds the fridge (#317, board.rs): many small drawing events
//! that never enter the KINS projection, with their own cap
//! (`MAX_BOARD_EVENT_COUNT`) and checkpoint. Every log refuses the others'
//! events.
//!
//! A fourth holds one member's private records (#489, ADR 0019, private.rs):
//! sealed under the member key, never part of household replay or KINS,
//! with its own cap (`MAX_PRIVATE_EVENT_COUNT`) and checkpoint.
use crate::error::KinError;
use crate::event::HouseholdId;
use crate::event::IdentityBinding;
use crate::event_decode::{decode_event, EventView};
use crate::replay::Replay;
use crate::request::DecodedRequest;
use crate::state::{summarize, CatchUpSummary, HouseholdState, SummaryInput};
use crate::wire::{read_u32, MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};

/// Which events a history holds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Log {
    /// Every event but chat; at most `MAX_EVENT_COUNT`.
    Household,
    /// Chat events only; at most `MAX_CHAT_EVENT_COUNT`.
    Chat,
    /// Fridge events only (#317); at most `MAX_BOARD_EVENT_COUNT`.
    Board,
    /// One member's private events only (#489); at most
    /// `MAX_PRIVATE_EVENT_COUNT`.
    Private,
}

impl Log {
    /// The log an event of this kind belongs in.
    pub const fn of_kind(kind: &crate::event::EventKind) -> Self {
        if kind.is_chat() {
            Self::Chat
        } else if kind.is_board() {
            Self::Board
        } else if kind.is_private() {
            Self::Private
        } else {
            Self::Household
        }
    }
}

pub struct History {
    log: Log,
    bytes: Vec<u8>,
    spans: Vec<(u32, u32)>,
    checkpoint: Option<Checkpoint>,
    /// Whether the last replay() reused the checkpoint (tests only).
    #[cfg(test)]
    reused: bool,
}

/// The replay of the first `records` records in one identity context.
struct Checkpoint {
    records: usize,
    target_household_id: Option<HouseholdId>,
    identity_bindings: Vec<IdentityBinding>,
    replay: Replay,
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

impl History {
    pub const fn new() -> Self {
        Self::of(Log::Household)
    }

    /// An empty chat log.
    pub const fn chat() -> Self {
        Self::of(Log::Chat)
    }

    /// An empty board (fridge) log.
    pub const fn board() -> Self {
        Self::of(Log::Board)
    }

    /// An empty private log (one member's, #489).
    pub const fn private() -> Self {
        Self::of(Log::Private)
    }

    const fn of(log: Log) -> Self {
        Self {
            log,
            bytes: Vec::new(),
            spans: Vec::new(),
            checkpoint: None,
            #[cfg(test)]
            reused: false,
        }
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn log(&self) -> Log {
        self.log
    }

    /// Most records this history holds.
    pub fn limit(&self) -> usize {
        match self.log {
            Log::Household => MAX_EVENT_COUNT,
            Log::Chat => crate::chat::MAX_CHAT_EVENT_COUNT,
            Log::Board => crate::board::MAX_BOARD_EVENT_COUNT,
            Log::Private => crate::private::MAX_PRIVATE_EVENT_COUNT,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// Each record read in place (event_decode.rs). Every record was fully
    /// checked when appended, so a view never fails here.
    pub fn views(&self) -> impl Iterator<Item = EventView<'_>> {
        self.records()
            .filter_map(|record| EventView::new(record).ok())
    }

    pub fn records(&self) -> impl Iterator<Item = &[u8]> {
        self.spans
            .iter()
            .map(|&(offset, length)| &self.bytes[offset as usize..(offset + length) as usize])
    }

    /// Appends a batch after the records already held. The whole batch is
    /// checked first, so a bad record leaves the history unchanged.
    pub fn append(&mut self, batch: &[u8]) -> Result<(), KinError> {
        let count = read_u32(batch, 0)? as usize;
        let total = self.len().checked_add(count).ok_or(KinError::SizeLimit)?;
        if total > self.limit() {
            return Err(KinError::SizeLimit);
        }
        let table_end = count
            .checked_mul(4)
            .and_then(|bytes| bytes.checked_add(4))
            .ok_or(KinError::MalformedProtocol)?;
        if table_end > batch.len() {
            return Err(KinError::MalformedProtocol);
        }
        let mut lengths = Vec::new();
        lengths
            .try_reserve_exact(count)
            .map_err(|_| KinError::SizeLimit)?;
        let mut offset = table_end;
        for index in 0..count {
            let length = read_u32(batch, 4 + index * 4)? as usize;
            let end = offset
                .checked_add(length)
                .ok_or(KinError::MalformedProtocol)?;
            let record = batch.get(offset..end).ok_or(KinError::MalformedProtocol)?;
            if Log::of_kind(&decode_event(record)?.kind) != self.log {
                return Err(KinError::InvalidEvent);
            }
            lengths.push(length);
            offset = end;
        }
        if offset != batch.len() {
            return Err(KinError::MalformedProtocol);
        }
        let added = batch.len() - table_end;
        if self.bytes.len().saturating_add(added) > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        if self.bytes.capacity() - self.bytes.len() < added {
            // Reserve an eighth more than the history will hold, so the next
            // appends of a few events copy nothing, without the default
            // doubling, which would reserve a second full history.
            let headroom = added + (self.bytes.len() + added) / 8;
            self.bytes
                .try_reserve_exact(headroom)
                .map_err(|_| KinError::SizeLimit)?;
        }
        self.spans
            .try_reserve(count)
            .map_err(|_| KinError::SizeLimit)?;
        let mut start = self.bytes.len();
        self.bytes.extend_from_slice(&batch[table_end..]);
        for length in lengths {
            // Bounded by MAX_PROTOCOL_BYTES, so offsets and lengths fit in u32.
            self.spans.push((start as u32, length as u32));
            start += length;
        }
        Ok(())
    }

    /// Keeps the first `count` records.
    pub fn truncate(&mut self, count: usize) -> Result<(), KinError> {
        if count > self.len() {
            return Err(KinError::InvalidAbi);
        }
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.records > count)
        {
            self.checkpoint = None;
        }
        let end = self
            .spans
            .get(count)
            .map_or(self.bytes.len(), |&(offset, _)| offset as usize);
        self.bytes[end..].fill(0);
        self.bytes.truncate(end);
        self.spans.truncate(count);
        Ok(())
    }

    /// Empties the history, zero-filling its bytes before releasing them.
    /// (Zero-filling covers this buffer only; it is no erasure guarantee.)
    pub fn clear(&mut self) {
        self.bytes.fill(0);
        self.bytes = Vec::new();
        self.spans = Vec::new();
        self.checkpoint = None;
    }

    /// The replay of every held record in `context`'s identity (a decoded
    /// record-less request), reusing and then advancing the checkpoint when
    /// it is valid. Only records the checkpoint has not applied are decoded.
    /// On an error the checkpoint is dropped, since it may be partly applied.
    pub fn replay(&mut self, context: &DecodedRequest) -> Result<&Replay, KinError> {
        let reusable = self.checkpoint.take().filter(|checkpoint| {
            checkpoint.records <= self.spans.len()
                && checkpoint.target_household_id == context.target_household_id
                && checkpoint.identity_bindings == context.identity_bindings
                && self
                    .views()
                    .skip(checkpoint.records)
                    .all(|view| view.logical_time() > checkpoint.replay.last_logical_time())
        });
        #[cfg(test)]
        {
            self.reused = reusable.is_some();
        }
        let (mut replay, from) = match reusable {
            Some(checkpoint) => (checkpoint.replay, checkpoint.records),
            None => (Replay::new(), 0),
        };
        let mut newer = Vec::new();
        newer
            .try_reserve_exact(self.spans.len() - from)
            .map_err(|_| KinError::SizeLimit)?;
        for record in self.records().skip(from) {
            newer.push(context.decode_bound(record)?);
        }
        newer.sort_by_key(|event| (event.logical_time, event.device_id, event.event_id));
        replay.note_archives(&newer);
        for event in &newer {
            replay.apply(event)?;
        }
        let checkpoint = self.checkpoint.insert(Checkpoint {
            records: self.spans.len(),
            target_household_id: context.target_household_id,
            identity_bindings: context.identity_bindings.clone(),
            replay,
        });
        Ok(&checkpoint.replay)
    }

    /// The checkpoint's replay, after `replay()` brought it up to date.
    pub fn replayed(&self) -> Option<&Replay> {
        self.checkpoint
            .as_ref()
            .map(|checkpoint| &checkpoint.replay)
    }

    /// The catch-up summary of the held records, plus `extra` (a command's
    /// new event) when given, read from the records in place.
    pub fn summary(
        &self,
        context: &DecodedRequest,
        state: &HouseholdState,
        extra: Option<&crate::event::EventEnvelope>,
    ) -> Result<CatchUpSummary, KinError> {
        let mut inputs = Vec::new();
        inputs
            .try_reserve_exact(self.spans.len() + 1)
            .map_err(|_| KinError::SizeLimit)?;
        inputs.extend(
            self.views()
                .map(|view| (view.event_id(), SummaryInput::from_view(&view))),
        );
        if let Some(event) = extra {
            inputs.push((event.event_id, SummaryInput::from_kind(&event.kind)));
        }
        summarize(&inputs, context.summary_cursor, state)
    }

    #[cfg(test)]
    pub(crate) fn last_replay_reused(&self) -> bool {
        self.reused
    }
}
