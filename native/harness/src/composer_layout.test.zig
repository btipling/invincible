//! Host dvui testing-backend layout-rect tests for `composer_chrome.zig`
//! (plan #737, source #734). Lock the width-reservation geometry from the REAL
//! painted widget tree — the field lives on an explicit trailing-*reserved*
//! sub-rect `field_w = avail_w − (TOUCH_H×n + 8)`, so a long unbreakable line's
//! reported min width can never squeeze the ▶/■ icon pack off-canvas (mirrors
//! the `busy_row_layout.test.zig` pattern — drives `paintComposerChrome` the
//! same way that test drives `paintBusyRow`).
//!
//! No pixels, no SDL/GLFW/OpenGL: the dvui testing backend computes layout
//! rects (draw is a no-op). **Two frames** are needed because auto-sized boxes
//! start at 0×0 on frame 1 before children report sizes upward in deinit.
//!
//! The testing backend uses a **2× physical pixel scale** (window 600×400 →
//! 1200×800). All assertions use physical pixels via `windowRectPixels()`,
//! with `PX = 2`.
//!
//! dvui tag rects **include the widget's margin**.

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const metrics = @import("ui/metrics.zig");
const composer_chrome = @import("ui/composer_chrome.zig");

/// Sub-pixel rounding tolerance (physical px).
const EPS: f32 = 1.0;
/// Physical pixel scale: testing-backend init defaults to 2×.
const PX: f32 = 2;
/// Logical window content width — the composer chrome box (`expand =
/// .horizontal`) fills this, so the paint fn is invoked with `avail_w` == it.
const WIN_LW: f32 = 600;

/// Fields shared between the frame closure and each test (Zig has no closures,
/// so the test body stages these before stepping the frame).
var T_buf: [512]u8 = [_]u8{0} ** 512;
var T_busy: bool = false;
var T_want_focus: bool = true;
var T_last_res: composer_chrome.Result = .{};

const FieldRects = struct {
    wrap: dvui.Rect.Physical,
    field: dvui.Rect.Physical,
    send: dvui.Rect.Physical,
    stop: ?dvui.Rect.Physical,
};

/// Paint TWO frames of the real `paintComposerChrome` and return the tag rects
/// from the second frame. `T_last_res` holds the second frame's Result.
fn paintAndGetRects() FieldRects {
    const frame = struct {
        fn paint() !dvui.App.Result {
            T_last_res = composer_chrome.paintComposerChrome(.{
                .busy = T_busy,
                .avail_w = WIN_LW,
                .y = 0,
                .h = metrics.COMPOSER_IDLE_CHROME_H,
                .prompt_buf = &T_buf,
                .want_focus = &T_want_focus,
            });
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const wrap = (dvui.tagGet("composer-field-wrap") orelse @panic("tag 'composer-field-wrap' not found")).rect;
    const field = (dvui.tagGet("composer-field") orelse @panic("tag 'composer-field' not found")).rect;
    const send = (dvui.tagGet("composer-send") orelse @panic("tag 'composer-send' not found")).rect;
    const stop = if (dvui.tagGet("composer-stop")) |tr| tr.rect else null;
    return .{ .wrap = wrap, .field = field, .send = send, .stop = stop };
}

/// Zero the shared prompt buffer.
fn resetBuf() void {
    @memset(&T_buf, 0);
}

test "idle: field on reserved sub-rect, ▶ lands post-reserve, field right ≤ ▶ left" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    resetBuf();
    T_busy = false;
    T_want_focus = true;
    const r = paintAndGetRects();
    const win = dvui.windowRectPixels();

    const fw = composer_chrome.fieldW(WIN_LW, false);
    // The reserve holds the wrap to exactly `field_w` — the seam proof that
    // the wrapper is a PACKED child (gravity.x=0), not a centered overlay.
    try t.expectApproxEqAbs(fw * PX, r.wrap.w, EPS);
    // ▶ lands right after the reserved wrap.
    try t.expectApproxEqAbs(r.wrap.x + r.wrap.w, r.send.x, EPS);
    // Field right edge (incl. its 8 px right margin in the tag rect) ≤ ▶ left.
    try t.expect(r.field.x + r.field.w <= r.send.x + EPS);
    // ▶ fully on-canvas (tag rects include the button's default margin, so we
    // assert placement + on-canvas, not an exact TOUCH_H content size).
    try t.expect(r.send.x + r.send.w <= win.w + EPS);
    try t.expect(r.send.w > 0);
    try t.expect(r.send.h > 0);
}

test "busy: ▶ + ■ both land post-reserve (2-slot reserve) and stay on-canvas" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    resetBuf();
    T_busy = true;
    T_want_focus = true;
    const r = paintAndGetRects();
    const win = dvui.windowRectPixels();
    const stop = r.stop orelse @panic("busy must render ■ stop");

    const fw = composer_chrome.fieldW(WIN_LW, true);
    try t.expectApproxEqAbs(fw * PX, r.wrap.w, EPS);
    try t.expectApproxEqAbs(r.wrap.x + r.wrap.w, r.send.x, EPS);
    // ■ starts exactly one TOUCH_H after ▶ (adjacent squares, distinct tags).
    try t.expectApproxEqAbs(r.send.x + r.send.w, stop.x, EPS);
    // Field right edge ≤ ▶ left (field wraps one icon narrower when busy).
    try t.expect(r.field.x + r.field.w <= r.send.x + EPS);
    // Both icons fully on-canvas (tag rects include each button's default
    // margin, so assert placement + on-canvas, not an exact TOUCH_H size).
    try t.expect(stop.x + stop.w <= win.w + EPS);
    try t.expect(stop.w > 0);
    try t.expect(stop.h > 0);
}

test "#734 lock: a long single unbreakable line does NOT push ▶ off-canvas" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    resetBuf();
    // A 200×'A' run with NO spaces: `break_lines` cannot split it, so the
    // field's natural width (the full run) would, WITHOUT the reserved
    // sub-rect, take the whole row and drive the icons off-canvas. With the
    // fix the icons must stay exactly post-reserve.
    @memset(&T_buf, 'A');
    T_buf[200] = 0;
    T_busy = false;
    T_want_focus = true;
    const r = paintAndGetRects();
    const win = dvui.windowRectPixels();

    // Wrap still reports exactly field_w — the field never overflowed the
    // reserve (field min cannot steal the icon slot, no horizontal gutter).
    try t.expectApproxEqAbs(composer_chrome.fieldW(WIN_LW, false) * PX, r.wrap.w, EPS);
    // send.x lands at the reserved post-reserve position, NOT drifting right.
    try t.expectApproxEqAbs((WIN_LW - composer_chrome.iconReserveW(false)) * PX, r.send.x, EPS);
    // Field right edge still ≤ ▶ left.
    try t.expect(r.field.x + r.field.w <= r.send.x + EPS);
    // ▶ fully on-canvas — the #734 regression cannot return.
    try t.expect(r.send.x + r.send.w <= win.w + EPS);
}

test "multi-line prompt: measured outer height grows (dynamic hug intact through extraction)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    resetBuf();
    T_busy = false;
    T_want_focus = true;
    _ = paintAndGetRects(); // single blank line → baseline measured height
    try t.expect(T_last_res.measured_h != null);
    const single_h = T_last_res.measured_h orelse return;

    resetBuf();
    const multi = "line one\nline two\nline three\nline four\n";
    @memcpy(T_buf[0..multi.len], multi);
    T_buf[multi.len] = 0;
    T_want_focus = false;
    _ = paintAndGetRects();
    try t.expect(T_last_res.measured_h != null);
    const multi_h = T_last_res.measured_h orelse return;

    // The extraction must not have broken the vertical wrap measurement: a
    // 4-line prompt reports a taller field than a single blank line. (Host
    // build includes freetype, so wrapped textLayout heights are real.)
    try t.expect(multi_h > single_h + EPS);
}
