//! Compact in-canvas submit-queue list above the composer (plan #664).
//! Cancel button glyph: ✕ U+2715 (DejaVu symbols subset; Vera lacks U+00D7).
pub const cancel_glyph = "\u{2715}";
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("../bridge.zig");
const palette = @import("../palette.zig");
const queue_preview = @import("../queue_preview.zig");
const submit_queue = @import("../submit_queue.zig");
const state = @import("state.zig");
const metrics = @import("metrics.zig");
const chrome = @import("chrome.zig");
const scroll = @import("scroll.zig");

/// Reset all queue-edit state to idle — called from `ui.zig` on ring clear
/// (`n < prev_msg`) and on the `queuedCount()==0` empty-FIFO guard (plan #677
/// fix 2 + adversarial review #680 Major L6). Exported as a pub helper so the
/// unit test can call it directly.
pub fn resetQueueEditState() void {
    state.queue_editing_index = null;
    state.queue_edit_textentry_id = null;
    state.queue_want_editor_focus = false;
    state.queue_edit_seen_focused = false;
    state.prev_queue_band_h = 0;
    state.queue_closed_edit = false;
    @memset(&state.queue_edit_buf, 0);
}

/// Predicate extracted from the `paint()` blur-save guard so a host-target
/// unit test can prove the `seen_focused` conjunct works. `focused` is the
/// dvui-global focused-widget id (null when no window is active or no widget
/// has focus). Removing the `seen_focused` conjunct (reverting to the #666
/// condition) makes this return true when `seen_focused` is false and
/// `focused` is null — the first-frame premature-close bug (plan #677 fix 1,
/// adversarial review #680 Round 2 Major L6).
pub fn shouldBlurSave(te_id: dvui.Id, focused: ?dvui.Id) bool {
    if (!state.queue_edit_seen_focused) return false;
    return focused == null or focused.? != te_id;
}

/// Predicate extracted from the `ui.zig` empty-FIFO guard so a host-target
/// unit test can prove the condition logic. Removing the `queuedCount()==0`
/// guard from `ui.zig` (reverting the #677 fix 2) would leave the editing
/// latch set after a hydrate-to-same-or-longer-session, ghosting a band and
/// blocking promote (adversarial review #680 Round 2 Major L6).
pub fn shouldDropEditOnEmptyQueue() bool {
    return state.queue_editing_index != null and bridge.queuedCount() == 0;
}

/// Plan #759 / adversarial-review Major — reconcile the queue-row edit latch
/// after a HOST front-insert (the give-up `Continue` head). `submit_queue.insertFront`
/// shifts every queued slot down one but can't touch `state.queue_editing_index`
/// (UI-owned; bridge is lower). Consuming `bridge.takeFrontInsertSignal()` tells
/// us a front-insert happened; bump the open edit index by one so blur/Ctrl+Enter
/// `saveEdit` targets the row the operator was actually editing — not the new row
/// that slid into the old slot (which would be overwritten/lost). No-op when no
/// front-insert is pending and/or no edit is open. Exported so host tests can
/// drive the same production path (`queue_band.test.zig`).
pub fn reconcileFrontInsert() void {
    if (!bridge.takeFrontInsertSignal()) return;
    if (state.queue_editing_index) |e| {
        state.queue_editing_index = e + 1;
    }
}

pub fn desiredHeight() f32 {
    const n = bridge.queuedCount();
    const editing = state.queue_editing_index != null;
    if (n == 0 and !editing) return 0;
    const rows = @min(@as(u32, if (n == 0) 1 else n), metrics.QUEUE_BAND_MAX_ROWS);
    return metrics.TOUCH_H + @as(f32, @floatFromInt(rows)) * metrics.TOUCH_H;
}

pub fn paint(band_y: f32, band_h: f32, avail_w: f32) void {
    if (band_h < 1) return;
    const n = bridge.queuedCount();

    var band = dvui.box(@src(), .{ .dir = .vertical }, .{
        .rect = .{ .x = 0, .y = band_y, .w = avail_w, .h = band_h },
        .background = true,
        .color_fill = palette.teal_bg,
        .color_border = palette.teal_border,
        .padding = .all(0),
        .border = .{ .x = 0, .y = 1, .w = 0, .h = 0 },
    });
    defer band.deinit();

    {
        var header = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 40, .h = metrics.TOUCH_H },
            .max_size_content = .{ .w = dvui.max_float_safe, .h = metrics.TOUCH_H },
            .background = true,
            .color_fill = palette.teal_bg,
            .padding = .{ .x = 8, .y = 0, .w = 4, .h = 0 },
        });
        defer header.deinit();

        var label_buf: [32]u8 = undefined;
        const label = std.fmt.bufPrint(&label_buf, "{d} queued", .{n}) catch "queued";
        dvui.labelNoFmt(@src(), label, .{}, .{
            .gravity_y = 0.5,
            .color_text = palette.teal_muted,
            .expand = .horizontal,
        });
        if (n >= @as(u32, @intCast(submit_queue.MAX_ITEMS))) {
            // Queue at capacity — a further ▶ / Ctrl+Enter is a no-op. EMBER
            // makes the failed enqueue visible instead of silent (adversarial
            // review #666, L9 Minor).
            dvui.labelNoFmt(@src(), "· full", .{}, .{
                .gravity_y = 0.5,
                .color_text = palette.ember_text,
            });
        }
        if (n > 0) {
            if (dvui.button(@src(), "Clear", .{}, .{
                .gravity_y = 0.5,
                .style = .content,
                .min_size_content = .{ .w = 56, .h = metrics.TOUCH_H },
                .color_fill = palette.teal_surface,
                .color_text = palette.teal_text,
                .color_border = palette.teal_border,
            })) {
                cancelEdit();
                bridge.clearSubmitQueue();
            }
        }
    }

    const list_h = @max(0, band_h - metrics.TOUCH_H);
    // After scroll_area.deinit() (LIFO) virtual_size includes this frame's
    // rows — then snap to the newest if enqueue latched a follow. Deleting
    // this defer is a silent regress of #696 (queue_list_scroll stale —
    // enqueue runs after paint, so submitOrEnqueue can't scroll it directly).
    defer followIfRequested();
    var scroll_area = dvui.scrollArea(@src(), .{
        .scroll_info = &state.queue_list_scroll,
        .vertical_bar = .auto,
    }, .{
        .expand = .horizontal,
        .min_size_content = .{ .w = 40, .h = list_h },
        .max_size_content = .{ .w = dvui.max_float_safe, .h = list_h },
        .padding = .all(0),
    });
    defer scroll_area.deinit();

    var i: u32 = 0;
    while (i < n) : (i += 1) {
        paintRow(@src(), i);
    }

    if (state.queue_editing_index != null) {
        // Key handling (Escape dismiss + Ctrl/Cmd+Enter save) moved to the
        // single keymap dispatcher (`ui/keymap_dispatch.zig`, plan #741) —
        // this painter reads no keys. The blur-save below is mouse-focus-only.
        // Blur-save: if the queue-row textEntry lost focus this frame
        // (e.g. operator clicked the composer), save the edit and close
        // so promote isn't stalled behind a ghost edit (plan #664, review
        // #666 Minor L1+L8).
        // Guard on seen_focused: the first frame(s) after beginEdit have
        // no TE yet or no focus on it; focused==null or focused≠te_id is
        // normal then and must not close the editor (plan #677 fix 1).
        if (state.queue_edit_textentry_id) |te_id| {
            if (shouldBlurSave(te_id, dvui.focusedWidgetIdInCurrentSubwindow())) {
                const text = std.mem.sliceTo(state.queue_edit_buf[0..], 0);
                saveEdit(@intCast(state.queue_editing_index.?), text);
            }
        }
    }
}

/// Snap `queue_list_scroll` to the newest row when enqueue latched a follow.
/// Called at the end of `paint` (after the list's `scrollArea` deinit so
/// `virtual_size` includes the new row). Pub so host tests can drive it
/// without a dvui frame (plan #699).
pub fn followIfRequested() void {
    if (!state.queue_follow) return;
    scroll.scrollToBottom(&state.queue_list_scroll);
    state.queue_follow = false;
}

fn paintRow(src: std.builtin.SourceLocation, i: u32) void {
    const editing = if (state.queue_editing_index) |e| e == @as(usize, i) else false;
    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .min_size_content = .{ .w = 40, .h = metrics.TOUCH_H },
        .max_size_content = .{ .w = dvui.max_float_safe, .h = metrics.TOUCH_H },
        .id_extra = i,
        .padding = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
        .background = true,
        .color_fill = palette.teal_surface,
    });
    defer row.deinit();

    var typed: []const u8 = state.queue_edit_buf[0..0];
    if (editing) {
        var te = dvui.textEntry(@src(), .{
            .text = .{ .buffer = state.queue_edit_buf[0..] },
            .multiline = false,
        }, .{
            .expand = .horizontal,
            .gravity_y = 0.5,
            .min_size_content = .{ .w = 80, .h = metrics.TOUCH_H - 8 },
            .color_fill = palette.teal_bg,
            .color_text = palette.teal_text,
            .color_border = palette.teal_accent,
            .id_extra = i,
        });
        typed = te.getText();
        state.queue_edit_textentry_id = te.data().id;
        if (state.queue_want_editor_focus) {
            dvui.focusWidget(te.data().id, null, null);
            state.queue_want_editor_focus = false;
        }
        // Track when the TE has actually been focused — blur-save
        // waits for this so the first frame(s) don't close early.
        if (dvui.focusedWidgetIdInCurrentSubwindow()) |fid| {
            if (fid == te.data().id) state.queue_edit_seen_focused = true;
        }
        te.deinit();
        // Ctrl/Cmd+Enter save-edit is handled by the keymap dispatcher
        // (`queue_save` row, plan #741) — `submitChord` inline scan removed.
    } else {
        var preview_buf: [queue_preview.QUEUE_PREVIEW_MAX_BYTES + 1]u8 = undefined;
        const raw = bridge.queuedItemAt(i) orelse "";
        const preview = queue_preview.queuePreview(&preview_buf, raw);
        dvui.labelNoFmt(@src(), preview, .{}, .{
            .gravity_y = 0.5,
            .color_text = palette.teal_text,
            .expand = .horizontal,
            .id_extra = i,
        });
    }

    if (dvui.button(@src(), "✎", .{}, .{
        .gravity_y = 0.5,
        .style = .content,
        .font = chrome.composerIconFont(),
        .min_size_content = .{ .w = metrics.TOUCH_H, .h = metrics.TOUCH_H },
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_accent,
        .color_border = palette.teal_border,
        .id_extra = i,
    })) {
        if (editing) {
            saveEdit(i, typed);
        } else {
            beginEdit(i);
        }
    }
    if (dvui.button(@src(), cancel_glyph, .{}, .{
        .gravity_y = 0.5,
        .style = .content,
        .font = chrome.composerIconFont(),
        .min_size_content = .{ .w = metrics.TOUCH_H, .h = metrics.TOUCH_H },
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_muted,
        .color_border = palette.teal_border,
        .id_extra = i,
    })) {
        if (state.queue_editing_index) |e| {
            if (e == @as(usize, i)) {
                cancelEdit();
            } else if (e > i) {
                state.queue_editing_index = e - 1;
            }
        }
        bridge.removeQueuedAt(i);
    }
}

pub fn beginEdit(i: u32) void {
    const text = bridge.queuedItemAt(i) orelse return;
    @memset(&state.queue_edit_buf, 0);
    const n = @min(text.len, state.queue_edit_buf.len);
    if (n > 0) @memcpy(state.queue_edit_buf[0..n], text[0..n]);
    state.queue_editing_index = i;
    // The textEntry widget doesn't exist yet on this frame (editing was false
    // when paintRow ran) — request focus for the next frame when it's created.
    state.queue_want_editor_focus = true;
    state.queue_edit_seen_focused = false;
}

pub fn saveEdit(i: u32, typed: []const u8) void {
    if (bridge.replaceQueuedAt(i, typed)) {
        closeEdit();
    } else {
        // Blank text or error — replace was rejected (data is not lost).
        // Release the latch so click-away always leaves the editor even
        // when the field was cleared (adversarial review #680 Minor L1).
        cancelEdit();
    }
}

fn cancelEdit() void {
    if (state.queue_editing_index != null) closeEdit();
}

pub fn closeEdit() void {
    state.queue_editing_index = null;
    state.queue_edit_textentry_id = null;
    state.queue_want_editor_focus = false;
    state.queue_edit_seen_focused = false;
    @memset(&state.queue_edit_buf, 0);
    state.queue_closed_edit = true;
}

/// Plan #741 — queue-row Escape dismiss, called by the keymap dispatcher's
/// `cancel_queue_edit` action. Same semantics as the removed `handleEscape`
/// inline scan (dismiss the editor, not the turn). Pub so the dispatcher can
/// reach it without calling the private `cancelEdit`.
pub fn cancelEditFromUi() void {
    if (state.queue_editing_index != null) cancelEdit();
}
