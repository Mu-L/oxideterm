//! AI HTTP Proxy Commands
//!
//! Proxies AI provider API calls through the Rust backend to bypass
//! browser CORS restrictions. Essential for local providers like
//! LM Studio, Ollama, and any OpenAI-compatible server.
//!
//! Security:
//! - Only HTTP/HTTPS URLs allowed (prevents file:// SSRF)
//! - Non-streaming response body capped at 10 MB
//! - Streaming channel auto-closes on frontend disconnect

use serde::Serialize;
use std::collections::HashMap;
use tauri::ipc::Channel;

/// Maximum response body size for non-streaming requests (10 MB)
const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/// Response from a non-streaming AI fetch
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFetchResponse {
    pub status: u16,
    pub body: String,
}

/// Chunk events for streaming AI fetch
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    /// HTTP status code (sent first, before any data)
    Status { code: u16 },
    /// A chunk of response body data
    Data { data: String },
    /// An error occurred during streaming
    Error { message: String },
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

/// Validate that the URL uses HTTP or HTTPS scheme only.
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only HTTP and HTTPS URLs are supported".into());
    }
    Ok(())
}

/// Build a reqwest request from common parameters.
fn build_request(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
) -> Result<reqwest::RequestBuilder, String> {
    let mut builder = match method.to_uppercase().as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        other => return Err(format!("Unsupported HTTP method: {}", other)),
    };

    for (key, value) in headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    if let Some(body_str) = body {
        builder = builder.body(body_str);
    }

    Ok(builder)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri Commands
// ═══════════════════════════════════════════════════════════════════════════

/// Non-streaming HTTP fetch for AI API calls (bypasses browser CORS).
///
/// Used for model listing, model details, and other non-streaming API calls.
#[tauri::command]
pub async fn ai_fetch(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<AiFetchResponse, String> {
    validate_url(&url)?;

    tracing::debug!("[ai_fetch] {} {} (timeout: {:?}ms)", method, url, timeout_ms);

    let client = reqwest::Client::new();
    let mut builder = build_request(&client, &url, &method, &headers, body)?;

    if let Some(ms) = timeout_ms {
        if ms > 0 {
            builder = builder.timeout(std::time::Duration::from_millis(ms));
        }
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status().as_u16();
    tracing::debug!("[ai_fetch] {} {} → {}", method, url, status);

    // Read body with size limit
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err(format!(
            "Response too large: {} bytes (max {} bytes)",
            bytes.len(),
            MAX_RESPONSE_SIZE
        ));
    }

    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(AiFetchResponse { status, body })
}

/// Streaming HTTP fetch for AI API calls (bypasses browser CORS).
///
/// Sends response chunks through a Tauri Channel for SSE streaming.
/// The first event is always a `Status` with the HTTP status code,
/// followed by `Data` chunks, and the command returns when the stream ends.
#[tauri::command]
pub async fn ai_fetch_stream(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    on_chunk: Channel<AiStreamEvent>,
) -> Result<(), String> {
    validate_url(&url)?;

    let client = reqwest::Client::new();
    let builder = build_request(&client, &url, &method, &headers, body)?;

    let response = builder
        .send()
        .await
        .map_err(|e| format!("HTTP streaming request failed: {}", e))?;

    let status = response.status().as_u16();

    // Send status first so frontend can check before reading data
    if on_chunk
        .send(AiStreamEvent::Status { code: status })
        .is_err()
    {
        return Ok(()); // Channel closed
    }

    if !response.status().is_success() {
        // For error responses, read the full body and send as a single Data chunk
        let error_body = response.text().await.unwrap_or_default();
        let data = if error_body.len() > 2000 {
            format!(
                "{}... [truncated]",
                error_body.chars().take(2000).collect::<String>()
            )
        } else {
            error_body
        };
        let _ = on_chunk.send(AiStreamEvent::Data { data });
        return Ok(());
    }

    // Stream the success response body chunk by chunk
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                if on_chunk.send(AiStreamEvent::Data { data: text }).is_err() {
                    // Channel closed (frontend disconnected) — stop streaming
                    break;
                }
            }
            Err(e) => {
                let _ = on_chunk.send(AiStreamEvent::Error {
                    message: format!("Stream read error: {}", e),
                });
                break;
            }
        }
    }

    Ok(())
}
