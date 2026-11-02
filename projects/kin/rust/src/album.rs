//! The shared photo frame (#673, ADR 0022 §5): the household's family album.
//!
//! **Kinds.** `ALBUM_PHOTO_ADDED` (75) puts a photo in the album: its photo
//! ID, the household attachment that holds the encrypted image, and an
//! optional caption. `ALBUM_PHOTO_REMOVED` (76) takes one out. Both live in
//! the household log, like every other household record.
//!
//! **The image.** A photo's bytes are a household attachment blob, encrypted
//! on the device under the household key exactly as an item's photo is
//! (attachments/attachment-crypto.js), uploaded to the same encrypted
//! attachment store and never seen by the service. An album attachment's ID
//! starts with the two bytes `A1 B0` (`ALBUM_ATTACHMENT_PREFIX`), so the
//! service can keep album blobs within their own quota and leave them out of
//! the listing older devices reconcile (they would otherwise treat a blob no
//! kind-39 binding names as an orphan and delete it). The prefix is part of
//! the canonical payload: a kind-75 event naming any other ID is malformed
//! (code 2).
//!
//! **Payloads** (strict: they decode only if they re-encode to the same
//! bytes):
//! - 75: photo ID [16], attachment ID [16], caption (u16 length + UTF-8; 0
//!   for none). The caption is trimmed, at most 200 bytes, with no control
//!   characters (one line).
//! - 76: photo ID [16].
//!
//! **Replay.**
//! - Adding needs a new photo ID (not live and not among the recent
//!   removals), an attachment no live photo uses, and fewer than
//!   `MAX_ALBUM_PHOTOS` live photos. Otherwise the event is refused (code 4).
//! - Removing a live photo moves it to the recent removals, which keep the
//!   last `ALBUM_RECENT_REMOVALS` with their time. Removing a photo that is
//!   already among them changes nothing: two devices removed it at once.
//!   Removing a photo the album never had is refused.
//! - The recent removals let a host keep a removed photo's blob for a short
//!   while, so Undo can put the same attachment back under a new photo ID
//!   (`album-photo` undo entries, web/undo.js). Hosts decide how long; Rust
//!   only reports when each was removed.
//!
//! **Who may remove a photo.** Whoever added it, or a household admin (owner
//! decision, ADR 0022 §5). Rust knows who added a photo but not who is an
//! admin; the service and the host do. So, as for the sitter page, the
//! single command append path checks it before the command reaches Rust
//! (`canRemoveAlbumPhoto` in web/wasm/kin-album.js), and replay accepts a
//! removal from any member: a kind-76 event from another device is history,
//! and the service has already admitted its author to the household
//! (THREAT-MODEL).
//!
//! Hosts read the album through `kin_album` (KALB), below; it is not part of
//! the frozen KINS projection.
use std::collections::VecDeque;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, EventEnvelope, EventKind};
use crate::meals::{push_text, read_text};
use crate::wire::read_id;

pub const ALBUM_PHOTO_ADDED: u16 = 75;
pub const ALBUM_PHOTO_REMOVED: u16 = 76;

/// At most this many photos in the album at once.
pub const MAX_ALBUM_PHOTOS: usize = 500;
/// A caption's UTF-8 length, after trimming.
pub const MAX_ALBUM_CAPTION_BYTES: usize = 200;
/// How many removals the album remembers (newest kept).
pub const ALBUM_RECENT_REMOVALS: usize = 64;
/// The first two bytes of every album attachment ID.
pub const ALBUM_ATTACHMENT_PREFIX: [u8; 2] = [0xa1, 0xb0];

pub const fn is_album_code(code: u16) -> bool {
    code == ALBUM_PHOTO_ADDED || code == ALBUM_PHOTO_REMOVED
}

/// Whether `id` can hold an album photo's image: the album prefix, and
/// something after it.
pub fn is_album_attachment(id: &[u8; 16]) -> bool {
    id[..2] == ALBUM_ATTACHMENT_PREFIX && id[2..].iter().any(|byte| *byte != 0)
}

/// A caption in canonical form: trimmed (Unicode white space, as
/// `str::trim`), 0–200 UTF-8 bytes, no control characters at all.
pub fn normalize_album_caption(caption: &str) -> Result<String, KinError> {
    let caption = caption.trim();
    if caption.len() > MAX_ALBUM_CAPTION_BYTES || caption.chars().any(char::is_control) {
        return Err(KinError::InvalidEvent);
    }
    Ok(caption.to_owned())
}

/// A photo in the album.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AlbumPhoto {
    pub photo_id: [u8; 16],
    pub attachment_id: [u8; 16],
    pub caption: String,
    /// The member whose device added it (the event's actor).
    pub added_by: ActorId,
    /// When it was added (the event's timestamp, Unix milliseconds).
    pub added_at: i64,
}

/// A photo removed recently: enough for a host to keep its blob a while.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemovedAlbumPhoto {
    pub photo_id: [u8; 16],
    pub attachment_id: [u8; 16],
    /// When it was removed (the event's timestamp, Unix milliseconds).
    pub removed_at: i64,
}

/// The album: live photos in the order they were added, and the recent
/// removals, oldest first. Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AlbumState {
    pub photos: Vec<AlbumPhoto>,
    pub removed: VecDeque<RemovedAlbumPhoto>,
}

impl AlbumState {
    pub fn photo(&self, photo_id: &[u8; 16]) -> Option<&AlbumPhoto> {
        self.photos.iter().find(|photo| photo.photo_id == *photo_id)
    }

    fn removed(&self, photo_id: &[u8; 16]) -> bool {
        self.removed.iter().any(|entry| entry.photo_id == *photo_id)
    }

    /// Whether `kind` could be added now: the rules replay applies (code 4).
    fn check_add(&self, photo_id: &[u8; 16], attachment_id: &[u8; 16]) -> Result<(), KinError> {
        if self.photo(photo_id).is_some()
            || self.removed(photo_id)
            || self
                .photos
                .iter()
                .any(|photo| photo.attachment_id == *attachment_id)
            || self.photos.len() >= MAX_ALBUM_PHOTOS
        {
            return Err(KinError::InvalidEvent);
        }
        Ok(())
    }

    fn apply(&mut self, event: &EventEnvelope) -> Result<(), KinError> {
        match &event.kind {
            EventKind::AlbumPhotoAdded {
                photo_id,
                attachment_id,
                caption,
            } => {
                self.check_add(photo_id, attachment_id)?;
                self.photos.push(AlbumPhoto {
                    photo_id: *photo_id,
                    attachment_id: *attachment_id,
                    caption: caption.clone(),
                    added_by: event.actor_id,
                    added_at: event.timestamp,
                });
            }
            EventKind::AlbumPhotoRemoved { photo_id } => {
                let Some(index) = self
                    .photos
                    .iter()
                    .position(|photo| photo.photo_id == *photo_id)
                else {
                    // Already removed elsewhere: the second removal is a no-op.
                    return if self.removed(photo_id) {
                        Ok(())
                    } else {
                        Err(KinError::InvalidEvent)
                    };
                };
                let photo = self.photos.remove(index);
                if self.removed.len() == ALBUM_RECENT_REMOVALS {
                    self.removed.pop_front();
                }
                self.removed.push_back(RemovedAlbumPhoto {
                    photo_id: photo.photo_id,
                    attachment_id: photo.attachment_id,
                    removed_at: event.timestamp,
                });
            }
            _ => return Err(KinError::Internal),
        }
        Ok(())
    }

    /// Whether `kind`, authored now, is a change the album accepts. Who may
    /// remove a photo is the host's check (module docs).
    pub fn check_command(&self, kind: &EventKind) -> Result<(), KinError> {
        match kind {
            EventKind::AlbumPhotoAdded {
                photo_id,
                attachment_id,
                caption,
            } => {
                check_added(photo_id, attachment_id, caption)?;
                self.check_add(photo_id, attachment_id)
            }
            EventKind::AlbumPhotoRemoved { photo_id } => {
                if self.photo(photo_id).is_none() {
                    return Err(KinError::InvalidEvent);
                }
                Ok(())
            }
            _ => Err(KinError::InvalidEvent),
        }
    }
}

/// Replays one album event into the shared state (copy-on-write).
pub fn apply(album: &mut Arc<AlbumState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(album).apply(event)
}

/// A kind-75 payload's structure: a non-zero photo ID, an album attachment,
/// a canonical caption. Code 2: the payload isn't canonical.
fn check_added(
    photo_id: &[u8; 16],
    attachment_id: &[u8; 16],
    caption: &str,
) -> Result<(), KinError> {
    if *photo_id == [0; 16]
        || !is_album_attachment(attachment_id)
        || normalize_album_caption(caption).ok().as_deref() != Some(caption)
    {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

/// The canonical payload of an album event.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::AlbumPhotoAdded {
            photo_id,
            attachment_id,
            caption,
        } => {
            check_added(photo_id, attachment_id, caption)?;
            let mut out = Vec::with_capacity(34 + caption.len());
            out.extend_from_slice(photo_id);
            out.extend_from_slice(attachment_id);
            push_text(&mut out, caption);
            Ok(out)
        }
        EventKind::AlbumPhotoRemoved { photo_id } => {
            if *photo_id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            Ok(photo_id.to_vec())
        }
        _ => Err(KinError::Internal),
    }
}

/// Decodes an album payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        ALBUM_PHOTO_ADDED => {
            let mut at = 32;
            let caption = read_text(payload, &mut at)?;
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::AlbumPhotoAdded {
                photo_id: read_id(payload, 0)?,
                attachment_id: read_id(payload, 16)?,
                caption,
            }
        }
        ALBUM_PHOTO_REMOVED => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::AlbumPhotoRemoved {
                photo_id: read_id(payload, 0)?,
            }
        }
        _ => return Err(KinError::MalformedProtocol),
    };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// KALB v1, the album as hosts show it: "KALB", version u16 = 1, reserved
/// u16, photo count u32, removal count u32; then each live photo, newest
/// first: photo ID [16], attachment ID [16], added by [16], added at i64,
/// caption (u16 length + UTF-8); then each recent removal, newest first:
/// photo ID [16], attachment ID [16], removed at i64.
pub fn encode_album(album: &AlbumState) -> Vec<u8> {
    let captions: usize = album.photos.iter().map(|photo| photo.caption.len()).sum();
    let mut out =
        Vec::with_capacity(16 + album.photos.len() * 58 + captions + album.removed.len() * 40);
    out.extend_from_slice(b"KALB");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(album.photos.len() as u32).to_le_bytes());
    out.extend_from_slice(&(album.removed.len() as u32).to_le_bytes());
    for photo in album.photos.iter().rev() {
        out.extend_from_slice(&photo.photo_id);
        out.extend_from_slice(&photo.attachment_id);
        out.extend_from_slice(&photo.added_by.0);
        out.extend_from_slice(&photo.added_at.to_le_bytes());
        push_text(&mut out, &photo.caption);
    }
    for removed in album.removed.iter().rev() {
        out.extend_from_slice(&removed.photo_id);
        out.extend_from_slice(&removed.attachment_id);
        out.extend_from_slice(&removed.removed_at.to_le_bytes());
    }
    out
}
