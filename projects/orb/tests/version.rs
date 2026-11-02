//! `orb --version` and `orb -V`, run as a user runs them.

use std::process::Command;
use std::time::Duration;

use orb_domain::{Finished, run_within};

#[rstest::rstest]
#[case("--version")]
#[case("-V")]
fn version_flag_prints_the_version_and_exits(#[case] flag: &str) {
    // Given the built orb, with no HOME so a missed flag can't start orb.
    let mut command = Command::new(env!("CARGO_BIN_EXE_orb"));
    command.arg(flag).env_remove("HOME");

    // When running it with the flag.
    let finished = run_within(command, Duration::from_secs(5));

    // Then it printed its name and version and exited 0.
    let printed = match finished {
        Ok(Finished::Exited(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => None,
    };
    assert_eq!(
        printed.as_deref(),
        Some(concat!("orb ", env!("CARGO_PKG_VERSION"), "\n")),
        "{flag} should print `orb <version>` and exit 0"
    );
}
