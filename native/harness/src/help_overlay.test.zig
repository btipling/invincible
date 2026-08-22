//! Host unit tests for ui/help_overlay.zig.
//!
//! Two families:
//!   * plan #761 Nit L6 — pin the leader chord glyphs (`rowChord` is a hardcoded
//!     parallel `switch (row.action)`, not derived from the keymap table; a
//!     revert to the pre-#761 "Leader Space" strings must fail CI).
//!   * plan #781 — paint the overlay modal `floatingWindow` under the dvui
//!     testing backend and lock the new behavior: wide fill-band panel (no more
//!     460×320 cap), two-column table (stable chord/help x), ~390px on-canvas
//!     with internal scroll, wheel stays in the panel (overlay list scrolls), and
//!     backdrop click-outside closes (NEW at #781).
//!
//! The testing backend never rasterizes — geometry via `tagGet().rect` only
//! (physical px; 2× logical by default). `settle()` runs frames until the
//! modal stops requesting refresh (its first frame hides the panel, the second
//! draws it).
const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const help = @import("ui/help_overlay.zig");
const keymap = @import("keymap.zig");

/// Physical-pixel scale of the dvui testing backend (logical × 2).
const PX: f32 = 2.0;
/// Tolerance for same-column x equality.
const COL_EPS: f32 = 3.0;

// ── plan #761 Nit L6 string pins (kept unchanged) ──────────────────────────────

test "help_overlay: leader chord glyphs are Ctrl+I family (plan #761 Nit L6)" {
    const want = [_]struct { action: keymap.Action, chord: []const u8 }{
        .{ .action = .leader, .chord = "Ctrl+I" },
        .{ .action = .help_toggle_leader, .chord = "Leader I, then ?" },
        .{ .action = .thinking_default_toggle, .chord = "Leader I, then t" },
    };
    for (want) |w| {
        var matched = false;
        for (keymap.KEY_TABLE) |row| {
            if (row.action == w.action) {
                matched = true;
                try t.expectEqualStrings(w.chord, help.rowChord(row));
            }
        }
        try t.expect(matched);
    }
}

test "help_overlay: no stale Space / Ctrl+Shift+Space chord survives (plan #761 Nit L6)" {
    var saw_leader = false;
    for (keymap.KEY_TABLE) |row| {
        if (row.action == .leader) saw_leader = true;
        const chord = help.rowChord(row);
        try t.expect(std.mem.indexOf(u8, chord, "Space") == null);
    }
    try t.expect(saw_leader);
}

test "help_overlay: row.help copy carries no stale Space chord (plan #761 Nit L6)" {
    for (keymap.KEY_TABLE) |row| {
        try t.expect(std.mem.indexOf(u8, row.help, "Space") == null);
    }
}

// ── plan #781 paint locks (dvui testing backend) ───────────────────────────────

/// Drives `help_overlay.paint` over a full-window band. `got_close` records the
/// paint's backdrop-close return so tests can assert click-outside behavior.
const Frame = struct {
    var band_w: f32 = 640;
    var band_h: f32 = 400;
    var got_close: bool = false;

    fn paint() !dvui.App.Result {
        got_close = help.paint(0, 0, band_w, band_h, .{ .composer = true });
        return .ok;
    }
};

fn settleOverlay() void {
    _ = dvui.testing.settle(Frame.paint) catch @panic("help overlay settle failed");
}

test "wide band: panel fills most of the band (no 460×320 cap) and is tall" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 1200, .h = 800 } });
    defer tr.deinit();
    Frame.band_w = 1200;
    Frame.band_h = 800;
    settleOverlay();

    const sa = try dvui.testing.tagGet("overlay-scroll-area");
    // Physical px. The old cap was 460 logical = 920 physical; the scroll area
    // (≈ the panel interior) alone must be far wider and taller.
    try t.expect(sa.rect.w > 1700.0); // ≫ 920 (old fixed 460 cap)
    try t.expect(sa.rect.h > 900.0); //  ≫ 640 (old fixed 320 cap)
}

test "two-column table: every chord and every help string starts on a stable x" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 800, .h = 600 } });
    defer tr.deinit();
    Frame.band_w = 800;
    Frame.band_h = 600;
    settleOverlay();

    const c0 = try dvui.testing.tagGet("overlay-chord-0");
    const c1 = try dvui.testing.tagGet("overlay-chord-1");
    const h0 = try dvui.testing.tagGet("overlay-help-0");
    const h1 = try dvui.testing.tagGet("overlay-help-1");

    // Chord column: fixed x across rows.
    try t.expectApproxEqAbs(c0.rect.x, c1.rect.x, COL_EPS);
    // Help column: remaining-width x, stable across rows.
    try t.expectApproxEqAbs(h0.rect.x, h1.rect.x, COL_EPS);
    // Help is to the right of the chord column (fixed chord width).
    try t.expect(h0.rect.x > c0.rect.x);
}

test "~390px band: panel on-canvas, no horizontal overflow, list still scrolls" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 390, .h = 300 } });
    defer tr.deinit();
    Frame.band_w = 390;
    Frame.band_h = 300;
    settleOverlay();

    const sa = try dvui.testing.tagGet("overlay-scroll-area");
    const win_w_px = dvui.windowRectPixels().w;
    // No horizontal overflow: the panel (≈ scroll area) stays within the window.
    try t.expect(sa.rect.x >= -1.0);
    try t.expect(sa.rect.x + sa.rect.w <= win_w_px + 1.0);
    // Still a usable on-canvas panel (fills most of a ~390 band).
    try t.expect(sa.rect.w > 0.6 * win_w_px);
    // Internal scroll: many rows overflow the list viewport.
    try t.expect(help.ctx_scroll.scrollMax(.vertical) > 0);
}

test "wheel over the panel scrolls the overlay list, not the transcript (Goal 2)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 600, .h = 300 } });
    defer tr.deinit();
    Frame.band_w = 600;
    Frame.band_h = 300;
    Frame.got_close = false;
    settleOverlay();

    // The list must overflow its viewport for a wheel to move anything.
    try t.expect(help.ctx_scroll.scrollMax(.vertical) > 0);

    const before = help.ctx_scroll.offset(.vertical);
    // The modal subwindow owns `overlay-scroll-area`: wheel over it is routed to
    // the overlay's own ScrollInfo (never the transcript, which is not in this
    // frame at all — the offset moving proves the wheel was captured here).
    try dvui.testing.moveTo("overlay-scroll-area");
    // Negative wheel_y scrolls the content DOWN (offset increases; ScrollContainer
    // does `scrollByOffset(.vertical, -wheel_y)`), so it moves away from the top
    // clamp and we can assert the overlay's own list scrolled.
    _ = try dvui.currentWindow().addEventMouseWheel(-6.0, .vertical, null);
    _ = try dvui.testing.step(Frame.paint);
    const after = help.ctx_scroll.offset(.vertical);
    try t.expect(after > before);
}

test "backdrop click-outside closes; click inside the panel does not (2b)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 640, .h = 480 } });
    defer tr.deinit();
    Frame.band_w = 640;
    Frame.band_h = 480;
    Frame.got_close = false;
    settleOverlay();

    // Click inside the panel (on the first chord row) → no close.
    try dvui.testing.moveTo("overlay-chord-0");
    _ = try dvui.currentWindow().addEventMouseButton(.left, .press);
    _ = try dvui.currentWindow().addEventMouseButton(.left, .release);
    _ = try dvui.testing.step(Frame.paint);
    try t.expect(!Frame.got_close);

    // Click the dimmed backdrop far from the panel → close requested.
    Frame.got_close = false;
    _ = try dvui.currentWindow().addEventMouseMotion(.{ .pt = .{ .x = 8 * PX, .y = 8 * PX } });
    _ = try dvui.currentWindow().addEventMouseButton(.left, .press);
    _ = try dvui.currentWindow().addEventMouseButton(.left, .release);
    _ = try dvui.testing.step(Frame.paint);
    try t.expect(Frame.got_close);
}
