//! Raw terminal mode management.
//!
//! Provides RAII-based raw mode toggling and terminal size queries.
//! On Unix uses `termios` via `libc`. On Windows uses Console API.

/// RAII guard that restores original terminal settings on drop.
pub struct RawModeGuard {
    #[cfg(unix)]
    original: libc::termios,
}

impl RawModeGuard {
    /// Enter raw mode. Returns a guard that restores settings on drop.
    pub fn enter() -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::mem::MaybeUninit;
            let fd = libc::STDIN_FILENO;

            let mut original = MaybeUninit::<libc::termios>::uninit();
            if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
                return Err("Failed to get terminal attributes".to_string());
            }
            let original = unsafe { original.assume_init() };

            let mut raw = original;
            unsafe { libc::cfmakeraw(&mut raw) };
            // Keep ISIG so SIGWINCH still works
            raw.c_lflag |= libc::ISIG;

            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
                return Err("Failed to set raw mode".to_string());
            }

            Ok(Self { original })
        }

        #[cfg(windows)]
        {
            // Windows raw mode via Console API
            // For now, minimal implementation
            Ok(Self {})
        }
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.original);
            }
        }
    }
}

/// Get current terminal size (cols, rows).
pub fn get_terminal_size() -> (u16, u16) {
    #[cfg(unix)]
    {
        use std::mem::MaybeUninit;
        let mut ws = MaybeUninit::<libc::winsize>::uninit();
        let ret =
            unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, ws.as_mut_ptr()) };
        if ret == 0 {
            let ws = unsafe { ws.assume_init() };
            (ws.ws_col, ws.ws_row)
        } else {
            (80, 24) // fallback
        }
    }

    #[cfg(windows)]
    {
        (80, 24) // TODO: Windows Console API
    }
}

/// Install a SIGWINCH handler that writes to the given pipe fd.
///
/// When the terminal is resized, the handler writes a single byte to `write_fd`,
/// which can be polled alongside the WebSocket connection.
#[cfg(unix)]
pub fn install_sigwinch_handler(write_fd: i32) {
    unsafe {
        SIGWINCH_PIPE_FD.store(write_fd, std::sync::atomic::Ordering::Relaxed);
        libc::signal(libc::SIGWINCH, sigwinch_handler as libc::sighandler_t);
    }
}

/// Reset the SIGWINCH handler to default and clear the pipe fd.
/// Must be called before closing the pipe file descriptors to
/// prevent the signal handler from writing to a closed fd.
#[cfg(unix)]
pub fn reset_sigwinch_handler() {
    unsafe {
        libc::signal(libc::SIGWINCH, libc::SIG_DFL);
        SIGWINCH_PIPE_FD.store(-1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(unix)]
static SIGWINCH_PIPE_FD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

#[cfg(unix)]
extern "C" fn sigwinch_handler(_sig: libc::c_int) {
    let fd = SIGWINCH_PIPE_FD.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        unsafe {
            libc::write(fd, b"R" as *const u8 as *const libc::c_void, 1);
        }
    }
}
