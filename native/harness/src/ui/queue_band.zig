//! Compact in-canvas submit-queue list above the composer (plan #664).
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("../bridge.zig");
const palette = @import("../palette.zig");
const queue_preview = @import("../queue_preview.zig");
const state = @import("state.zig");
const metrics = @import("metrics.zig");
const chrome = @import("chrome.zig");

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
        handleEscape();
    }
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
        te.deinit();
        if (submitChord()) {
            saveEdit(i, typed);
        }
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
    if (dvui.button(@src(), "×", .{}, .{
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

fn beginEdit(i: u32) void {
    const text = bridge.queuedItemAt(i) orelse return;
    @memset(&state.queue_edit_buf, 0);
    const n = @min(text.len, state.queue_edit_buf.len);
    if (n > 0) @memcpy(state.queue_edit_buf[0..n], text[0..n]);
    state.queue_editing_index = i;
}

fn saveEdit(i: u32, typed: []const u8) void {
    if (bridge.replaceQueuedAt(i, typed)) {
        closeEdit();
    }
}

fn cancelEdit() void {
    if (state.queue_editing_index != null) closeEdit();
}

fn closeEdit() void {
    state.queue_editing_index = null;
    @memset(&state.queue_edit_buf, 0);
    state.queue_closed_edit = true;
}

fn submitChord() bool {
    const es = dvui.events();
    var hit = false;
    for (0..es.len) |idx| {
        const e = &es[idx];
        if (e.handled) continue;
        const ke = switch (e.evt) {
            .key => |k| k,
            else => continue,
        };
        if (ke.code == .enter and (ke.mod.control() or ke.mod.command())) {
            e.handled = true;
            if (ke.action == .down) hit = true;
        }
    }
    return hit;
}

fn handleEscape() void {
    const es = dvui.events();
    for (0..es.len) |idx| {
        const e = &es[idx];
        if (e.handled) continue;
        const ke = switch (e.evt) {
            .key => |k| k,
            else => continue,
        };
        if (ke.code == .escape and ke.action == .down) {
            e.handled = true;
            cancelEdit();
            return;
        }
    }
}
