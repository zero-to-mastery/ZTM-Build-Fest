//! The Service Control Manager's side, declared by hand (no `windows-sys`,
//! no `winapi`): three functions from advapi32 and the structures they take,
//! laid out exactly as in `winsvc.h`. The declarations and the conversions
//! compile on every platform, so they are type-checked and tested on Linux
//! too; only Windows links advapi32 and calls them (`main.rs`).
//!
//! Unsafe code lives here only. Its invariants:
//! - `ServiceStatus` and `ServiceTableEntryW` are `#[repr(C)]` copies of
//!   `SERVICE_STATUS` and `SERVICE_TABLE_ENTRYW` (seven DWORDs; a pointer
//!   and a function pointer).
//! - Strings passed to Windows are NUL-terminated UTF-16 that outlive the
//!   call: the dispatcher table's name lives in `main`'s frame, which waits
//!   in `StartServiceCtrlDispatcherW` until the service has stopped.
//! - The control handler only sends on a channel; it never blocks, as the
//!   dispatcher thread that calls it must stay responsive.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::driver::Control;
use crate::machine::{Exit, ServiceState, Status};
use std::ffi::c_void;

pub type Handle = *mut c_void;

/// `LPSERVICE_MAIN_FUNCTIONW`.
pub type ServiceMain = unsafe extern "system" fn(argc: u32, argv: *mut *mut u16);
/// `LPHANDLER_FUNCTION_EX`.
pub type HandlerEx = unsafe extern "system" fn(
    control: u32,
    event_type: u32,
    event_data: *mut c_void,
    context: *mut c_void,
) -> u32;

/// `SERVICE_TABLE_ENTRYW`.
#[repr(C)]
pub struct ServiceTableEntryW {
    pub service_name: *mut u16,
    pub service_proc: Option<ServiceMain>,
}

/// `SERVICE_STATUS`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceStatus {
    pub service_type: u32,
    pub current_state: u32,
    pub controls_accepted: u32,
    pub win32_exit_code: u32,
    pub service_specific_exit_code: u32,
    pub check_point: u32,
    pub wait_hint: u32,
}

#[cfg_attr(windows, link(name = "advapi32"))]
extern "system" {
    pub fn StartServiceCtrlDispatcherW(table: *const ServiceTableEntryW) -> i32;
    pub fn RegisterServiceCtrlHandlerExW(
        service_name: *const u16,
        handler: Option<HandlerEx>,
        context: *mut c_void,
    ) -> Handle;
    pub fn SetServiceStatus(handle: Handle, status: *const ServiceStatus) -> i32;
}

pub const SERVICE_WIN32_OWN_PROCESS: u32 = 0x0000_0010;

pub const SERVICE_STOPPED: u32 = 1;
pub const SERVICE_START_PENDING: u32 = 2;
pub const SERVICE_STOP_PENDING: u32 = 3;
pub const SERVICE_RUNNING: u32 = 4;

pub const SERVICE_ACCEPT_STOP: u32 = 0x0000_0001;
pub const SERVICE_ACCEPT_SHUTDOWN: u32 = 0x0000_0004;
pub const SERVICE_ACCEPT_PRESHUTDOWN: u32 = 0x0000_0100;

pub const SERVICE_CONTROL_STOP: u32 = 0x0000_0001;
pub const SERVICE_CONTROL_INTERROGATE: u32 = 0x0000_0004;
pub const SERVICE_CONTROL_SHUTDOWN: u32 = 0x0000_0005;
pub const SERVICE_CONTROL_PRESHUTDOWN: u32 = 0x0000_000F;

pub const NO_ERROR: u32 = 0;
pub const ERROR_INVALID_PARAMETER: u32 = 87;
pub const ERROR_CALL_NOT_IMPLEMENTED: u32 = 120;
pub const ERROR_SERVICE_SPECIFIC_ERROR: u32 = 1066;
/// StartServiceCtrlDispatcherW's error when the program wasn't started by
/// the Service Control Manager (run by hand from a console).
pub const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: i32 = 1063;

/// `text` as NUL-terminated UTF-16.
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A `Status` as Windows takes it.
///
/// The service accepts stop, shutdown and preshutdown while it runs.
/// Preshutdown comes first at system shutdown and lets Windows wait (up to
/// its preshutdown timeout) while Kin closes its database; plain shutdown
/// gives a service only a few seconds. Either one, whichever comes, starts
/// the same stop.
pub fn service_status(status: &Status) -> ServiceStatus {
    let current_state = match status.state {
        ServiceState::StartPending => SERVICE_START_PENDING,
        ServiceState::Running => SERVICE_RUNNING,
        ServiceState::StopPending => SERVICE_STOP_PENDING,
        ServiceState::Stopped => SERVICE_STOPPED,
    };
    let (win32_exit_code, service_specific_exit_code) = match status.exit {
        Exit::Success => (NO_ERROR, 0),
        Exit::Child(code) => (ERROR_SERVICE_SPECIFIC_ERROR, code),
        Exit::Win32(code) => (code, 0),
    };
    ServiceStatus {
        service_type: SERVICE_WIN32_OWN_PROCESS,
        current_state,
        controls_accepted: if status.accepts_stop {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_PRESHUTDOWN
        } else {
            0
        },
        win32_exit_code,
        service_specific_exit_code,
        check_point: status.checkpoint,
        wait_hint: u32::try_from(status.wait_hint.as_millis()).unwrap_or(u32::MAX),
    }
}

/// What a control code asks of the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    Send(Control),
    /// Answer with the last status (Windows does that itself).
    Interrogate,
    NotHandled,
}

pub fn request_for(control: u32) -> Request {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN | SERVICE_CONTROL_PRESHUTDOWN => {
            Request::Send(Control::Stop)
        }
        SERVICE_CONTROL_INTERROGATE => Request::Interrogate,
        _ => Request::NotHandled,
    }
}

/// The handle `RegisterServiceCtrlHandlerExW` returned. Only the service's
/// own thread reports through it.
pub struct StatusHandle(pub Handle);

impl StatusHandle {
    /// Reports `status`. A failed report can't be told to anyone but the
    /// log, so it returns the error for the caller to write there.
    pub fn report(&self, status: &Status) -> std::io::Result<()> {
        let raw = service_status(status);
        // SAFETY: the handle came from RegisterServiceCtrlHandlerExW and
        // stays valid for the life of the process (it is never closed);
        // `raw` is a live SERVICE_STATUS for the duration of the call.
        if unsafe { SetServiceStatus(self.0, &raw) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn status(state: ServiceState, exit: Exit) -> Status {
        Status {
            state,
            exit,
            checkpoint: 3,
            wait_hint: Duration::from_secs(10),
            accepts_stop: state == ServiceState::Running,
        }
    }

    #[test]
    fn the_layouts_match_winsvc_h() {
        assert_eq!(std::mem::size_of::<ServiceStatus>(), 28);
        assert_eq!(
            std::mem::size_of::<ServiceTableEntryW>(),
            2 * std::mem::size_of::<usize>()
        );
        // A null function pointer is the table's terminator.
        assert_eq!(
            std::mem::size_of::<Option<ServiceMain>>(),
            std::mem::size_of::<usize>()
        );
    }

    #[test]
    fn statuses_carry_the_states_and_exit_codes_windows_expects() {
        let running = service_status(&status(ServiceState::Running, Exit::Success));
        assert_eq!(running.service_type, SERVICE_WIN32_OWN_PROCESS);
        assert_eq!(running.current_state, SERVICE_RUNNING);
        assert_eq!(running.controls_accepted, 0x105);
        let pending = service_status(&status(ServiceState::StopPending, Exit::Success));
        assert_eq!(
            (pending.current_state, pending.controls_accepted),
            (SERVICE_STOP_PENDING, 0)
        );
        assert_eq!((pending.check_point, pending.wait_hint), (3, 10_000));
        assert_eq!(
            service_status(&status(ServiceState::StartPending, Exit::Success)).current_state,
            SERVICE_START_PENDING
        );

        let clean = service_status(&status(ServiceState::Stopped, Exit::Success));
        assert_eq!(
            (
                clean.current_state,
                clean.win32_exit_code,
                clean.service_specific_exit_code
            ),
            (SERVICE_STOPPED, 0, 0)
        );
        let child = service_status(&status(ServiceState::Stopped, Exit::Child(7)));
        assert_eq!(
            (child.win32_exit_code, child.service_specific_exit_code),
            (ERROR_SERVICE_SPECIFIC_ERROR, 7)
        );
        let missing = service_status(&status(ServiceState::Stopped, Exit::Win32(2)));
        assert_eq!(
            (missing.win32_exit_code, missing.service_specific_exit_code),
            (2, 0)
        );
    }

    #[test]
    fn stop_shutdown_and_preshutdown_all_stop() {
        for control in [
            SERVICE_CONTROL_STOP,
            SERVICE_CONTROL_SHUTDOWN,
            SERVICE_CONTROL_PRESHUTDOWN,
        ] {
            assert_eq!(request_for(control), Request::Send(Control::Stop));
        }
        assert_eq!(
            request_for(SERVICE_CONTROL_INTERROGATE),
            Request::Interrogate
        );
        assert_eq!(request_for(2), Request::NotHandled); // pause
    }

    #[test]
    fn wide_strings_end_with_nul() {
        assert_eq!(wide("Kin"), [75, 105, 110, 0]);
    }
}
