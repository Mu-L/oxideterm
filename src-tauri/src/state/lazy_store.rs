// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

use std::sync::{Arc, Condvar, Mutex};

type StoreInitFn<T> = dyn Fn() -> Result<T, String> + Send + Sync;

enum LazyManagedStoreState<T> {
    Uninitialized,
    Initializing,
    Ready(Arc<T>),
    Failed(String),
}

pub struct LazyManagedStore<T> {
    label: &'static str,
    init: Box<StoreInitFn<T>>,
    state: Mutex<LazyManagedStoreState<T>>,
    ready: Condvar,
}

impl<T> LazyManagedStore<T>
where
    T: Send + Sync + 'static,
{
    pub fn new(
        label: &'static str,
        init: impl Fn() -> Result<T, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            label,
            init: Box::new(init),
            state: Mutex::new(LazyManagedStoreState::Uninitialized),
            ready: Condvar::new(),
        }
    }

    pub fn resolve(&self) -> Result<Arc<T>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| format!("{} state lock poisoned", self.label))?;

        loop {
            match &*state {
                LazyManagedStoreState::Ready(store) => return Ok(store.clone()),
                LazyManagedStoreState::Failed(error) => return Err(error.clone()),
                LazyManagedStoreState::Initializing => {
                    state = self
                        .ready
                        .wait(state)
                        .map_err(|_| format!("{} state lock poisoned", self.label))?;
                }
                LazyManagedStoreState::Uninitialized => {
                    *state = LazyManagedStoreState::Initializing;
                    break;
                }
            }
        }

        drop(state);

        tracing::info!("Initializing {} on first use", self.label);
        let result = (self.init)();

        let mut state = self
            .state
            .lock()
            .map_err(|_| format!("{} state lock poisoned", self.label))?;

        match result {
            Ok(store) => {
                let store = Arc::new(store);
                tracing::info!("Initialized {} on first use", self.label);
                *state = LazyManagedStoreState::Ready(store.clone());
                self.ready.notify_all();
                Ok(store)
            }
            Err(error) => {
                tracing::warn!(
                    "Failed to initialize {} on first use: {}",
                    self.label,
                    error
                );
                *state = LazyManagedStoreState::Failed(error.clone());
                self.ready.notify_all();
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LazyManagedStore;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    #[test]
    fn initializes_once_and_reuses_arc() {
        let init_calls = Arc::new(AtomicUsize::new(0));
        let counter = init_calls.clone();
        let store = LazyManagedStore::new("test store", move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok::<usize, String>(42)
        });

        let first = store.resolve().unwrap();
        let second = store.resolve().unwrap();

        assert_eq!(*first, 42);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(init_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn caches_failure_without_retrying() {
        let init_calls = Arc::new(AtomicUsize::new(0));
        let counter = init_calls.clone();
        let store = LazyManagedStore::<usize>::new("failing store", move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Err("boom".to_string())
        });

        assert_eq!(store.resolve().unwrap_err(), "boom");
        assert_eq!(store.resolve().unwrap_err(), "boom");
        assert_eq!(init_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_callers_wait_for_single_initialization() {
        let init_calls = Arc::new(AtomicUsize::new(0));
        let counter = init_calls.clone();
        let store = Arc::new(LazyManagedStore::new("threaded store", move || {
            counter.fetch_add(1, Ordering::SeqCst);
            thread::sleep(std::time::Duration::from_millis(25));
            Ok::<usize, String>(7)
        }));

        let first_store = store.clone();
        let second_store = store.clone();
        let first = thread::spawn(move || first_store.resolve().unwrap());
        let second = thread::spawn(move || second_store.resolve().unwrap());

        let first = first.join().unwrap();
        let second = second.join().unwrap();

        assert_eq!(*first, 7);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(init_calls.load(Ordering::SeqCst), 1);
    }
}
