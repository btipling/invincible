//! Host dvui testing-backend layout-rect tests for `reasoning_picker.zig`.
//! Hidden when count == 0. Trigger height locked at PICKER_TRIGGER_H (32).
const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const reasoning_picker = @import("reasoning_picker.zig");

const EPS: f32 = 2.0;
const PX: f32 = 2;

const ids_three = [_][]const u8{ "low", "high", "max" };

fn idAt3(index: u32) []const u8 {
    if (index >= ids_three.len) return "";
    return ids_three[index];
}

fn paintTrigger(view: reasoning_picker.CatalogView) ?dvui.Rect.Physical {
    const frame = struct {
        var held: reasoning_picker.CatalogView = undefined;
        fn paint() !dvui.App.Result {
            _ = reasoning_picker.paint(held);
            return .ok;
        }
    };
    frame.held = view;

    _ = dvui.testing.step(frame.paint) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame.paint) catch @panic("step 2 failed");

    const tag = dvui.tagGet("status-effort-trigger") orelse return null;
    return tag.rect;
}

test "count 0: trigger hidden (no tag)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rect = paintTrigger(.{
        .count = 0,
        .selected = 0,
        .busy = false,
        .short_label = "",
        .idAt = idAt3,
    });
    try t.expect(rect == null);
}

test "count 1: trigger tagged, height ≈ PICKER_TRIGGER_H" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rect = paintTrigger(.{
        .count = 1,
        .selected = 0,
        .busy = false,
        .short_label = "low",
        .idAt = idAt3,
    }) orelse @panic("tag 'status-effort-trigger' not found");
    try t.expectApproxEqAbs(reasoning_picker.PICKER_TRIGGER_H * PX, rect.h, EPS);
}

test "count > 1: trigger tagged, height still ≤ PICKER_TRIGGER_H + slack" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rect = paintTrigger(.{
        .count = 3,
        .selected = 0,
        .busy = false,
        .short_label = "low",
        .idAt = idAt3,
    }) orelse @panic("tag 'status-effort-trigger' not found");
    try t.expect(rect.h + EPS >= reasoning_picker.PICKER_TRIGGER_H * PX);
    try t.expect(rect.h <= reasoning_picker.PICKER_TRIGGER_H * PX + EPS);
}
