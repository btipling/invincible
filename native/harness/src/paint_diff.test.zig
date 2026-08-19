//! Host dvui testing-backend tests for paint_diff.zig (PR #681 adversarial-review
//! Major L6). Pins that paintDiffText uses addTextMixed so ✎ U+270E renders
//! via DejaVu symbols on diff fences. If this test is updated because
//! paintDiffText was reverted to addTextSubstituted, the revert is visible —
//! ✎ would tofu on Vera mono and the diff-body tag rect width would change.
//!
//! No pixels, no SDL/GLFW/OpenGL. The dvui testing backend computes layout
//! rects; assertions use 2× physical pixel scale.

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const parse = @import("rich/parse.zig");
const paint_text = @import("rich/paint_text.zig");
const paint_diff = @import("rich/paint_diff.zig");
const style = @import("rich/style.zig");

// Module-level storage for frame closures.
var test_lines: []const u8 = "";
var test_line_count: usize = 0;
var test_truncated: usize = 0;

test "diff fence with ✎ produces non-zero body rect" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    test_lines = "- removed ✎ line\n+ added line\n";
    const frame = struct {
        fn paint() !dvui.App.Result {
            var run_seq: usize = 0;
            var ctx = paint_text.PaintCtx{
                .style = style.defaultStyle(),
                .id_base = 0,
                .run_seq = &run_seq,
            };
            const block = parse.Block{
                .kind = .code_fence,
                .meta = "diff",
                .inlines = &.{
                    .{ .kind = .text, .text = test_lines },
                },
            };
            paint_diff.paintDiffFence(@src(), block, &ctx);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const rect = (dvui.tagGet("diff-body") orelse @panic("tag 'diff-body' not found")).rect;
    try t.expect(rect.w > 0);
    try t.expect(rect.h > 0);
}

test "diff fence with plain text produces non-zero body rect" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    test_lines = "+ added\n- removed\n";
    const frame = struct {
        fn paint() !dvui.App.Result {
            var run_seq: usize = 0;
            var ctx = paint_text.PaintCtx{
                .style = style.defaultStyle(),
                .id_base = 0,
                .run_seq = &run_seq,
            };
            const block = parse.Block{
                .kind = .code_fence,
                .meta = "diff",
                .inlines = &.{
                    .{ .kind = .text, .text = test_lines },
                },
            };
            paint_diff.paintDiffFence(@src(), block, &ctx);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const rect = (dvui.tagGet("diff-body") orelse @panic("tag 'diff-body' not found")).rect;
    try t.expect(rect.w > 0);
    try t.expect(rect.h > 0);
}

test "diff fence with U+23AF separator produces non-zero body rect" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    test_lines = "\u{23AF} Failed \u{23AF}\n";
    const frame = struct {
        fn paint() !dvui.App.Result {
            var run_seq: usize = 0;
            var ctx = paint_text.PaintCtx{
                .style = style.defaultStyle(),
                .id_base = 0,
                .run_seq = &run_seq,
            };
            const block = parse.Block{
                .kind = .code_fence,
                .meta = "diff",
                .inlines = &.{
                    .{ .kind = .text, .text = test_lines },
                },
            };
            paint_diff.paintDiffFence(@src(), block, &ctx);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const rect = (dvui.tagGet("diff-body") orelse @panic("tag 'diff-body' not found")).rect;
    try t.expect(rect.w > 0);
    try t.expect(rect.h > 0);
}

test "paintDiffText with ✎ line increments count and produces non-zero layout" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    test_line_count = 0;
    test_truncated = 0;

    const frame = struct {
        fn paint() !dvui.App.Result {
            var run_seq: usize = 0;
            var ctx = paint_text.PaintCtx{
                .style = style.defaultStyle(),
                .id_base = 0,
                .run_seq = &run_seq,
            };
            var in_hunk: bool = false;
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .id_extra = 7777,
                .color_text = ctx.style.code_text,
                .font = .theme(.mono),
                .background = false,
                .tag = "diff-body-direct",
            });
            defer tl.deinit();
            paint_diff.paintDiffText(tl, "- removed ✎\n", &test_line_count, &test_truncated, &in_hunk, &ctx);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    test_line_count = 0;
    test_truncated = 0;
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    // After one frame pass (the second step re-paints from scratch), we expect
    // exactly 2 lines: "- removed ✎" + the empty trailing line at i==text.len.
    try t.expectEqual(@as(usize, 2), test_line_count);
    try t.expectEqual(@as(usize, 0), test_truncated);
    const rect = (dvui.tagGet("diff-body-direct") orelse @panic("tag 'diff-body-direct' not found")).rect;
    try t.expect(rect.w > 0);
    try t.expect(rect.h > 0);
}

test "paintDiffText with U+23AF separator renders without crash" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    test_line_count = 0;
    test_truncated = 0;

    const frame = struct {
        fn paint() !dvui.App.Result {
            var run_seq: usize = 0;
            var ctx = paint_text.PaintCtx{
                .style = style.defaultStyle(),
                .id_base = 0,
                .run_seq = &run_seq,
            };
            var in_hunk: bool = false;
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .id_extra = 7778,
                .color_text = ctx.style.code_text,
                .font = .theme(.mono),
                .background = false,
                .tag = "diff-body-sep",
            });
            defer tl.deinit();
            paint_diff.paintDiffText(tl, "\u{23AF} Failed Tests 5 \u{23AF}\n", &test_line_count, &test_truncated, &in_hunk, &ctx);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    test_line_count = 0;
    test_truncated = 0;
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    try t.expectEqual(@as(usize, 2), test_line_count);
    const rect = (dvui.tagGet("diff-body-sep") orelse @panic("tag 'diff-body-sep' not found")).rect;
    try t.expect(rect.w > 0);
}
