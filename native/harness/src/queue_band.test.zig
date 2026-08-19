//! Unit tests for `queue_band.zig` state-mutation contracts (plan #677,
//! adversarial review #680 Major L6 + Minor L1). Calls the pub lifecycle
//! functions (`beginEdit`, `closeEdit`, `saveEdit`, `resetQueueEditState`)
//! directly so the tests exercise production code paths, not local mirrors.
const std = @import("std");
const t = std.testing;
const bridge = @import("bridge.zig");
const metrics = @import("ui/metrics.zig");
const queue_band = @import("ui/queue_band.zig");
const state = @import("ui/state.zig");

const EPS: f32 = 1.0;

// ── desiredHeight unit tests (real — desiredHeight is pub) ───────────────

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

// ── resetQueueEditState (extracted helper, plan #680 Major L6) ─────────

test "resetQueueEditState: clears all editing state" {
    // Set every state field dirty.
    state.queue_editing_index = 0;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = true;
    state.prev_queue_band_h = 100;
    state.queue_closed_edit = false;
    @memset(&state.queue_edit_buf, 'x');

    queue_band.resetQueueEditState();

    try t.expect(state.queue_editing_index == null);
    try t.expect(state.queue_edit_textentry_id == null);
    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expectEqual(@as(f32, 0), state.prev_queue_band_h);
    try t.expect(!state.queue_closed_edit);
    try t.expectEqual(@as(u8, 0), state.queue_edit_buf[0]);
}

// ── beginEdit / closeEdit / saveEdit lifecycle (calls production code) ──

test "beginEdit: copies text, sets editing_index, flags" {
    bridge.reset();
    _ = bridge.enqueueFromUi("hello world") catch @panic("enqueue failed");
    // Pre-set stale values to verify they are overwritten.
    state.queue_want_editor_focus = false;
    state.queue_edit_seen_focused = true;
    @memset(&state.queue_edit_buf, 0);

    queue_band.beginEdit(0);

    try t.expect(state.queue_editing_index != null);
    try t.expectEqual(@as(usize, 0), state.queue_editing_index.?);
    try t.expect(state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    // The edit buf must contain the original text.
    try t.expect(std.mem.eql(u8, "hello world", std.mem.sliceTo(state.queue_edit_buf[0..], 0)));
}

test "beginEdit: out-of-range index is a no-op (queuedItemAt returns null)" {
    bridge.reset();
    queue_band.resetQueueEditState();
    state.queue_want_editor_focus = false;

    queue_band.beginEdit(0);

    // No item at index 0 — beginEdit returns early without changing state.
    try t.expect(state.queue_editing_index == null);
    try t.expect(!state.queue_want_editor_focus);
}

test "closeEdit: clears all editing state" {
    // Set every state field dirty.
    state.queue_editing_index = 0;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = true;
    state.queue_closed_edit = false;
    @memset(&state.queue_edit_buf, 'x');

    queue_band.closeEdit();

    try t.expect(state.queue_editing_index == null);
    try t.expect(state.queue_edit_textentry_id == null);
    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expect(state.queue_closed_edit);
    try t.expectEqual(@as(u8, 0), state.queue_edit_buf[0]);
}

test "saveEdit: replaces text and closes on success" {
    bridge.reset();
    _ = bridge.enqueueFromUi("original") catch @panic("enqueue failed");
    // Simulate an open edit with different text in the buffer.
    queue_band.beginEdit(0);
    @memset(&state.queue_edit_buf, 0);
    const new_text = "modified";
    @memcpy(state.queue_edit_buf[0..new_text.len], new_text);

    queue_band.saveEdit(0, new_text);

    // Editing latch must be closed after successful replace.
    try t.expect(state.queue_editing_index == null);
    // The queue item must now hold "modified".
    try t.expect(bridge.queuedCount() == 1);
    const item = bridge.queuedItemAt(0).?;
    try t.expect(std.mem.eql(u8, "modified", item));
}

test "saveEdit: blank text calls cancelEdit, releases latch, preserves original" {
    bridge.reset();
    _ = bridge.enqueueFromUi("keep me") catch @panic("enqueue failed");
    queue_band.beginEdit(0);
    // Simulate select-all + delete — buffer is empty.
    @memset(&state.queue_edit_buf, 0);

    queue_band.saveEdit(0, "");

    // Blank replace is rejected (data preserved), but latch MUST be released
    // so click-away leaves the editor (adversarial review #680 Minor L1).
    try t.expect(state.queue_editing_index == null);
    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    // Original text must still be in the queue.
    try t.expect(bridge.queuedCount() == 1);
    const item = bridge.queuedItemAt(0).?;
    try t.expect(std.mem.eql(u8, "keep me", item));
}

test "saveEdit: out-of-range index (no replace, no crash)" {
    bridge.reset();
    // No items in the queue — saveEdit at index 0 hits replaceQueuedAt BadIndex.
    queue_band.saveEdit(0, "xxx");
    // Should not crash and should not leave latch set.
    try t.expect(state.queue_editing_index == null);
}

// ── shouldBlurSave predicates (adversarial review #680 Round 2 Major L6) ──

test "shouldBlurSave: false when seen_focused=false (first frame)" {
    // Regression guard: before plan #677 fix 1, the blur-save guard was
    // `focused == null or focused.? != te_id` with no seen_focused gate.
    // On the FIRST frame after beginEdit, the textEntry widget doesn't
    // exist yet — focused is null (no focusWidget has landed). Without
    // seen_focused, shouldBlurSave returns true → saveEdit + closeEdit
    // fires one frame after open → ✎ flashes and closes.
    state.queue_edit_seen_focused = false;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    try t.expect(!queue_band.shouldBlurSave(@as(@import("dvui").Id, @enumFromInt(1)), null));
}

test "shouldBlurSave: true when seen_focused=true and focused null (blur)" {
    // After the TE has been focused at least once (seen_focused=true),
    // focused=null (clicked empty canvas or no widget has focus) is a
    // genuine blur — should close the edit.
    state.queue_edit_seen_focused = true;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    try t.expect(queue_band.shouldBlurSave(@as(@import("dvui").Id, @enumFromInt(1)), null));
}

test "shouldBlurSave: true when seen_focused=true and focused on different widget" {
    // seen_focused=true but focus moved to another widget (e.g. composer)
    // → blur-save should fire.
    state.queue_edit_seen_focused = true;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    try t.expect(queue_band.shouldBlurSave(@as(@import("dvui").Id, @enumFromInt(1)), @as(@import("dvui").Id, @enumFromInt(2))));
}

test "shouldBlurSave: false when seen_focused=true and focused on te itself" {
    // Normal editing — focus is still on the textEntry. No blur.
    state.queue_edit_seen_focused = true;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    try t.expect(!queue_band.shouldBlurSave(@as(@import("dvui").Id, @enumFromInt(1)), @as(@import("dvui").Id, @enumFromInt(1))));
}

// ── shouldDropEditOnEmptyQueue predicate (adversarial review #680 Round 2 Major L6) ──

test "shouldDropEditOnEmptyQueue: true when editing + queue empty" {
    bridge.reset();
    state.queue_editing_index = 0;
    // FIFO is empty after reset; editing latch is set → must return true.
    try t.expect(queue_band.shouldDropEditOnEmptyQueue());
}

test "shouldDropEditOnEmptyQueue: false when not editing" {
    bridge.reset();
    state.queue_editing_index = null;
    // FIFO empty but no edit open → no latch to drop.
    try t.expect(!queue_band.shouldDropEditOnEmptyQueue());
}

test "shouldDropEditOnEmptyQueue: false when editing + queue non-empty" {
    bridge.reset();
    _ = bridge.enqueueFromUi("x") catch @panic("enqueue failed");
    state.queue_editing_index = 0;
    // Editing is open but the queue has an item → no drop.
    try t.expect(!queue_band.shouldDropEditOnEmptyQueue());
}

test "resetTranscriptScroll clears new flags" {
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = true;
    state.queue_editing_index = 1;
    state.queue_edit_textentry_id = @as(@import("dvui").Id, @enumFromInt(1));
    state.prev_queue_band_h = 50;
    state.queue_closed_edit = false;
    @memset(&state.queue_edit_buf, 'x');

    state.resetTranscriptScroll();

    try t.expect(!state.queue_want_editor_focus);
    try t.expect(!state.queue_edit_seen_focused);
    try t.expect(state.queue_editing_index == null);
    try t.expect(state.queue_edit_textentry_id == null);
    try t.expectEqual(@as(f32, 0), state.prev_queue_band_h);
    try t.expect(!state.queue_closed_edit);
    try t.expectEqual(@as(u8, 0), state.queue_edit_buf[0]);
}

// ── cancel glyph constant (PR #681) ──────────────────────────────────────

test "cancel glyph is U+2715 (DejaVu subset)" {
    // queue_band.cancel_glyph must be exactly U+2715 (3 bytes UTF-8).
    // U+00D7 is not in the shipped DejaVu subset — would tofu at 40 px.
    const expected = "\u{2715}";
    try t.expectEqualStrings(expected, queue_band.cancel_glyph);
    try t.expectEqual(@as(usize, 3), queue_band.cancel_glyph.len);

    // U+2715 decodes correctly.
    const cp = std.unicode.utf8Decode(queue_band.cancel_glyph) catch @panic("invalid UTF-8");
    try t.expectEqual(@as(u21, 0x2715), cp);
}
