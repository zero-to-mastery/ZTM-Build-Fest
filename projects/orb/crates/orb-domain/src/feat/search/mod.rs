//! Search — finding what was said in orb's agents.
//!
//! orb keeps an index of the prompts the user typed and the text replies
//! from every agent's transcripts, so typed text finds the messages that
//! contain it, newest first, and the exchange each one belongs to.
//!
//! The index fills in the background at startup, newest chat first, and
//! catches up on the lines added since the last read before every query.

pub mod index;
pub mod search_actor;
pub mod state;
