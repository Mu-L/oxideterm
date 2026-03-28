//! Wire Protocol codec for OxideTerm WebSocket bridge.
//!
//! Binary format: [Type:1B][Length:4B BE][Payload:NB]
//! Compatible with the backend's `FrameCodec` in `src-tauri/src/bridge/protocol.rs`.

use std::io::{self, Read, Write};

/// Message types matching the backend Wire Protocol v1.
#[repr(u8)]
pub enum MessageType {
    Data = 0x00,
    Resize = 0x01,
    Heartbeat = 0x02,
    Error = 0x03,
}

/// Maximum payload size (16 MB).
const MAX_PAYLOAD_SIZE: u32 = 16 * 1024 * 1024;

/// Encode a Data frame into the provided buffer.
pub fn encode_data(payload: &[u8], buf: &mut Vec<u8>) {
    buf.push(MessageType::Data as u8);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
}

/// Encode a Resize frame (cols, rows) into the provided buffer.
pub fn encode_resize(cols: u16, rows: u16, buf: &mut Vec<u8>) {
    buf.push(MessageType::Resize as u8);
    buf.extend_from_slice(&4u32.to_be_bytes());
    buf.extend_from_slice(&cols.to_be_bytes());
    buf.extend_from_slice(&rows.to_be_bytes());
}

/// Encode a Heartbeat frame into the provided buffer.
pub fn encode_heartbeat(buf: &mut Vec<u8>) {
    buf.push(MessageType::Heartbeat as u8);
    buf.extend_from_slice(&0u32.to_be_bytes());
}

/// A decoded frame from the wire.
pub struct Frame {
    pub msg_type: u8,
    pub payload: Vec<u8>,
}

/// Decode a single frame from a byte slice reader.
///
/// Returns `Ok(None)` if there's not enough data yet.
/// Returns `Err` if the frame is malformed.
pub fn decode_frame<R: Read>(reader: &mut R) -> io::Result<Frame> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header)?;

    let msg_type = header[0];
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);

    if length > MAX_PAYLOAD_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Payload too large: {length} bytes"),
        ));
    }

    let mut payload = vec![0u8; length as usize];
    if length > 0 {
        reader.read_exact(&mut payload)?;
    }

    Ok(Frame { msg_type, payload })
}

/// Extract Data payload from a frame.
pub fn frame_data(frame: &Frame) -> Option<&[u8]> {
    if frame.msg_type == MessageType::Data as u8 {
        Some(&frame.payload)
    } else {
        None
    }
}

/// Check if a frame is a Heartbeat.
pub fn is_heartbeat(frame: &Frame) -> bool {
    frame.msg_type == MessageType::Heartbeat as u8
}

/// Check if a frame is an Error.
pub fn is_error(frame: &Frame) -> bool {
    frame.msg_type == MessageType::Error as u8
}

/// Encode a frame into a writer (for WebSocket binary messages).
pub fn encode_to_writer<W: Write>(msg_type: u8, payload: &[u8], writer: &mut W) -> io::Result<()> {
    writer.write_all(&[msg_type])?;
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    Ok(())
}
