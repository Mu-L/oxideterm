// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Local serial terminal backend.
//!
//! Serial sessions are intentionally separate from SSH sessions: they have no
//! host, username, auth material, jump host, forwarding, or SFTP capabilities.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{RwLock, mpsc};
use uuid::Uuid;

use crate::config::types::{SerialFlowControl, SerialParity};

const SERIAL_READ_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialErrorCode {
    PortNotFound,
    PermissionDenied,
    PortBusy,
    InvalidParameters,
    OpenFailed,
    WriteFailed,
    ReadFailed,
    DeviceDisconnected,
    SessionNotFound,
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerialError {
    pub code: SerialErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub recoverable: bool,
}

impl SerialError {
    pub fn new(
        code: SerialErrorCode,
        message: impl Into<String>,
        port_path: Option<String>,
        session_id: Option<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            port_path,
            session_id,
            recoverable,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub port_path: String,
    pub display_name: String,
    pub port_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSerialSessionRequest {
    pub port_path: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default)]
    pub parity: SerialParity,
    #[serde(default)]
    pub flow_control: SerialFlowControl,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSerialSessionRequest {
    pub session_id: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSerialSessionResponse {
    pub session_id: String,
    pub port_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialDataEvent {
    pub session_id: String,
    pub port_path: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialClosedEvent {
    pub session_id: String,
    pub port_path: String,
}

#[derive(Debug)]
struct SerialSessionHandle {
    normalized_port_path: String,
    input_tx: mpsc::Sender<Vec<u8>>,
    close_tx: std::sync::mpsc::Sender<()>,
    task: JoinHandle<()>,
}

// The loop is tested without Tauri by swapping this sink, while production
// still emits the same serial:* events through AppHandle.
trait SerialEventSink {
    fn emit_data(&self, event: SerialDataEvent);
    fn emit_error(&self, error: SerialError);
    fn emit_closed(&self, event: SerialClosedEvent);
}

struct TauriSerialEventSink {
    app: AppHandle,
}

impl SerialEventSink for TauriSerialEventSink {
    fn emit_data(&self, event: SerialDataEvent) {
        if let Err(error) = self.app.emit("serial:data", event) {
            tracing::warn!("Failed to emit serial:data: {}", error);
        }
    }

    fn emit_error(&self, error: SerialError) {
        if let Err(emit_error) = self.app.emit("serial:error", error) {
            tracing::warn!("Failed to emit serial:error: {}", emit_error);
        }
    }

    fn emit_closed(&self, event: SerialClosedEvent) {
        if let Err(error) = self.app.emit("serial:closed", event) {
            tracing::warn!("Failed to emit serial:closed: {}", error);
        }
    }
}

#[derive(Default)]
pub struct SerialSessionRegistry {
    sessions: RwLock<HashMap<String, SerialSessionHandle>>,
    port_owners: RwLock<HashMap<String, String>>,
}

impl SerialSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn open_session(
        &self,
        app: AppHandle,
        request: OpenSerialSessionRequest,
    ) -> Result<OpenSerialSessionResponse, SerialError> {
        validate_open_request(&request)?;
        ensure_port_exists(&request.port_path)?;

        let session_id = Uuid::new_v4().to_string();
        let normalized_port_path = normalize_port_path(&request.port_path);
        self.reserve_port(&normalized_port_path, &session_id, &request.port_path)
            .await?;

        let handle = match spawn_serial_session(app, session_id.clone(), request.clone()) {
            Ok(handle) => handle,
            Err(error) => {
                self.release_port(&normalized_port_path).await;
                return Err(error);
            }
        };

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), handle);
        }

        Ok(OpenSerialSessionResponse {
            session_id,
            port_path: request.port_path,
        })
    }

    pub async fn write_session(&self, session_id: &str, data: Vec<u8>) -> Result<(), SerialError> {
        let input_tx = {
            let sessions = self.sessions.read().await;
            let Some(handle) = sessions.get(session_id) else {
                return Err(SerialError::new(
                    SerialErrorCode::SessionNotFound,
                    format!("Serial session not found: {session_id}"),
                    None,
                    Some(session_id.to_string()),
                    false,
                ));
            };
            handle.input_tx.clone()
        };

        input_tx.send(data).await.map_err(|_| {
            SerialError::new(
                SerialErrorCode::WriteFailed,
                "Serial write channel is closed",
                None,
                Some(session_id.to_string()),
                true,
            )
        })
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), SerialError> {
        let handle = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id)
        };

        let Some(handle) = handle else {
            return Err(SerialError::new(
                SerialErrorCode::SessionNotFound,
                format!("Serial session not found: {session_id}"),
                None,
                Some(session_id.to_string()),
                false,
            ));
        };

        self.release_port(&handle.normalized_port_path).await;
        let _ = handle.close_tx.send(());
        let _ = handle.task.join();
        Ok(())
    }

    pub async fn close_all(&self) {
        let session_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions.keys().cloned().collect()
        };

        for session_id in session_ids {
            let _ = self.close_session(&session_id).await;
        }
    }

    async fn reserve_port(
        &self,
        normalized_port_path: &str,
        session_id: &str,
        port_path: &str,
    ) -> Result<(), SerialError> {
        let mut port_owners = self.port_owners.write().await;
        if let Some(owner) = port_owners.get(normalized_port_path) {
            return Err(SerialError::new(
                SerialErrorCode::PortBusy,
                format!("Serial port is already open by session {owner}"),
                Some(port_path.to_string()),
                Some(owner.clone()),
                true,
            ));
        }
        port_owners.insert(normalized_port_path.to_string(), session_id.to_string());
        Ok(())
    }

    async fn release_port(&self, normalized_port_path: &str) {
        let mut port_owners = self.port_owners.write().await;
        port_owners.remove(normalized_port_path);
    }

    #[cfg(test)]
    async fn reserve_port_for_test(
        &self,
        normalized_port_path: &str,
        session_id: &str,
    ) -> Result<(), SerialError> {
        self.reserve_port(normalized_port_path, session_id, normalized_port_path)
            .await
    }
}

fn default_baud_rate() -> u32 {
    115_200
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

pub fn list_ports() -> Result<Vec<SerialPortInfo>, SerialError> {
    let mut ports: Vec<SerialPortInfo> = serialport::available_ports()
        .map_err(|error| {
            SerialError::new(
                SerialErrorCode::OpenFailed,
                format!("Failed to list serial ports: {error}"),
                None,
                None,
                true,
            )
        })?
        .into_iter()
        .map(map_port_info)
        .collect();

    ports.sort_by(|left, right| left.port_path.cmp(&right.port_path));
    Ok(ports)
}

fn map_port_info(port: serialport::SerialPortInfo) -> SerialPortInfo {
    match port.port_type {
        serialport::SerialPortType::UsbPort(info) => SerialPortInfo {
            display_name: info
                .product
                .clone()
                .unwrap_or_else(|| port.port_name.clone()),
            port_path: port.port_name,
            port_type: "usb".to_string(),
            manufacturer: info.manufacturer,
            product: info.product,
            serial_number: info.serial_number,
            vid: Some(info.vid),
            pid: Some(info.pid),
        },
        serialport::SerialPortType::BluetoothPort => SerialPortInfo {
            display_name: port.port_name.clone(),
            port_path: port.port_name,
            port_type: "bluetooth".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
        },
        serialport::SerialPortType::PciPort => SerialPortInfo {
            display_name: port.port_name.clone(),
            port_path: port.port_name,
            port_type: "pci".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
        },
        serialport::SerialPortType::Unknown => SerialPortInfo {
            display_name: port.port_name.clone(),
            port_path: port.port_name,
            port_type: "unknown".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
        },
    }
}

fn validate_open_request(request: &OpenSerialSessionRequest) -> Result<(), SerialError> {
    if request.port_path.trim().is_empty() {
        return Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial port path is required",
            None,
            None,
            false,
        ));
    }
    if request.baud_rate == 0 {
        return Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial baud rate must be greater than zero",
            Some(request.port_path.clone()),
            None,
            false,
        ));
    }
    if !(5..=8).contains(&request.data_bits) {
        return Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial data bits must be between 5 and 8",
            Some(request.port_path.clone()),
            None,
            false,
        ));
    }
    if !matches!(request.stop_bits, 1 | 2) {
        return Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial stop bits must be 1 or 2",
            Some(request.port_path.clone()),
            None,
            false,
        ));
    }
    Ok(())
}

fn ensure_port_exists(port_path: &str) -> Result<(), SerialError> {
    let normalized_port_path = normalize_port_path(port_path);
    let ports = serialport::available_ports().map_err(|error| {
        SerialError::new(
            SerialErrorCode::OpenFailed,
            format!("Failed to list serial ports before opening: {error}"),
            Some(port_path.to_string()),
            None,
            true,
        )
    })?;

    if ports
        .iter()
        .any(|port| normalize_port_path(&port.port_name) == normalized_port_path)
    {
        return Ok(());
    }

    Err(SerialError::new(
        SerialErrorCode::PortNotFound,
        format!("Serial port not found: {port_path}"),
        Some(port_path.to_string()),
        None,
        true,
    ))
}

fn spawn_serial_session(
    app: AppHandle,
    session_id: String,
    request: OpenSerialSessionRequest,
) -> Result<SerialSessionHandle, SerialError> {
    let mut port = serialport::new(&request.port_path, request.baud_rate)
        .data_bits(map_data_bits(request.data_bits)?)
        .stop_bits(map_stop_bits(request.stop_bits)?)
        .parity(map_parity(&request.parity))
        .flow_control(map_flow_control(&request.flow_control))
        .timeout(SERIAL_READ_TIMEOUT)
        .open()
        .map_err(|error| map_open_error(error, &request.port_path))?;

    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
    let (close_tx, close_rx) = std::sync::mpsc::channel::<()>();
    let port_path = request.port_path.clone();
    let normalized_port_path = normalize_port_path(&port_path);
    let task_session_id = session_id.clone();
    let task_port_path = port_path.clone();

    let task = std::thread::spawn(move || {
        run_serial_io_loop(
            &mut *port,
            &mut input_rx,
            close_rx,
            TauriSerialEventSink { app },
            task_session_id,
            task_port_path,
        );
    });

    Ok(SerialSessionHandle {
        normalized_port_path,
        input_tx,
        close_tx,
        task,
    })
}

fn run_serial_io_loop<P, S>(
    port: &mut P,
    input_rx: &mut mpsc::Receiver<Vec<u8>>,
    close_rx: std::sync::mpsc::Receiver<()>,
    sink: S,
    session_id: String,
    port_path: String,
) where
    P: Read + Write + ?Sized,
    S: SerialEventSink,
{
    let mut read_buf = [0u8; 8192];

    loop {
        if close_rx.try_recv().is_ok() {
            break;
        }

        while let Ok(data) = input_rx.try_recv() {
            if let Err(error) = port.write_all(&data).and_then(|_| port.flush()) {
                sink.emit_error(map_io_error(
                    error,
                    SerialErrorCode::WriteFailed,
                    &port_path,
                    Some(&session_id),
                ));
                break;
            }
        }

        match port.read(&mut read_buf) {
            Ok(0) => {}
            Ok(read_len) => {
                sink.emit_data(SerialDataEvent {
                    session_id: session_id.clone(),
                    port_path: port_path.clone(),
                    data_base64: BASE64_STANDARD.encode(&read_buf[..read_len]),
                });
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => {
                sink.emit_error(map_io_error(
                    error,
                    SerialErrorCode::ReadFailed,
                    &port_path,
                    Some(&session_id),
                ));
                break;
            }
        }
    }

    sink.emit_closed(SerialClosedEvent {
        session_id,
        port_path,
    });
}

fn map_data_bits(data_bits: u8) -> Result<serialport::DataBits, SerialError> {
    match data_bits {
        5 => Ok(serialport::DataBits::Five),
        6 => Ok(serialport::DataBits::Six),
        7 => Ok(serialport::DataBits::Seven),
        8 => Ok(serialport::DataBits::Eight),
        _ => Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial data bits must be between 5 and 8",
            None,
            None,
            false,
        )),
    }
}

fn map_stop_bits(stop_bits: u8) -> Result<serialport::StopBits, SerialError> {
    match stop_bits {
        1 => Ok(serialport::StopBits::One),
        2 => Ok(serialport::StopBits::Two),
        _ => Err(SerialError::new(
            SerialErrorCode::InvalidParameters,
            "Serial stop bits must be 1 or 2",
            None,
            None,
            false,
        )),
    }
}

fn map_parity(parity: &SerialParity) -> serialport::Parity {
    match parity {
        SerialParity::None => serialport::Parity::None,
        SerialParity::Odd => serialport::Parity::Odd,
        SerialParity::Even => serialport::Parity::Even,
    }
}

fn map_flow_control(flow_control: &SerialFlowControl) -> serialport::FlowControl {
    match flow_control {
        SerialFlowControl::None => serialport::FlowControl::None,
        SerialFlowControl::Software => serialport::FlowControl::Software,
        SerialFlowControl::Hardware => serialport::FlowControl::Hardware,
    }
}

fn map_open_error(error: serialport::Error, port_path: &str) -> SerialError {
    let description = error.to_string();
    let lower = description.to_ascii_lowercase();
    let code = match error.kind() {
        serialport::ErrorKind::NoDevice => SerialErrorCode::PortNotFound,
        serialport::ErrorKind::InvalidInput => SerialErrorCode::InvalidParameters,
        serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
            SerialErrorCode::PermissionDenied
        }
        _ if lower.contains("busy")
            || lower.contains("in use")
            || lower.contains("resource busy")
            || lower.contains("access denied") =>
        {
            SerialErrorCode::PortBusy
        }
        _ => SerialErrorCode::OpenFailed,
    };
    let recoverable = !matches!(code, SerialErrorCode::InvalidParameters);
    SerialError::new(
        code,
        format!("Failed to open serial port {port_path}: {description}"),
        Some(port_path.to_string()),
        None,
        recoverable,
    )
}

fn map_io_error(
    error: std::io::Error,
    fallback: SerialErrorCode,
    port_path: &str,
    session_id: Option<&str>,
) -> SerialError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::UnexpectedEof => SerialErrorCode::DeviceDisconnected,
        std::io::ErrorKind::PermissionDenied => SerialErrorCode::PermissionDenied,
        _ => fallback,
    };
    SerialError::new(
        code,
        error.to_string(),
        Some(port_path.to_string()),
        session_id.map(str::to_string),
        true,
    )
}

fn normalize_port_path(port_path: &str) -> String {
    let trimmed = port_path.trim();
    #[cfg(target_os = "windows")]
    {
        normalize_windows_port_path(trimmed)
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.to_string()
    }
}

#[cfg(any(target_os = "windows", test))]
fn normalize_windows_port_path(port_path: &str) -> String {
    let uppercase = port_path.trim().to_ascii_uppercase();
    // Windows accepts both COM10 and the Win32 device namespace form; use one
    // owner key so existence checks and duplicate reservations agree.
    uppercase
        .strip_prefix("\\\\.\\")
        .or_else(|| uppercase.strip_prefix("\\\\?\\"))
        .unwrap_or(&uppercase)
        .to_string()
}

pub fn encode_serial_bytes(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

pub fn decode_serial_bytes(encoded: &str) -> Result<Vec<u8>, SerialError> {
    BASE64_STANDARD.decode(encoded).map_err(|error| {
        SerialError::new(
            SerialErrorCode::InvalidParameters,
            format!("Invalid serial payload base64: {error}"),
            None,
            None,
            false,
        )
    })
}

impl Default for SerialParity {
    fn default() -> Self {
        Self::None
    }
}

impl Default for SerialFlowControl {
    fn default() -> Self {
        Self::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io;
    use std::sync::{Arc, Mutex};

    fn valid_request() -> OpenSerialSessionRequest {
        OpenSerialSessionRequest {
            port_path: "/dev/cu.usbserial-1".to_string(),
            baud_rate: 115_200,
            data_bits: 8,
            stop_bits: 1,
            parity: SerialParity::None,
            flow_control: SerialFlowControl::None,
        }
    }

    #[derive(Debug)]
    enum CapturedSerialEvent {
        Data(SerialDataEvent),
        Error(SerialError),
        Closed(SerialClosedEvent),
    }

    #[derive(Clone, Default)]
    struct CapturingSerialSink {
        events: Arc<Mutex<Vec<CapturedSerialEvent>>>,
    }

    impl SerialEventSink for CapturingSerialSink {
        fn emit_data(&self, event: SerialDataEvent) {
            self.events
                .lock()
                .unwrap()
                .push(CapturedSerialEvent::Data(event));
        }

        fn emit_error(&self, error: SerialError) {
            self.events
                .lock()
                .unwrap()
                .push(CapturedSerialEvent::Error(error));
        }

        fn emit_closed(&self, event: SerialClosedEvent) {
            self.events
                .lock()
                .unwrap()
                .push(CapturedSerialEvent::Closed(event));
        }
    }

    enum FakeRead {
        Bytes(Vec<u8>),
        Error(io::ErrorKind),
    }

    struct FakeSerialPort {
        reads: VecDeque<FakeRead>,
        writes: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl FakeSerialPort {
        fn new(reads: impl Into<VecDeque<FakeRead>>) -> Self {
            Self {
                reads: reads.into(),
                writes: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl Read for FakeSerialPort {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.reads.pop_front() {
                Some(FakeRead::Bytes(bytes)) => {
                    let len = bytes.len().min(buf.len());
                    buf[..len].copy_from_slice(&bytes[..len]);
                    Ok(len)
                }
                Some(FakeRead::Error(kind)) => Err(io::Error::new(kind, "fake serial error")),
                None => Err(io::Error::new(io::ErrorKind::TimedOut, "fake timeout")),
            }
        }
    }

    impl Write for FakeSerialPort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.writes.lock().unwrap().push(buf.to_vec());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn serial_validation_rejects_invalid_parameters() {
        let mut request = valid_request();
        assert!(validate_open_request(&request).is_ok());

        request.baud_rate = 0;
        assert_eq!(
            validate_open_request(&request).unwrap_err().code,
            SerialErrorCode::InvalidParameters
        );

        request.baud_rate = 115_200;
        request.data_bits = 9;
        assert_eq!(
            validate_open_request(&request).unwrap_err().code,
            SerialErrorCode::InvalidParameters
        );
    }

    #[test]
    fn serial_base64_payload_preserves_binary_bytes() {
        let bytes = [0x00, 0xff, 0x1b, b'\r', b'\n', 0x80];
        let encoded = encode_serial_bytes(&bytes);
        let decoded = decode_serial_bytes(&encoded).unwrap();

        assert_eq!(decoded, bytes);
    }

    #[tokio::test]
    async fn duplicate_port_reservation_returns_port_busy() {
        let registry = SerialSessionRegistry::new();

        registry
            .reserve_port_for_test("/dev/cu.usbserial-1", "session-1")
            .await
            .unwrap();
        let error = registry
            .reserve_port_for_test("/dev/cu.usbserial-1", "session-2")
            .await
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::PortBusy);
        assert_eq!(error.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn windows_serial_normalization_collapses_device_namespace() {
        assert_eq!(normalize_windows_port_path("COM10"), "COM10");
        assert_eq!(normalize_windows_port_path("com10"), "COM10");
        assert_eq!(normalize_windows_port_path("\\\\.\\COM10"), "COM10");
        assert_eq!(normalize_windows_port_path("\\\\?\\com10"), "COM10");
        assert_eq!(normalize_windows_port_path(" COM3 "), "COM3");
    }

    #[test]
    fn serial_open_error_maps_permission_denied() {
        let error = map_io_error(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"),
            SerialErrorCode::ReadFailed,
            "/dev/cu.usbserial-1",
            Some("session-1"),
        );

        assert_eq!(error.code, SerialErrorCode::PermissionDenied);
        assert!(error.recoverable);
    }

    #[tokio::test]
    async fn fake_serial_lifecycle_writes_reads_and_reports_disconnect() {
        let mut port = FakeSerialPort::new(VecDeque::from([
            FakeRead::Bytes(vec![0x00, b'o', b'k']),
            FakeRead::Error(io::ErrorKind::UnexpectedEof),
        ]));
        let writes = port.writes.clone();
        let (input_tx, mut input_rx) = mpsc::channel(4);
        let (_close_tx, close_rx) = std::sync::mpsc::channel();
        let sink = CapturingSerialSink::default();
        let events = sink.events.clone();

        input_tx.send(vec![b'a', b't', b'\r']).await.unwrap();
        run_serial_io_loop(
            &mut port,
            &mut input_rx,
            close_rx,
            sink,
            "session-1".to_string(),
            "/dev/cu.fake".to_string(),
        );

        assert_eq!(writes.lock().unwrap().as_slice(), &[b"at\r".to_vec()]);

        let events = events.lock().unwrap();
        assert!(matches!(
            &events[0],
            CapturedSerialEvent::Data(event)
                if event.session_id == "session-1"
                    && event.port_path == "/dev/cu.fake"
                    && decode_serial_bytes(&event.data_base64).unwrap() == [0x00, b'o', b'k']
        ));
        assert!(matches!(
            &events[1],
            CapturedSerialEvent::Error(error)
                if error.code == SerialErrorCode::DeviceDisconnected
                    && error.session_id.as_deref() == Some("session-1")
        ));
        assert!(matches!(
            &events[2],
            CapturedSerialEvent::Closed(event)
                if event.session_id == "session-1" && event.port_path == "/dev/cu.fake"
        ));
    }

    #[tokio::test]
    async fn fake_serial_lifecycle_closes_without_reading_after_close_signal() {
        let mut port =
            FakeSerialPort::new(VecDeque::from([FakeRead::Bytes(b"unexpected".to_vec())]));
        let (_input_tx, mut input_rx) = mpsc::channel(4);
        let (close_tx, close_rx) = std::sync::mpsc::channel();
        let sink = CapturingSerialSink::default();
        let events = sink.events.clone();

        close_tx.send(()).unwrap();
        run_serial_io_loop(
            &mut port,
            &mut input_rx,
            close_rx,
            sink,
            "session-2".to_string(),
            "/dev/cu.fake".to_string(),
        );

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            CapturedSerialEvent::Closed(event) if event.session_id == "session-2"
        ));
    }

    #[test]
    #[ignore = "requires OXIDETERM_SERIAL_MANUAL_PORT to point at a real or pseudo serial device"]
    fn manual_serial_pseudo_device_round_trip_and_reopen() {
        let port_path = std::env::var("OXIDETERM_SERIAL_MANUAL_PORT")
            .expect("OXIDETERM_SERIAL_MANUAL_PORT must point at a serial device");
        let request = valid_request();
        let first_ping = b"oxideterm-serial-ping-1\r";
        let first_pong = b"oxideterm-serial-pong-1\r";
        let second_ping = b"oxideterm-serial-ping-2\r";
        let second_pong = b"oxideterm-serial-pong-2\r";
        let first_expected = manual_serial_expected(first_ping, first_pong);
        let second_expected = manual_serial_expected(second_ping, second_pong);

        assert!(
            validate_open_request(&OpenSerialSessionRequest {
                port_path: port_path.clone(),
                baud_rate: request.baud_rate,
                data_bits: request.data_bits,
                stop_bits: request.stop_bits,
                parity: request.parity.clone(),
                flow_control: request.flow_control.clone(),
            })
            .is_ok()
        );

        manual_serial_round_trip(&port_path, first_ping, &first_expected);
        manual_serial_round_trip(&port_path, second_ping, &second_expected);
    }

    fn manual_serial_expected(loopback_payload: &[u8], responder_payload: &[u8]) -> Vec<u8> {
        match std::env::var("OXIDETERM_SERIAL_MANUAL_MODE")
            .unwrap_or_else(|_| "loopback".to_string())
            .as_str()
        {
            "loopback" => loopback_payload.to_vec(),
            "responder" => responder_payload.to_vec(),
            mode => {
                panic!("unsupported OXIDETERM_SERIAL_MANUAL_MODE={mode}; use loopback or responder")
            }
        }
    }

    fn manual_serial_round_trip(port_path: &str, ping: &[u8], expected: &[u8]) {
        let mut port = serialport::new(port_path, 115_200)
            .data_bits(serialport::DataBits::Eight)
            .stop_bits(serialport::StopBits::One)
            .parity(serialport::Parity::None)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_secs(2))
            .open()
            .expect("manual serial port should open at 115200 8N1");

        port.write_all(ping).expect("manual serial write failed");
        port.flush().expect("manual serial flush failed");

        let mut read_buf = vec![0_u8; expected.len()];
        port.read_exact(&mut read_buf)
            .expect("manual serial read failed");
        assert_eq!(read_buf, expected);

        drop(port);
    }
}
