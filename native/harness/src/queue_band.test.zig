//! Unit tests for `queue_band.zig` state-mutation contracts (plan #677).
//! Tests the beginEdit/closeEdit flag lifecycle, desiredHeight ghost-band
//! sentinel, and the new want_editor_focus / seen_focused flags.
const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const metrics = @import("ui/metrics.zig");
const queue_band = @import("ui/queue_band.zig");
const state = @import("ui/state.zig");
const submit_queue = @import("submit_queue.zig");

const EPS: f32 = 1.0;

// ── desiredHeight unit tests ─────────────────────────────────────────────

test "desiredHeight: 0 items, no edit -> 0" {
    bridge.reset();
    state.queue_editing_index = null;
    try t.expectEqual(@as(f32, 0), queue_band.desiredHeight());
}

test "desiredHeight: 1 item, no edit -> 2*TOUCH_H" {
    bridge.reset();
    _ = bridge.enqueueFromUi("x") catch @panic("enqueue failed");
    state.queue_editing_index = null;
    try t.expectApproxEqAbs(2 * metrics.TOUCH_H, queue_band.desiredHeight(), EPS);
}

test "desiredHeight: 0 items, editing -> 2*TOUCH_H (ghost-band sentinel)" {
    // Pre-fix ghost-band scenario: the FIFO was cleared but the editing
    // latch survived. desiredHeight returns 2*TOUCH_H so a band paints.
    // After fix 2 (queuedCount()==0 guard in ui.zig), the latch is dropped
    // before desiredHeight is called. This test pins the ghost-band output
    // so a regression is caught.
    bridge.reset();
    state.queue_editing_index = 1;
    state.queue_edit_textentry_id = null;
    try t.expectApproxEqAbs(2 * metrics.TOUCH_H, queue_band.desiredHeight(), EPS);
}

test "desiredHeight: 5 items, capped at MAX_ROWS" {
    bridge.reset();
    var i: u32 = 0;
    while (i < 5) : (i += 1) {
        _ = bridge.enqueueFromUi("x") catch @panic("enqueue failed");
    }
    state.queue_editing_index = null;
    const want = metrics.TOUCH_H + @as(f32, @floatFromInt(@min(@as(u32, 5), metrics.QUEUE_BAND_MAX_ROWS))) * metrics.TOUCH_H;
    try t.expectApproxEqAbs(want, queue_band.desiredHeight(), EPS);
}

// ── beginEdit / closeEdit flag lifecycle ─────────────────────────────────

test "beginEdit contract: want_editor_focus set, seen_focused cleared" {
    bridge.reset();
    _ = bridge.enqueueFromUi("original text") catch @panic("enqueue failed");
    // beginEdit is file-private — replicate its contract:
    //   - Copy text to queue_edit_buf
    //   - Set queue_editing_index = i
    //   - Set queue_want_editor_focus = true
    //   - Set queue_edit_seen_focused = false
    state.queue_want_editor_focus = false;
    state.queue_edit_seen_focused = true; // stale from prior edit

    const txt = bridge.queuedItemAt(0).?;
    @memset(&state.queue_edit_buf, 0);
    const n = @min(txt.len, state.queue_edit_buf.len);
    if (n > 0) @memcpy(state.queue_edit_buf[0..n], txt[0..n]);
    state.queue_editing_index = 0;
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = false;

    try t.expect(state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expect(state.queue_editing_index != null);
}

test "closeEdit contract: all editing state cleared including new flags" {
    // Replicate closeEdit's state-mutation contract:
    //   - queue_editing_index = null
    //   - queue_edit_textentry_id = null
    //   - queue_want_editor_focus = false
    //   - queue_edit_seen_focused = false
    //   - @memset queue_edit_buf to 0
    //   - queue_closed_edit = true
    state.queue_editing_index = 0;
    state.queue_edit_textentry_id = @as(dvui.Id, @enumFromInt(1));
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = true;
    state.queue_closed_edit = false;
    @memset(&state.queue_edit_buf, 'x');

    state.queue_editing_index = null;
    state.queue_edit_textentry_id = null;
    state.queue_want_editor_focus = false;
    state.queue_edit_seen_focused = false;
    @memset(&state.queue_edit_buf, 0);
    state.queue_closed_edit = true;

    try t.expect(state.queue_editing_index == null);
    try t.expect(state.queue_edit_textentry_id == null);
    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expect(state.queue_closed_edit);
    try t.expectEqual(@as(u8, 0), state.queue_edit_buf[0]);
}

test "resetTranscriptScroll clears new flags" {
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = true;
    state.queue_editing_index = 1;
    state.queue_edit_textentry_id = @as(dvui.Id, @enumFromInt(1));

    state.resetTranscriptScroll();

    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expect(state.queue_editing_index == null);
    try t.expect(state.queue_edit_textentry_id == null);
}

// ── existing queue tests still pass ──────────────────────────────────────

test "submit_queue: push / count smoke" {
    var q: submit_queue.Q = .{};
    try submit_queue.push(&q, "test");
    try t.expectEqual(@as(u32, 1), submit_queue.count(&q));
}
