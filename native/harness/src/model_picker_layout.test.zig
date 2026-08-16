//! Host dvui testing-backend layout-rect tests for `model_picker.zig`.
//! Asserts trigger height stays PICKER_TRIGGER_H (32 logical / 64 physical)
//! for count 0 and count > 1. No pixels, no SDL/GLFW/OpenGL.
//!
//! Two frames: auto-sized boxes start at 0×0 on frame 1; the second frame
//! picks up the settled layout. The testing backend uses a 2× physical pixel
//! scale by default — assertions use physical pixels with `PX = 2`.
//!
//! The count>1 trigger has a 1 px border. `min_size_content.h` is passed
//! minus 2×border so the tagged outer rect stays `PICKER_TRIGGER_H`.
const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const model_picker = @import("model_picker.zig");

const EPS: f32 = 2.0;
const PX: f32 = 2;

const ids_two = [_][]const u8{ "anthropic/claude-a", "openai/gpt-b" };

fn idAt0(_: u32) []const u8 {
    return "";
}

fn idAt2(index: u32) []const u8 {
    if (index >= ids_two.len) return "";
    return ids_two[index];
}

fn paintTrigger(view: model_picker.CatalogView) dvui.Rect.Physical {
    const frame = struct {
        var held: model_picker.CatalogView = undefined;
        fn paint() !dvui.App.Result {
            _ = model_picker.paint(held);
            return .ok;
        }
    };
    frame.held = view;

    _ = dvui.testing.step(frame.paint) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame.paint) catch @panic("step 2 failed");

    return (dvui.tagGet("status-model-trigger") orelse @panic("tag 'status-model-trigger' not found")).rect;
}

test "count 0: trigger tagged, height ≈ PICKER_TRIGGER_H" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rect = paintTrigger(.{
        .count = 0,
        .selected = 0,
        .busy = false,
        .short_label = "",
        .idAt = idAt0,
    });
    try t.expectApproxEqAbs(model_picker.PICKER_TRIGGER_H * PX, rect.h, EPS);
}

test "count > 1: trigger tagged, height still ≤ PICKER_TRIGGER_H + slack" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rect = paintTrigger(.{
        .count = 2,
        .selected = 0,
        .busy = false,
        .short_label = "claude-a",
        .idAt = idAt2,
    });
    try t.expectApproxEqAbs(model_picker.PICKER_TRIGGER_H * PX, rect.h, EPS);
}
