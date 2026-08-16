//! Host dvui testing-backend layout-rect tests for `transcript_split.zig`.
//! Asserts closed/open rail widths from real dvui layout rects (not just
//! constant arithmetic). No pixels, no SDL/GLFW/OpenGL.
//!
//! Two frames: auto-sized boxes start at 0×0 on frame 1; the second frame
//! picks up the settled layout. The testing backend uses a 2× physical pixel
//! scale by default — assertions use physical pixels with `PX = 2`.
//!
//! dvui tag rects **include the widget's margin**. The rail uses no outer
//! margin and draws a 1 px TEAL right border (inside its rect), so tag `w`
//! = `paneWidth * PX`. The toggle button zeroes inherited dvui defaults
//! (margin/padding/border) so its outer tag rect matches `TOUCH_H * PX`.

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
    const toggle = dvui.tagGet("transcript-rail-toggle") orelse @panic("toggle tag not found");
    // Button chrome zeroed; toggle is TOUCH_H × TOUCH_H (± dvui rounding at 2×).
    try t.expectApproxEqAbs(transcript_split.TOUCH_H * PX, toggle.rect.w, PX);
    try t.expectApproxEqAbs(transcript_split.TOUCH_H * PX, toggle.rect.h, PX);
}

test "open: rail width is SIDEBAR_OPEN_W; toggle tag still present" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    transcript_split.reset();
    transcript_split.setOpen(true);
    const rail = paintAndGetRail();
    try t.expectApproxEqAbs(transcript_split.SIDEBAR_OPEN_W * PX, rail.w, EPS);
    try t.expectApproxEqAbs(BAND_H * PX, rail.h, EPS);
    const toggle = dvui.tagGet("transcript-rail-toggle") orelse @panic("toggle tag not found");
    // Button chrome zeroed; toggle is TOUCH_H × TOUCH_H (± dvui rounding at 2×).
    try t.expectApproxEqAbs(transcript_split.TOUCH_H * PX, toggle.rect.w, PX);
    try t.expectApproxEqAbs(transcript_split.TOUCH_H * PX, toggle.rect.h, PX);
}

// Root window logical width — dvui testing backend defaults to 800×600.
// The scroller sibling rect uses this to compute remaining width like ui.zig.
const ROOT_W: f32 = 800;

// Paints the rail + a tagged sibling box with the scroller's remaining-width
// rect (x = pane_w, w = ROOT_W − pane_w). Asserts that the sibling DOES NOT
// overlap the rail, its right edge hits the canvas, and the widths add up.
test "sibling box with scroller rect: no overlap, spans remaining width" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    transcript_split.reset();

    const pane_w: f32 = transcript_split.paneWidth();
    const scroller_w = @max(0, ROOT_W - pane_w);

    const frame = struct {
        fn paint() !dvui.App.Result {
            const pw = transcript_split.paneWidth();
            const sw = @max(0, ROOT_W - pw);
            transcript_split.paint(0, BAND_H);
            {
                var sib = dvui.box(@src(), .{ .dir = .vertical }, .{
                    .rect = .{ .x = pw, .y = 0, .w = sw, .h = BAND_H },
                    .background = true,
                    .tag = "scroller-stand-in",
                    .id_extra = 0x7fff_0000,
                    .min_size_content = .{ .w = sw, .h = BAND_H },
                });
                defer sib.deinit();
            }
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const rail = (dvui.tagGet("transcript-rail") orelse @panic("rail tag not found")).rect;
    const sib = (dvui.tagGet("scroller-stand-in") orelse @panic("scroller-stand-in tag not found")).rect;

    // Rail: starts at x=0, width = pane_w.
    try t.expectApproxEqAbs(0, rail.x, EPS);
    try t.expectApproxEqAbs(pane_w * PX, rail.w, EPS);

    // Sibling: starts at rail's right edge.
    try t.expectApproxEqAbs(pane_w * PX, sib.x, EPS);
    try t.expectApproxEqAbs(scroller_w * PX, sib.w, EPS);

    // Sibling right edge = canvas right edge (ROOT_W * PX at 2×).
    try t.expectApproxEqAbs(ROOT_W * PX, sib.x + sib.w, EPS);

    // No overlap: rail right edge ≤ sibling left edge.
    try t.expect(rail.x + rail.w <= sib.x + EPS);
}
