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

// ── shouldAutoPromote gate predicate (adversarial #763 L6) ─────────────────
// The pure, host-testable seam the ui.zig terminal-promote block folds through,
// so goal 1 (a Stop / Esc / error / timeout Ready never drains the queue) is a
// real failing-before / passing-after test — not just host-arming coverage.

test "shouldAutoPromote: Stop (allowed=false) never auto-promotes" {
    bridge.reset();
    // Busy → ready with host armed false (Stop / timeout / validation Ready).
    try t.expect(!bridge.shouldAutoPromote(.busy, .ready, false, false, false));
}

test "shouldAutoPromote: error terminal never auto-promotes even when allowed=true (round-2 Nit L1)" {
    bridge.reset();
    // err is NOT a success terminal for promotion: a failed turn must never
    // drain the queue regardless of the host-armed scalar. (The round-1 test
    // only passed because it passed allowed=false — this pins the real reason,
    // aligning with sibling #774's err-is-not-terminal-for-promotion intent.)
    try t.expect(!bridge.shouldAutoPromote(.busy, .err, false, true, false));
    try t.expect(!bridge.shouldAutoPromote(.busy, .err, false, true, true));
}

test "shouldAutoPromote: successful ready auto-promotes only when not mid-edit" {
    bridge.reset();
    // Successful turn: busy → ready, host armed true, operator not mid-edit.
    try t.expect(bridge.shouldAutoPromote(.busy, .ready, false, true, false));
    // Even a successful ready must NOT promote while the operator is mid-edit.
    try t.expect(!bridge.shouldAutoPromote(.busy, .ready, true, true, false));
}

test "shouldAutoPromote: trigger B (edit-closed) promotes only on ready + not mid-edit + allowed (round-2 Nit L6)" {
    bridge.reset();
    // Edit-close on a ready terminal, host armed true, not mid-edit → promote.
    try t.expect(bridge.shouldAutoPromote(.ready, .ready, false, true, true));
    // ...but never while the operator is still mid-edit.
    try t.expect(!bridge.shouldAutoPromote(.ready, .ready, true, true, true));
    // ...and never after Stop (allowed=false) — the plan #760 named drain.
    try t.expect(!bridge.shouldAutoPromote(.ready, .ready, false, false, true));
    // ...and never on an err terminal (still not a success).
    try t.expect(!bridge.shouldAutoPromote(.ready, .err, false, true, true));
    // No edit closed this frame → trigger B does not fire (idle→idle stays).
    try t.expect(!bridge.shouldAutoPromote(.ready, .ready, false, true, false));
}

test "shouldAutoPromote: non-terminal transition never promotes" {
    bridge.reset();
    try t.expect(!bridge.shouldAutoPromote(.busy, .busy, false, true, false)); // still busy
    try t.expect(!bridge.shouldAutoPromote(.boot, .ready, false, true, false)); // boot→ready
    // trigger B alone cannot turn a still-busy turn into a promotion.
    try t.expect(!bridge.shouldAutoPromote(.busy, .busy, false, true, true));
}

// ── Gate end-to-end over the real FIFO (adversarial #763 L6) ───────────────
// None of the PR's tests executed `if (… and hasQueuePromoteAllowed()) tryPromoteQueued`.
// These do: they model the ui.zig block — Stop + non-empty queue must keep the
// head; a successful Ready armed true must pop it — through actual queue depth.

test "gate e2e: Stop (allowed=false) + non-empty queue keeps depth unchanged" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    _ = try bridge.enqueueFromUi("two");
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
    // Host Stop terminal armed the scalar false.
    bridge.inv_set_queue_promote_allowed(0);
    // The ui.zig gate: (turn-ended || edit-closed) && !editing && allowed.
    const prev: bridge.Lifecycle = .busy;
    const cur: bridge.Lifecycle = .ready;
    const editing = false;
    const edit_closed = false;
    if (bridge.shouldAutoPromote(prev, cur, editing, bridge.hasQueuePromoteAllowed(), edit_closed)) {
        _ = bridge.tryPromoteQueued(editing);
    }
    // Depth unchanged — the gate refused, so nothing was promoted.
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
}

test "gate e2e: success (allowed=true) + non-empty queue pops the head" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    _ = try bridge.enqueueFromUi("two");
    // Successful Ready armed the scalar true.
    bridge.inv_set_queue_promote_allowed(1);
    const prev: bridge.Lifecycle = .busy;
    const cur: bridge.Lifecycle = .ready;
    const editing = false;
    const edit_closed = false;
    if (bridge.shouldAutoPromote(prev, cur, editing, bridge.hasQueuePromoteAllowed(), edit_closed)) {
        _ = bridge.tryPromoteQueued(editing);
    }
    // Head promoted + popped; one remains. (tryPromoteQueued no-ops on empty,
    // so success auto-promote exactly mirrors the terminal gate.)
    try t.expectEqual(@as(u32, 1), bridge.queuedCount());
}

test "gate e2e: trigger B after Stop (allowed=false) never pops (round-2 Nit L6)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    _ = try bridge.enqueueFromUi("two");
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
    // Host Stop armed the scalar false.
    bridge.inv_set_queue_promote_allowed(0);
    // Simulate trigger B: a queue edit just closed this frame on a ready
    // terminal. The ui.zig gate folds it in under the SAME `!editing && allowed`
    // guards — with allowed=false it must refuse and the head stays.
    const prev: bridge.Lifecycle = .ready;
    const cur: bridge.Lifecycle = .ready;
    const editing = false;
    const edit_closed = true;
    if (bridge.shouldAutoPromote(prev, cur, editing, bridge.hasQueuePromoteAllowed(), edit_closed)) {
        _ = bridge.tryPromoteQueued(editing);
    }
    // Depth unchanged — the guard OR inside the predicate refused the pop.
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
}

test "gate e2e: trigger B on success (allowed=true) pops the head (round-2 Nit L6)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    _ = try bridge.enqueueFromUi("two");
    // Successful Ready armed the scalar true.
    bridge.inv_set_queue_promote_allowed(1);
    // A queue edit closing this frame on a ready terminal is a promote trigger.
    const prev: bridge.Lifecycle = .ready;
    const cur: bridge.Lifecycle = .ready;
    const editing = false;
    const edit_closed = true;
    if (bridge.shouldAutoPromote(prev, cur, editing, bridge.hasQueuePromoteAllowed(), edit_closed)) {
        _ = bridge.tryPromoteQueued(editing);
    }
    // Head promoted + popped; one remains.
    try t.expectEqual(@as(u32, 1), bridge.queuedCount());
}

test "gate e2e: Play-while-editing never pops (adversarial #763 L1)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    bridge.inv_set_queue_promote_allowed(1); // host armed true (last turn succeeded)
    // Explicit Play with the row editor open: `tryPromoteQueued(editing=true)`
    // must refuse via canPromote even though the queue is non-empty + allowed.
    const promoted = bridge.tryPromoteQueued(true);
    try t.expect(!promoted);
    try t.expectEqual(@as(u32, 1), bridge.queuedCount()); // nothing drained mid-edit
}

test "gate e2e: empty FIFO — Play with allowed=true still stays depth 0 (no-op, goal 4)" {
    bridge.reset();
    bridge.inv_set_queue_promote_allowed(1); // host armed true (last turn succeeded)
    // Explicit Play with an EMPTY queue: tryPromoteQueued must no-op (goal 4) —
    // no head to promote, so the depth stays 0 regardless of the scalar.
    const promoted = bridge.tryPromoteQueued(false);
    try t.expect(!promoted);
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
}

// ── plan #777 — operator pause latch (submit-queue hold) ─────────────────
// The pause is gatewayed on `submit_queue.canPromote.paused` via
// `tryPromoteQueued`, so one guard blocks ALL promote paths (auto-promote on
// a successful Ready, idle empty-▶ Play, empty Ctrl+Enter) while leaving
// enqueue/edit/remove/Clear and the typed-send path untouched.

test "pause: defaults unpaused (promote armed — legacy behavior)" {
    bridge.reset();
    try t.expect(!bridge.isQueuePaused());
}

test "pause: set/read round-trip via setQueuePausedFromUi" {
    bridge.reset();
    bridge.setQueuePausedFromUi(true);
    try t.expect(bridge.isQueuePaused());
    bridge.setQueuePausedFromUi(false);
    try t.expect(!bridge.isQueuePaused());
}

test "pause: tryPromoteQueued blocked while paused (non-empty queue, all gates otherwise met)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    _ = try bridge.enqueueFromUi("two");
    bridge.inv_set_queue_promote_allowed(1); // a prior success armed auto-promote
    bridge.setQueuePausedFromUi(true); // operator paused the queue
    // Explicit Play (idle ▶ / empty Ctrl+Enter converge on tryPromoteQueued):
    // the pause guard alone refuses promotion — depth unchanged.
    const promoted = bridge.tryPromoteQueued(false);
    try t.expect(!promoted);
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
}

test "pause: auto-promote held after a successful Ready (goal 3)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    bridge.inv_set_queue_promote_allowed(1); // successful Ready armed the scalar true
    bridge.setQueuePausedFromUi(true); // operator paused
    // The ui.zig terminal gate decides auto_promote via shouldAutoPromote, then
    // calls tryPromoteQueued — the pause guard in canPromote must refuse the pop.
    const prev: bridge.Lifecycle = .busy;
    const cur: bridge.Lifecycle = .ready;
    const editing = false;
    const edit_closed = false;
    const auto = bridge.shouldAutoPromote(prev, cur, editing, bridge.hasQueuePromoteAllowed(), edit_closed);
    try t.expect(auto); // the gate itself fires (turn ended, allowed)
    const promoted = bridge.tryPromoteQueued(editing);
    try t.expect(!promoted); // ...but the pause latch inside canPromote holds it
    try t.expectEqual(@as(u32, 1), bridge.queuedCount()); // depth unchanged
    try t.expectEqualStrings("one", bridge.queuedItemAt(0).?);
}

test "pause: unpause restores drain by existing rules (goal 4)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("one");
    bridge.inv_set_queue_promote_allowed(1);
    bridge.setQueuePausedFromUi(true);
    // Paused: explicit Play holds.
    try t.expect(!bridge.tryPromoteQueued(false));
    try t.expectEqual(@as(u32, 1), bridge.queuedCount());
    // Unpause: the next successful Ready / explicit Play drains the head.
    bridge.setQueuePausedFromUi(false);
    const promoted = bridge.tryPromoteQueued(false);
    try t.expect(promoted);
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
}

test "pause: enqueue/edit/remove/Clear keep working while paused (goal 6)" {
    bridge.reset();
    bridge.setQueuePausedFromUi(true); // pause the queue
    // Enqueue still appends (FIFO ops never consult the latch).
    _ = try bridge.enqueueFromUi("A");
    _ = try bridge.enqueueFromUi("B");
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
    _ = bridge.replaceQueuedAt(0, "A2");
    try t.expectEqualStrings("A2", bridge.queuedItemAt(0).?);
    bridge.removeQueuedAt(1);
    try t.expectEqual(@as(u32, 1), bridge.queuedCount());
    bridge.clearSubmitQueue();
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
}

test "pause: reset() and inv_clear_messages clear the latch (Wasm-ephemeral, non-goal)" {
    bridge.reset();
    bridge.setQueuePausedFromUi(true);
    try t.expect(bridge.isQueuePaused());
    bridge.reset(); // New / session (re-)init — fresh surface
    try t.expect(!bridge.isQueuePaused());

    bridge.setQueuePausedFromUi(true);
    bridge.inv_clear_messages(); // Clear / New — clears with the queue
    try t.expect(!bridge.isQueuePaused());
}

test "inv_clear_ring keeps submit queue, pause latch, and promote gate (v21 / adversarial #857)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("A");
    _ = try bridge.enqueueFromUi("B");
    bridge.inv_set_queue_promote_allowed(0);
    bridge.setQueuePausedFromUi(true);
    bridge.inv_clear_ring();
    try t.expectEqual(@as(u32, 2), bridge.queuedCount());
    try t.expectEqualStrings("A", bridge.queuedItemAt(0).?);
    try t.expectEqualStrings("B", bridge.queuedItemAt(1).?);
    try t.expect(!bridge.hasQueuePromoteAllowed());
    try t.expect(bridge.isQueuePaused());
}

test "inv_clear_messages still clears the queue (F5 / New / switch)" {
    bridge.reset();
    _ = try bridge.enqueueFromUi("stale");
    bridge.inv_set_queue_promote_allowed(0);
    bridge.setQueuePausedFromUi(true);
    bridge.inv_clear_messages();
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
    try t.expect(bridge.hasQueuePromoteAllowed());
    try t.expect(!bridge.isQueuePaused());
}

test "v22 reasoning list: push, default-unset, restore-by-value, reject unknown" {
    bridge.reset();
    try t.expectEqual(@as(u32, 0), bridge.reasoningEffortCount());
    try t.expectEqualStrings("", bridge.selectedReasoningId());
    try t.expect(bridge.pushReasoningEffort("low"));
    try t.expect(bridge.pushReasoningEffort("high"));
    try t.expect(bridge.pushReasoningEffort("max"));
    try t.expectEqual(@as(u32, 3), bridge.reasoningEffortCount());
    // Host owns the default — a push does not auto-select (never max).
    try t.expectEqualStrings("", bridge.selectedReasoningId());
    try t.expect(bridge.selectReasoningByValue("low"));
    try t.expectEqualStrings("low", bridge.selectedReasoningId());
    try t.expect(!bridge.hasPendingReasoningChange());
    try t.expect(bridge.selectReasoningByValue("max"));
    try t.expectEqualStrings("max", bridge.selectedReasoningId());
    try t.expect(!bridge.hasPendingReasoningChange());
    try t.expect(!bridge.selectReasoningByValue("xhigh"));
    try t.expectEqualStrings("max", bridge.selectedReasoningId());
    try t.expect(!bridge.pushReasoningEffort("LOW"));
    try t.expect(!bridge.pushReasoningEffort("has space"));
}

test "v22 user pick raises pending; restore-by-value does not; empty clears" {
    bridge.reset();
    _ = bridge.pushReasoningEffort("low");
    _ = bridge.pushReasoningEffort("high");
    bridge.setSelectedReasoning(1);
    try t.expect(bridge.hasPendingReasoningChange());
    try t.expectEqualStrings("high", bridge.selectedReasoningId());
    bridge.ackPendingReasoningChange();
    try t.expect(!bridge.hasPendingReasoningChange());
    try t.expect(bridge.selectReasoningByValue("low"));
    try t.expect(!bridge.hasPendingReasoningChange());
    try t.expect(bridge.selectReasoningByValue(""));
    try t.expectEqualStrings("", bridge.selectedReasoningId());
}

test "v22 reset clears reasoning list" {
    bridge.reset();
    _ = bridge.pushReasoningEffort("low");
    bridge.setSelectedReasoning(0);
    bridge.reset();
    try t.expectEqual(@as(u32, 0), bridge.reasoningEffortCount());
    try t.expectEqualStrings("", bridge.selectedReasoningId());
    try t.expect(!bridge.hasPendingReasoningChange());
}

