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
///
/// The frame paints a TRANSCRIPT STAND-IN scroll container BEFORE the overlay
/// modal — the same order `ui.zig` builds `state.transcript_scroll`'s container
/// (ui.zig:639 paints the overlay only after the transcript laid out). This is
/// what makes the Goal-2 wheel-isolation test able to FAIL: if the overlay
/// regresses to the pre-#781 absolute `dvui.box` (no subwindow), a wheel over
/// the panel is routed to the transcript's container (`windowFor` returns the
/// base window), the transcript offset moves, and the test catches the leak it
/// exists to prevent (adversarial review #783 Major L6).
const Frame = struct {
    var band_w: f32 = 640;
    var band_h: f32 = 400;
    var got_close: bool = false;
    /// ScrollInfo for the transcript stand-in (mirrors `state.transcript_scroll`).
    var transcript_scroll: dvui.ScrollInfo = .{
        .vertical = .auto,
        .horizontal = .none,
    };
    /// Goal-2c instrumentation: when `record_keys` is set, Frame.paint scans the
    /// frame's events after the overlay modal has processed them and records
    /// whether ANY key event was present, and whether any was marked handled. A
    /// floatingWindow subwindow only routes pointer/wheel, so Esc / Ctrl+/ /
    /// leader-? must survive unhandled for keymap_dispatch (which runs after
    /// paint in ui.zig) — keys reach the dispatcher THROUGH the open modal.
    /// Asserting presence too closes the vacuous case (an empty event list would
    /// otherwise satisfy "none handled" — review #783 round-3 Nit L6).
    var record_keys: bool = false;
    var any_key_handled: bool = false;
    var any_key_present: bool = false;

    fn paint() !dvui.App.Result {
        // Transcript stand-in: a scroll container over the same band, painted
        // before the overlay so its `processEvents` runs ahead of the modal.
        // Overflow pseudo-rows give it a non-zero scrollMax so a leaked wheel
        // would measurably move its offset (the break scenario).
        {
            var ts = dvui.scrollArea(@src(), .{
                .scroll_info = &Frame.transcript_scroll,
                .vertical_bar = .auto,
            }, .{
                .expand = .both,
                .padding = .all(0),
                .tag = "transcript-scroll",
            });
            defer ts.deinit();
            var i: usize = 0;
            while (i < 40) : (i += 1) {
                // Loop-unique id so the stand-in never paints duplicate-id red
                // outlines either (same Goal-1 rule as the overlay rows).
                var row = dvui.box(@src(), .{}, .{
                    .id_extra = @intCast(i),
                    .min_size_content = .{ .w = Frame.band_w * PX, .h = 40 * PX },
                });
                row.deinit();
            }
        }

        got_close = help.paint(0, 0, band_w, band_h, .{ .composer = true });

        // Goal-2c instrumentation: the overlay modal has now processed this
        // frame's events (its deinit ran processEventsAfter), so the handled
        // flags are final. The modal routes pointer/wheel only, so keys must stay
        // unhandled — otherwise keymap_dispatch (which runs after paint in
        // ui.zig) would never receive them.
        if (record_keys) {
            any_key_handled = false;
            any_key_present = false;
            for (dvui.events()) |*e| {
                if (e.evt == .key) {
                    any_key_present = true;
                    if (e.handled) any_key_handled = true;
                }
            }
        }
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
    Frame.transcript_scroll = .{ .vertical = .auto, .horizontal = .none };
    settleOverlay();

    // BOTH containers must have room to scroll, so the wheel *could* move either.
    try t.expect(help.ctx_scroll.scrollMax(.vertical) > 0);
    try t.expect(Frame.transcript_scroll.scrollMax(.vertical) > 0);

    const before = help.ctx_scroll.offset(.vertical);
    const t_before = Frame.transcript_scroll.offset(.vertical);
    // The modal subwindow owns `overlay-scroll-area`: wheel over it is routed to
    // the overlay's own ScrollInfo (never the transcript stand-in painted below
    // in the same frame). Negative wheel_y scrolls content DOWN (offset increases;
    // ScrollContainer does `scrollByOffset(.vertical, -wheel_y)`), moving away
    // from the top clamp — asserted against BOTH infos so the transcript is
    // proven untouched (adversarial review #783 Major L6).
    try dvui.testing.moveTo("overlay-scroll-area");
    _ = try dvui.currentWindow().addEventMouseWheel(-6.0, .vertical, null);
    _ = try dvui.testing.step(Frame.paint);

    // Overlay list scrolled (offset moved).
    const after = help.ctx_scroll.offset(.vertical);
    try t.expect(after > before);
    // Transcript offset did NOT move — the wheel stayed in the panel.
    const t_after = Frame.transcript_scroll.offset(.vertical);
    try t.expectApproxEqAbs(t_after, t_before, 0.001);
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

test "Esc / Ctrl+/ / leader-? key events survive the open modal for the dispatcher (plan test 2c)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 600, .h = 300 } });
    defer tr.deinit();
    Frame.band_w = 600;
    Frame.band_h = 300;
    Frame.record_keys = true;
    Frame.any_key_present = false;
    settleOverlay();

    // With the modal open, inject the exact chords the overlay dispatches on
    // (Esc closes, Ctrl+/ toggles, leader `?` = shift+slash closes once armed).
    // A floatingWindow subwindow routes pointer/wheel only — none of these key
    // events may be marked handled by the modal, or keymap_dispatch (which runs
    // after the overlay paint in ui.zig) would never receive them. The old
    // pre-#781 absolute `dvui.box` overlay was not a subwindow either, so it too
    // left keys alone; a future subwindow that starts swallowing keys fails here.
    try dvui.testing.pressKey(.escape, .none);
    try dvui.testing.pressKey(.slash, .lcontrol);
    try dvui.testing.pressKey(.slash, .lshift);
    _ = try dvui.testing.step(Frame.paint);

    // The injected key events were really IN this frame (not an empty event list
    // vacuously satisfying "none handled"), and the modal left them unhandled.
    try t.expect(Frame.any_key_present);
    try t.expect(!Frame.any_key_handled);
    Frame.record_keys = false;
}

test "left-drag on the panel padding is neither grabbed nor moves the panel (Minor L1)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 640, .h = 480 } });
    defer tr.deinit();
    Frame.band_w = 640;
    Frame.band_h = 480;
    settleOverlay();

    const before = (try dvui.testing.tagGet("overlay-scroll-area")).rect;

    // LEFT-press in the panel's LEFT PADDING ring: nothing sits there (the
    // scroll area starts at panel interior), so no child can grab the press and
    // it reaches the floating window's drag handler (`Button.pointer()` is
    // left-or-touch only — an injected `.middle` press is invisible to
    // processEventsAfter, which made the pre-round-3 test vacuous). With
    // `.resize = .none` dvui's DEFAULT drag_area is the FULL panel, so the old
    // behavior translated the centered panel then snapped it back next frame
    // (rect_store recomputes). The empty drag_area must leave it stationary
    // THIS frame — measured right after the single step, before any recenter.
    const px = before.x - 8; // interior-left minus padding → left-drag zone
    const py = before.y + before.h / 2;
    _ = try dvui.currentWindow().addEventMouseMotion(.{ .pt = .{ .x = px, .y = py } });
    _ = try dvui.currentWindow().addEventMouseButton(.left, .press);
    _ = try dvui.currentWindow().addEventMouseMotion(.{ .pt = .{ .x = px + 12 * PX, .y = py + 6 * PX } });
    _ = try dvui.currentWindow().addEventMouseButton(.left, .release);
    _ = try dvui.testing.step(Frame.paint);

    const after = (try dvui.testing.tagGet("overlay-scroll-area")).rect;
    try t.expectApproxEqAbs(before.x, after.x, COL_EPS);
    try t.expectApproxEqAbs(before.y, after.y, COL_EPS);
}

test "two-column x-lock holds across a long vs short chord (hard case, Minor L6)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 800, .h = 600 } });
    defer tr.deinit();
    Frame.band_w = 800;
    Frame.band_h = 600;
    settleOverlay();

    // The fixed chord column keeps the LONGEST chord ("Ctrl/Cmd+Enter", row 0 =
    // submit) and the SHORTEST chord ("↑", row 2 = history_older) on the same x,
    // and both help columns too. The pair above (chord-0/1) was the weak case —
    // queue_save shares submit's identical long chord, so it never separated the
    // short-vs-long asymmetry this lock exists to catch.
    const chord_long = try dvui.testing.tagGet("overlay-chord-0"); // "Ctrl/Cmd+Enter"
    const chord_short = try dvui.testing.tagGet("overlay-chord-2"); // "↑"
    const help_long = try dvui.testing.tagGet("overlay-help-0"); // "Send (enqueue when busy)"
    const help_short = try dvui.testing.tagGet("overlay-help-2"); // "Older message"

    try t.expectApproxEqAbs(chord_long.rect.x, chord_short.rect.x, COL_EPS);
    try t.expectApproxEqAbs(help_long.rect.x, help_short.rect.x, COL_EPS);
    // Help column is still right of the fixed chord column.
    try t.expect(help_short.rect.x > chord_short.rect.x);
}

test "help column wraps long and short copy to the same leftover width (wrap, not clip — Minor L1)" {
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 800, .h = 600 } });
    defer tr.deinit();
    Frame.band_w = 800;
    Frame.band_h = 600;
    settleOverlay();

    // A very long help string ("Send (enqueue when busy)", row 0) and a very
    // short one ("Close help", row 4) differ dram-atically in natural text
    // length. `.expand = .horizontal` forces BOTH help textLayouts to the SAME
    // leftover column width — a revert to an unwrapped textLayout sizes each to
    // its natural text width (differing), so this is a direct probe that the
    // wrap constraint is engaged (long copy wraps to the column instead of
    // clipping past it). The ~390 px band test separately pins no horizontal
    // overflow.
    const hw0 = (try dvui.testing.tagGet("overlay-help-0")).rect.w;
    const hw4 = (try dvui.testing.tagGet("overlay-help-4")).rect.w;
    try t.expectApproxEqAbs(hw0, hw4, 6.0);
}

test "help column on a ~390 band wraps long copy TALLER than one line (wrap, not clip — round-3 Minor L1+L6)" {
    // First measure the SAME long string at a wide band where the help column
    // easily fits it on one line (row 0 "Send (enqueue when busy)", 800 px band).
    var tr = try dvui.testing.init(.{ .window_size = .{ .w = 800, .h = 600 } });
    defer tr.deinit();
    Frame.band_w = 800;
    Frame.band_h = 600;
    settleOverlay();
    const one_line_h = (try dvui.testing.tagGet("overlay-help-0")).rect.h;

    // Now the same help string at ~390 where the leftover column is narrow — it
    // must wrap to MORE than one line. The pre-round-3 code set
    // `max_size_content.h = TOUCH_H - 6`, which clamped the widget's min via
    // `WidgetData.init/minSizeSetAndRefresh`, clipping wrapped lines inside a
    // one-line well regardless of width. With the height cap dropped (width
    // ceiling kept through `MaxSize.width`), the textLayout reports its wrapped
    // height, so a ~390 band renders the copy TALLER than the wide-band one-line
    // height — proving wrap is engaged, not clipped. Comparing the SAME string's
    // two heights (not an absolute px bound) makes the assertion robust to the
    // testing backend's fallback font metrics.
    Frame.band_w = 390;
    Frame.band_h = 420;
    settleOverlay();
    const narrow_h = (try dvui.testing.tagGet("overlay-help-0")).rect.h;
    try t.expect(narrow_h > one_line_h + PX);
}
