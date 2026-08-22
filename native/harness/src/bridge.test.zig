//! Unit tests for `bridge.zig` protocol-v19 promote gate (plan #760). The gate
//! is a host-armed one-shot scalar (`queue_promote_allowed`): default **true**
//! so a legacy host keeps today's success auto-promote; the host arms it false
//! on a Stop / Esc / error / timeout / validation Ready so the Wasm
//! terminal-promote block can never drain the queue after a non-success.
//!
//! Testable without a dvui frame: these call the pub scalar seam
//! (`hasQueuePromoteAllowed`, `inv_set_queue_promote_allowed`, `reset`,
//! `inv_clear_messages`) directly, mirroring `queue_band.test.zig` wiring
//! (bridge.zig → web-backend stub).
const std = @import("std");
const t = std.testing;
const bridge = @import("bridge.zig");

test "promote gate defaults true (legacy-host auto-promote preserved)" {
    bridge.reset();
    try t.expect(bridge.hasQueuePromoteAllowed());
}

test "inv_set_queue_promote_allowed arms false, then true (set/read round-trip)" {
    bridge.reset();
    bridge.inv_set_queue_promote_allowed(0);
    try t.expect(!bridge.hasQueuePromoteAllowed());
    bridge.inv_set_queue_promote_allowed(1);
    try t.expect(bridge.hasQueuePromoteAllowed());
}

test "reset() restores promote gate to true after a Stop armed it false" {
    bridge.reset();
    bridge.inv_set_queue_promote_allowed(0); // host Stop terminal armed it false
    try t.expect(!bridge.hasQueuePromoteAllowed());
    bridge.reset(); // New / session (re-)init = fresh surface
    try t.expect(bridge.hasQueuePromoteAllowed());
}

test "inv_clear_messages restores promote gate to true (Clear / New surface)" {
    bridge.reset();
    bridge.inv_set_queue_promote_allowed(0); // host Stop armed it false
    try t.expect(!bridge.hasQueuePromoteAllowed());
    bridge.inv_clear_messages(); // Clear does NOT call reset() — must re-arm here
    try t.expect(bridge.hasQueuePromoteAllowed());
}
