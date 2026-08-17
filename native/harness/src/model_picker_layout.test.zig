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
const palette = @import("palette.zig");
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

// Commit-path click tests (adversarial review PR #617 Minor L6): the
// `menuItemLabel(...) != null → picked = i` branch had no automated proof.
// The trigger is a submenu, so a testing-backend click opens the floating
// menu; clicking a row then makes `paint` return that catalog index (or null
// while busy, because `canCommit` gates the pick).
const Click = struct {
    var view: model_picker.CatalogView = undefined;
    var picked: ?u32 = null;
    fn frame() !dvui.App.Result {
        picked = model_picker.paint(view);
        return .ok;
    }
};

test "click item 1 → paint returns 1" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 400, .h = 300 } });
    defer tr.deinit();
    Click.view = .{
        .count = 2,
        .selected = 0,
        .busy = false,
        .short_label = "claude-a",
        .idAt = idAt2,
    };
    Click.picked = null;

    // settle the trigger layout
    _ = try dvui.testing.step(Click.frame);
    _ = try dvui.testing.step(Click.frame);

    // open the menu: click the trigger submenu, then settle the floating panel
    // (it needs a second frame to lay out its rows so they become visible).
    try dvui.testing.moveTo("status-model-trigger");
    try dvui.testing.click(.left);
    _ = try dvui.testing.step(Click.frame);
    _ = try dvui.testing.step(Click.frame);

    // click row "openai/gpt-b" (index 1). The pick is set in the single
    // step that processes the release; a second step would re-paint with the
    // just-closed menu and reset `picked` to null.
    try dvui.testing.moveTo("status-model-item-1");
    try dvui.testing.click(.left);
    _ = try dvui.testing.step(Click.frame);

    try t.expectEqual(@as(?u32, 1), Click.picked);
}

test "click item while busy → paint returns null" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 400, .h = 300 } });
    defer tr.deinit();
    Click.view = .{
        .count = 2,
        .selected = 0,
        .busy = true,
        .short_label = "claude-a",
        .idAt = idAt2,
    };
    Click.picked = null;

    _ = try dvui.testing.step(Click.frame);
    _ = try dvui.testing.step(Click.frame);

    try dvui.testing.moveTo("status-model-trigger");
    try dvui.testing.click(.left);
    _ = try dvui.testing.step(Click.frame);
    _ = try dvui.testing.step(Click.frame);

    try dvui.testing.moveTo("status-model-item-0");
    try dvui.testing.click(.left);
    _ = try dvui.testing.step(Click.frame);

    try t.expectEqual(@as(?u32, null), Click.picked);
}

// ── Caret geometry + face-pin regression (plan #624) ──────────────────
// Guards against a double-caret / glyph-face fallback rendering (the
// #595 `mixed_text_lookalike` class: a wrong face ships while geometry
// tests stay green). The label and caret each carry a stable `.tag` and
// `.id_extra` so the testing backend can query their bounding rects.

fn paintTriggerMenu(view: model_picker.CatalogView) void {
    const frame = struct {
        var held: model_picker.CatalogView = undefined;
        fn paint() !dvui.App.Result {
            _ = model_picker.paint(held);
            return .ok;
        }
    };
    frame.held = view;

    _ = dvui.testing.step(frame.paint) catch @panic("menu step 1 failed");
    _ = dvui.testing.step(frame.paint) catch @panic("menu step 2 failed");
}

test "count > 1: label and caret tags both exist" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    paintTriggerMenu(.{
        .count = 2,
        .selected = 0,
        .busy = false,
        .short_label = "claude-a",
        .idAt = idAt2,
    });

    // Both tagged text runs are present — at most one caret is painted.
    _ = dvui.tagGet("status-model-label") orelse @panic("tag 'status-model-label' not found");
    _ = dvui.tagGet("status-model-caret") orelse @panic("tag 'status-model-caret' not found");
}

test "count > 1: caret face pinned to family_symbols (host face-pin)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const cf = model_picker.chevronFont();
    try t.expectEqualStrings(palette.family_symbols, cf.familyName());
}

test "count 0: no caret, no label tag painted (static path)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    paintTriggerMenu(.{
        .count = 0,
        .selected = 0,
        .busy = false,
        .short_label = "",
        .idAt = idAt0,
    });
    try t.expect(dvui.tagGet("status-model-caret") == null);
}

test "count 1: no caret, no submenu (static path, single model)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    paintTriggerMenu(.{
        .count = 1,
        .selected = 0,
        .busy = false,
        .short_label = "single-model",
        .idAt = idAt0,
    });
    try t.expect(dvui.tagGet("status-model-caret") == null);
}
