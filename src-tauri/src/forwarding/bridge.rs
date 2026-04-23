// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Shared forwarding bridge helpers.
//!
//! Centralizes the hot data pump used by local, remote, and dynamic forwards so
//! transport optimizations only need to land once.

use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Notify, broadcast, mpsc};
use tracing::debug;

use crate::ssh::SshError;

const BRIDGE_READ_BUFFER_SIZE: usize = 32 * 1024;
const BRIDGE_CHANNEL_CAPACITY: usize = 32;

#[derive(Debug, Default)]
pub struct ActiveConnectionCounter {
    count: AtomicU64,
    zero_notify: Notify,
}

impl ActiveConnectionCounter {
    pub fn increment(&self) {
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn decrement(&self) {
        let result = self
            .count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1));
        if let Ok(previous) = result {
            if previous == 1 {
                self.zero_notify.notify_waiters();
            }
        }
    }

    pub fn load(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    pub async fn wait_for_zero(&self, timeout: Duration) -> bool {
        if self.load() == 0 {
            return true;
        }

        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.zero_notify.notified();
                if self.load() == 0 {
                    break;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }
}

pub trait BridgeStatsRecorder: Send + Sync + 'static {
    fn record_bytes_sent(&self, bytes: u64);
    fn record_bytes_received(&self, bytes: u64);
}

pub async fn bridge_stream_to_ssh_channel<S>(
    local_stream: TcpStream,
    mut channel: russh::Channel<russh::client::Msg>,
    stats: Arc<S>,
    idle_timeout: Duration,
    shutdown_rx: Option<broadcast::Receiver<()>>,
    log_prefix: &'static str,
) -> Result<(), SshError>
where
    S: BridgeStatsRecorder,
{
    let (mut local_read, mut local_write) = local_stream.into_split();
    let (local_to_ssh_tx, mut local_to_ssh_rx) = mpsc::channel::<Bytes>(BRIDGE_CHANNEL_CAPACITY);
    let (ssh_to_local_tx, mut ssh_to_local_rx) = mpsc::channel::<Bytes>(BRIDGE_CHANNEL_CAPACITY);

    let (close_tx, _) = broadcast::channel::<()>(1);
    let mut close_rx1 = close_tx.subscribe();
    let mut close_rx2 = close_tx.subscribe();

    let stats_for_send = stats.clone();
    let stats_for_recv = stats.clone();

    let local_reader = async move {
        let mut buf = BytesMut::with_capacity(BRIDGE_READ_BUFFER_SIZE);
        loop {
            tokio::select! {
                biased;

                _ = close_rx1.recv() => {
                    debug!("{log_prefix}: local reader received close signal");
                    break;
                }

                result = tokio::time::timeout(idle_timeout, local_read.read_buf(&mut buf)) => {
                    match result {
                        Ok(Ok(0)) => {
                            debug!("{log_prefix}: local reader EOF");
                            break;
                        }
                        Ok(Ok(n)) => {
                            stats_for_send.record_bytes_sent(n as u64);
                            let chunk = buf.split().freeze();
                            if local_to_ssh_tx.send(chunk).await.is_err() {
                                debug!("{log_prefix}: local reader channel closed");
                                break;
                            }
                        }
                        Ok(Err(err)) => {
                            debug!("{log_prefix}: local reader error {err}");
                            break;
                        }
                        Err(_) => {
                            debug!("{log_prefix}: local reader idle timeout ({}s)", idle_timeout.as_secs());
                            break;
                        }
                    }
                }
            }
        }
    };

    let local_writer = async move {
        loop {
            tokio::select! {
                biased;

                _ = close_rx2.recv() => {
                    debug!("{log_prefix}: local writer received close signal");
                    break;
                }

                data = ssh_to_local_rx.recv() => {
                    match data {
                        Some(data) => {
                            if let Err(err) = local_write.write_all(&data).await {
                                debug!("{log_prefix}: local writer error {err}");
                                break;
                            }
                        }
                        None => {
                            debug!("{log_prefix}: local writer channel closed");
                            break;
                        }
                    }
                }
            }
        }
    };

    let mut shutdown_rx = shutdown_rx;
    let ssh_io = async move {
        loop {
            tokio::select! {
                biased;

                _ = async {
                    if let Some(rx) = shutdown_rx.as_mut() {
                        let _ = rx.recv().await;
                    } else {
                        pending::<()>().await;
                    }
                } => {
                    debug!("{log_prefix}: SSH I/O received shutdown signal");
                    break;
                }

                data = local_to_ssh_rx.recv() => {
                    match data {
                        Some(data) => {
                            if let Err(err) = channel.data(&data[..]).await {
                                debug!("{log_prefix}: SSH I/O send error {err}");
                                break;
                            }
                        }
                        None => {
                            debug!("{log_prefix}: local reader closed, sending EOF");
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }

                result = tokio::time::timeout(idle_timeout, channel.wait()) => {
                    match result {
                        Ok(Some(russh::ChannelMsg::Data { data })) => {
                            stats_for_recv.record_bytes_received(data.len() as u64);
                            if ssh_to_local_tx.send(Bytes::copy_from_slice(&data)).await.is_err() {
                                debug!("{log_prefix}: local writer closed");
                                break;
                            }
                        }
                        Ok(Some(russh::ChannelMsg::Eof)) => {
                            debug!("{log_prefix}: received EOF");
                            break;
                        }
                        Ok(Some(russh::ChannelMsg::Close)) => {
                            debug!("{log_prefix}: channel closed by remote");
                            break;
                        }
                        Ok(None) => {
                            debug!("{log_prefix}: channel ended");
                            break;
                        }
                        Ok(_) => continue,
                        Err(_) => {
                            debug!("{log_prefix}: SSH I/O idle timeout ({}s)", idle_timeout.as_secs());
                            break;
                        }
                    }
                }
            }
        }

        let _ = channel.close().await;
    };

    tokio::select! {
        _ = local_reader => {}
        _ = local_writer => {}
        _ = ssh_io => {}
    }

    let _ = close_tx.send(());
    debug!("{log_prefix}: bridge closed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ActiveConnectionCounter;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn wait_for_zero_notifies_when_last_connection_closes() {
        let counter = Arc::new(ActiveConnectionCounter::default());
        counter.increment();

        let waiter = {
            let counter = counter.clone();
            tokio::spawn(async move { counter.wait_for_zero(Duration::from_millis(200)).await })
        };

        tokio::time::sleep(Duration::from_millis(20)).await;
        counter.decrement();

        assert!(waiter.await.unwrap());
        assert_eq!(counter.load(), 0);
    }

    #[tokio::test]
    async fn wait_for_zero_times_out_when_connections_stay_open() {
        let counter = ActiveConnectionCounter::default();
        counter.increment();

        assert!(!counter.wait_for_zero(Duration::from_millis(30)).await);
        assert_eq!(counter.load(), 1);
    }
}
