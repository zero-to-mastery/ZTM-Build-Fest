//! zmx — what keeps a pane's program running after orb quits.
//!
//! Every pane runs its program under zmx, so quitting orb leaves it running.
//! orb attaches a pane with `zmx attach`, reads which sessions run with
//! `zmx list`, and ends one with `zmx kill`.

pub mod zmx_cli;
pub mod zmx_service;
