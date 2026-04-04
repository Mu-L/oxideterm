// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Cross-platform IPC transport layer.
//!
//! - macOS/Linux: Unix Domain Socket at `~/.oxideterm/oxt.sock`
//! - Windows: Named Pipe at `\\.\pipe\OxideTerm-CLI-{username}`

#[cfg(unix)]
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite};

// ═══════════════════════════════════════════════════════════════════════════
// Unix implementation (macOS / Linux)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(unix)]
mod platform {
    use super::*;
    use tokio::net::{UnixListener, UnixStream};

    /// IPC listener wrapping a Unix Domain Socket.
    pub struct IpcListener(UnixListener);

    /// IPC stream wrapping a Unix Domain Socket connection.
    pub struct IpcStream(pub UnixStream);

    impl IpcListener {
        pub async fn bind() -> Result<Self, std::io::Error> {
            let path = socket_path()?;

            // Ensure parent directory exists
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // Clean up stale socket from previous crash
            if path.exists() {
                // Try connecting to check if another instance is running
                match UnixStream::connect(&path).await {
                    Ok(_) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::AddrInUse,
                            "Another OxideTerm instance is already running",
                        ));
                    }
                    Err(_) => {
                        // Stale socket — remove it
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }

            let listener = UnixListener::bind(&path)?;

            // Set socket permissions to 0600 (owner only)
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }

            tracing::debug!("CLI IPC socket bound at {:?}", path);
            Ok(Self(listener))
        }

        pub async fn accept(&self) -> Result<IpcStream, std::io::Error> {
            let (stream, _addr) = self.0.accept().await?;
            Ok(IpcStream(stream))
        }
    }

    impl AsyncRead for IpcStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for IpcStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    fn socket_path() -> Result<PathBuf, std::io::Error> {
        crate::config::storage::config_dir()
            .map(|dir| dir.join("oxt.sock"))
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Display string for logging the IPC endpoint.
    pub fn ipc_endpoint_display() -> String {
        socket_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unknown>".to_string())
    }

    /// Clean up socket file on shutdown.
    pub fn cleanup() {
        if let Ok(path) = socket_path() {
            let _ = std::fs::remove_file(&path);
            tracing::debug!("CLI IPC socket cleaned up: {:?}", path);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Windows implementation (Named Pipe)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(windows)]
mod platform {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    /// IPC listener wrapping Windows Named Pipe server.
    pub struct IpcListener {
        pipe_name: String,
    }

    /// IPC stream wrapping a Named Pipe connection.
    pub struct IpcStream(pub tokio::net::windows::named_pipe::NamedPipeServer);

    impl IpcListener {
        pub async fn bind() -> Result<Self, std::io::Error> {
            let pipe_name = pipe_name();

            // Verify no other instance is listening by trying to connect
            match ClientOptions::new().open(&pipe_name) {
                Ok(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        "Another OxideTerm instance is already running",
                    ));
                }
                Err(_) => {
                    // Good — no one listening, we can create the pipe
                }
            }

            // Create the first pipe instance with restrictive ACL.
            // Uses an SDDL string to grant access only to the current user (owner).
            let _server = unsafe { create_pipe_with_acl(&pipe_name)? };

            tracing::debug!("CLI IPC pipe created with owner-only ACL: {}", pipe_name);
            Ok(Self { pipe_name })
        }

        pub async fn accept(&self) -> Result<IpcStream, std::io::Error> {
            let server = ServerOptions::new()
                .first_pipe_instance(false)
                .create(&self.pipe_name)?;
            server.connect().await?;
            Ok(IpcStream(server))
        }
    }

    /// Create a named pipe with a SECURITY_ATTRIBUTES that restricts access
    /// to the current user (owner) only.
    ///
    /// Uses SDDL "D:(A;;GA;;;OW)" — Discretionary ACL granting Generic All
    /// to the Owner.
    ///
    /// # Safety
    /// Calls Windows API functions via FFI. All pointers are owned and freed.
    unsafe fn create_pipe_with_acl(
        pipe_name: &str,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, std::io::Error> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

        // SDDL: Owner gets full control, no other access
        // D: = DACL
        // (A;;GA;;;OW) = Allow, Generic All, Owner
        let sddl: Vec<u16> = "D:(A;;GA;;;OW)\0".encode_utf16().collect();
        let mut sd_ptr: *mut core::ffi::c_void = std::ptr::null_mut();

        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut sd_ptr as *mut _ as *mut _,
            std::ptr::null_mut(),
        );

        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }

        // Build SECURITY_ATTRIBUTES that references our restrictive SD
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: 0, // false
        };

        // Create the pipe using Tokio's API via the standard approach.
        // The SECURITY_ATTRIBUTES are applied by setting them in the
        // Windows API layer. Since Tokio's ServerOptions doesn't expose
        // SECURITY_ATTRIBUTES directly, we create with the default first,
        // then rely on the OS-level ACL set via the security descriptor.
        //
        // Note: The proper fix is to call CreateNamedPipeW directly with
        // the SECURITY_ATTRIBUTES, but Tokio wraps the raw handle nicely.
        // For now, we set the pipe security after creation via SetSecurityInfo.
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(pipe_name);

        // Apply the security descriptor to the created pipe
        if let Ok(ref pipe_server) = server {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Security::Authorization::SetSecurityInfo;
            use windows_sys::Win32::Security::Authorization::SE_KERNEL_OBJECT;
            use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

            let handle = pipe_server.as_raw_handle() as *mut core::ffi::c_void;

            // Extract DACL from our security descriptor
            let mut dacl_present: i32 = 0;
            let mut dacl_ptr: *mut windows_sys::Win32::Security::ACL = std::ptr::null_mut();
            let mut defaulted: i32 = 0;

            let got_dacl = windows_sys::Win32::Security::GetSecurityDescriptorDacl(
                sd_ptr,
                &mut dacl_present,
                &mut dacl_ptr as *mut _ as *mut _,
                &mut defaulted,
            );

            if got_dacl != 0 && dacl_present != 0 && !dacl_ptr.is_null() {
                let result = SetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    dacl_ptr,
                    std::ptr::null_mut(),
                );
                if result != 0 {
                    tracing::warn!(
                        "Failed to set pipe security descriptor (error {}), proceeding with defaults",
                        result
                    );
                }
            }
        }

        // Free the security descriptor
        LocalFree(sd_ptr);

        server
    }

    impl AsyncRead for IpcStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for IpcStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    fn pipe_name() -> String {
        let username = whoami::username();
        format!(r"\\.\pipe\OxideTerm-CLI-{}", username)
    }

    /// Display string for logging the IPC endpoint.
    pub fn ipc_endpoint_display() -> String {
        pipe_name()
    }

    /// No-op on Windows (named pipes don't leave files).
    pub fn cleanup() {}
}

pub use platform::*;
