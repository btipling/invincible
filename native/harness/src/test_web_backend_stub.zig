//! Stub `web-backend` for host-target tests that transitively reach
//! `bridge.zig`. The web backend (`wasm.wasm_refresh`) is Wasm-specific;
//! this no-op stub lets host tests compile functions that touch the queue
//! bridge without actually calling into the Wasm runtime.
pub const wasm = struct {
    pub fn wasm_refresh() void {}
};
