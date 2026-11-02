use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// An exclusive lock held by creating a file, which is removed on drop. A
/// crashed owner leaves the file behind, and the error says how to recover.
pub struct FileLock(PathBuf);

impl FileLock {
    /// Wait up to `max_wait` for `path` to be free. `action` names the write in
    /// messages and in the ownership record, such as `content write`.
    pub fn acquire(path: PathBuf, action: &str, max_wait: Duration) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        let started = Instant::now();
        let mut file = loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => break file,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        && started.elapsed() < max_wait =>
                {
                    std::thread::sleep(Duration::from_millis(100));
                }
                // On Windows a lock file the previous owner is still deleting, or one a
                // scanner briefly holds, refuses creation with "access denied" for a moment.
                // That is not a live owner, so even a caller that does not wait for one waits
                // it out rather than reporting another write as active.
                Err(error)
                    if crate::fsutil::is_transient_hold(&error)
                        && started.elapsed()
                            < max_wait.max(crate::fsutil::TRANSIENT_HOLD_LIMIT) =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(format!(
                        "another {action} is active ({error}). If open.blog crashed and no writer is running, remove {} and retry",
                        path.display()
                    ));
                }
                Err(error) => {
                    return Err(format!("cannot acquire {}: {error}", path.display()));
                }
            }
        };
        writeln!(
            file,
            "pid={} action={}",
            std::process::id(),
            action.replace(' ', "-")
        )
        .map_err(|error| {
            let _ = fs::remove_file(&path);
            format!(
                "cannot record transaction ownership in {}: {error}",
                path.display()
            )
        })?;
        Ok(Self(path))
    }
}

/// Test hook: milliseconds `FileLock::drop` sleeps before removing the lock file, so a test can
/// widen the release window the same way on every platform.
#[cfg(test)]
pub(crate) static RELEASE_DELAY_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(test)]
        {
            let delay = RELEASE_DELAY_MS.load(std::sync::atomic::Ordering::SeqCst);
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
        }
        // A lock file left behind blocks every later write until someone removes it, so a
        // scanner briefly holding it is waited out.
        let _ = crate::fsutil::retry_transient(|| fs::remove_file(&self.0));
    }
}

pub struct ContentTransactionLock {
    _lock: FileLock,
}

impl ContentTransactionLock {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        Self::acquire_with_wait(root, Duration::ZERO)
    }

    pub fn acquire_with_wait(root: &Path, max_wait: Duration) -> Result<Self, String> {
        let path = root.join(".openblog").join("content-transaction.lock");
        FileLock::acquire(path, "content write", max_wait).map(|lock| Self { _lock: lock })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_writer_acquires_the_lock_after_the_owner_releases_it() {
        let root = std::env::temp_dir().join(format!(
            "ob-content-transaction-wait-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let owner = ContentTransactionLock::acquire(&root).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(owner);
        });

        let next = ContentTransactionLock::acquire_with_wait(&root, Duration::from_secs(1));

        release.join().unwrap();
        drop(next.unwrap());
        let _ = fs::remove_dir_all(root);
    }

    /// Opens the lock file the way a scanner can: nobody may delete it until the handle closes.
    #[cfg(windows)]
    fn hold(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        const FILE_SHARE_WRITE: u32 = 2;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_briefly_held_lock_file_is_still_removed_on_release() {
        let root = std::env::temp_dir().join(format!(
            "ob-content-transaction-held-release-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let lock_path = root.join(".openblog").join("content-transaction.lock");
        let owner = ContentTransactionLock::acquire(&root).unwrap();
        let held = hold(&lock_path);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                drop(held);
            });
            drop(owner);
        });
        assert!(
            !lock_path.exists(),
            "a stale lock would block every later write"
        );
        drop(ContentTransactionLock::acquire(&root).unwrap());
        let _ = fs::remove_dir_all(root);
    }
}
