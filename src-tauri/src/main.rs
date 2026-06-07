// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

mod acp_adapter;

fn main() {
    acp_adapter::run_from_env_if_requested();
    oxideterm_lib::run()
}
