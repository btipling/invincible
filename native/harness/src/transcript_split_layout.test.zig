//! Host dvui testing-backend layout-rect tests for `transcript_split.zig`.
//! Asserts closed/open rail widths from real dvui layout rects (not just
//! constant arithmetic). No pixels, no SDL/GLFW/OpenGL.
//!
//! Two frames: auto-sized boxes start at 0×0 on frame 1; the second frame
//! picks up the settled layout. The testing backend uses a 2× physical pixel
//! scale by default — assertions use physical pixels with `PX = 2`.
//!
//! dvui tag rects **include the widget's margin**. The rail uses no outer
//! margin, so tag `w` should match `paneWidth * PX` (plus the 1 px right
//! border, which lives inside the rect).

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const transcript_split = @import("transcript_split.zig");

const EPS: f32 = 1.0;
const PX: f32 = 2;
/// Band height passed to `paint` (logical px) — tall enough for the toggle.
const BAND_H: f32 = 200;

fn paintAndGetRail() dvui.Rect.Physical {
    const frame = struct {
        fn paint() !dvui.App.Result {
            transcript_split.paint(0, BAND_H);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    return (dvui.tagGet("transcript-rail") orelse @panic("tag 'transcript-rail' not found")).rect;
}

test "paneWidthOf is 40 closed and 220 open (no frame)" {
    try t.expectEqual(@as(f32, 40), transcript_split.paneWidthOf(false));
    try t.expectEqual(@as(f32, 220), transcript_split.paneWidthOf(true));
    try t.expectEqual(transcript_split.SIDEBAR_RAIL_W, transcript_split.paneWidthOf(false));
    try t.expectEqual(transcript_split.SIDEBAR_OPEN_W, transcript_split.paneWidthOf(true));
}

test "reset defaults closed; setOpen flips the in-memory flag" {
    transcript_split.setOpen(true);
    try t.expect(transcript_split.isOpen());
    transcript_split.reset();
    try t.expect(!transcript_split.isOpen());
    try t.expectEqual(transcript_split.SIDEBAR_RAIL_W, transcript_split.paneWidth());
}

test "default closed: rail width is SIDEBAR_RAIL_W, height is band_h" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    transcript_split.reset();
    const rail = paintAndGetRail();
    try t.expectApproxEqAbs(transcript_split.SIDEBAR_RAIL_W * PX, rail.w, EPS);
    try t.expectApproxEqAbs(BAND_H * PX, rail.h, EPS);
    try t.expectApproxEqAbs(0, rail.x, EPS);
    _ = dvui.tagGet("transcript-rail-toggle") orelse @panic("toggle tag not found");
}

test "open: rail width is SIDEBAR_OPEN_W; toggle tag still present" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    transcript_split.reset();
    transcript_split.setOpen(true);
    const rail = paintAndGetRail();
    try t.expectApproxEqAbs(transcript_split.SIDEBAR_OPEN_W * PX, rail.w, EPS);
    try t.expectApproxEqAbs(BAND_H * PX, rail.h, EPS);
    _ = dvui.tagGet("transcript-rail-toggle") orelse @panic("toggle tag not found");
}
