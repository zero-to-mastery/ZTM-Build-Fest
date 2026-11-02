pub mod abi;
pub mod album;
pub mod archive;
pub mod audio;
pub mod board;
pub mod calendar;
pub mod calendar_range;
pub mod calendar_recur;
pub mod chat;
pub mod chat_search;
pub mod chores;
pub mod codec;
pub mod command;
pub mod core;
pub mod error;
pub mod event;
pub mod event_decode;
pub mod history;
pub mod ical;
pub mod journal;
pub mod meals;
pub mod private;
pub mod private_command;
pub mod private_items;
pub mod private_prefs;
pub mod qr;
pub mod recurrence;
pub mod replay;
pub mod request;
pub mod rotations;
pub mod sections;
pub mod simple;
pub mod sitter;
pub mod state;
pub mod state_encode;
pub mod store_sections;
pub mod week;
pub mod wire;

#[cfg(test)]
mod pulse_tests;

#[cfg(test)]
mod catchup_tests;

#[cfg(test)]
mod routine_tests;

#[cfg(test)]
mod command_tests;

#[cfg(test)]
mod area_tests;

#[cfg(test)]
mod note_tests;

#[cfg(test)]
mod step_tests;

#[cfg(test)]
mod mode_tests;

#[cfg(test)]
mod pin_tests;

#[cfg(test)]
mod playbook_tests;

#[cfg(test)]
mod maintenance_tests;

#[cfg(test)]
mod attachment_tests;

#[cfg(test)]
mod responsibility_tests;

#[cfg(test)]
mod device_name_tests;

#[cfg(test)]
mod member_name_tests;

#[cfg(test)]
mod chat_tests;
#[cfg(test)]
mod chore_tests;

#[cfg(test)]
mod album_tests;
#[cfg(test)]
mod board_tests;
#[cfg(test)]
mod calendar_tests;
#[cfg(test)]
mod ical_tests;
#[cfg(test)]
mod journal_tests;
#[cfg(test)]
mod meals_tests;
#[cfg(test)]
mod private_item_tests;
#[cfg(test)]
mod private_prefs_tests;
#[cfg(test)]
mod private_tests;
#[cfg(test)]
mod rotation_tests;
#[cfg(test)]
mod shopping_section_tests;
#[cfg(test)]
mod simple_tests;
#[cfg(test)]
mod sitter_tests;

#[cfg(test)]
mod recurring_task_tests;

#[cfg(test)]
mod golden_tests;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod request_tests;

#[cfg(test)]
mod event_decode_tests;

#[cfg(test)]
mod state_encode_tests;

#[cfg(test)]
mod section_tests;

#[cfg(test)]
mod history_tests;

#[cfg(test)]
mod convergence_tests;

#[cfg(test)]
mod week_tests;
