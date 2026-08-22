//! In-canvas help overlay — plans #741, #761, #781.
//!
//! A MODAL `dvui.floatingWindow` subwindow over the transcript band listing the
//! product keymap (help labels + chord); rows whose `when` is currently false
//! are greyed (WARM-muted, never EMBER). Being a modal subwindow it:
//!   (a) captures pointer + wheel so scrolling stays in the panel and never moves
//!       the transcript's `state.transcript_scroll` (plan #781 Goal 2),
//!   (b) dims the whole window so a backdrop click-outside closes it (NEW at #781),
//!   (c) sizes to fill most of the band (named fractions — the fixed 460×320 cap
//!       was retired, human-approved 2026-08-22).
//!
//! The list is a two-column table: a fixed-width chord column (mono, with
//! `mixed_text.addTextMixed` for `↑`/`↓`) plus a remaining-width help column, so
//! every chord and every help string starts on a stable x. Every looping widget
//! carries a loop-unique `.id_extra` (distinct bases per widget kind) so dvui
//! never paints duplicate-id red outlines (Goal 1).
//!
//! Pure paint from the static `keymap.KEY_TABLE` — no GPA alloc, no host I/O, no
//! per-frame parsing (frame budget). Open/close state lives in
//! `state.help_overlay_open` (toggled by the keymap dispatcher: Ctrl/Cmd+/ and
//! leader+`?`; Esc closes — wins over busy cancel). The caller paints only while
//! open, so the subwindow deregisters itself when closed.
const std = @import("std");
const dvui = @import("dvui");
const keymap = @import("../keymap.zig");
const palette = @import("../palette.zig");
const metrics = @import("metrics.zig");
const mixed_text = @import("../rich/mixed_text.zig");

/// Chord glyph for each shipped row, derived from the table's key+prereq.
/// `leader` is the prefix itself; `help_toggle_leader` is shown under the
/// leader family (`?`). Help copy comes from the table's `row.help` (the
/// overlay IS the table — keymap.zig owns the strings). Order mirrors KEY_TABLE.
///
/// `pub` so the host unit test (help_overlay.test.zig) can pin the leader
/// chord glyphs — `rowChord` is a hardcoded parallel map (not derived from the
/// table), so without a test a revert to stale "Leader Space" strings would
/// ship while keymap.zig tests stay green (plan #761 Nit L6).
pub fn rowChord(row: keymap.Row) []const u8 {
    return switch (row.action) {
        .submit => "Ctrl/Cmd+Enter",
        .queue_save => "Ctrl/Cmd+Enter",
        .history_older => "↑",
        .history_newer => "↓",
        .cancel_turn => "Esc",
        .cancel_queue_edit => "Esc",
        .help_close => "Esc",
        .help_toggle => "Ctrl/Cmd+/",
        .help_toggle_leader => "Leader I, then ?",
        .leader => "Ctrl+I",
        .leader_cancel => "Esc (leader)",
        .thinking_default_toggle => "Leader I, then t",
    };
}

/// Panel horizontal padding and row-box horizontal padding, shared by the
/// widget `Options.padding` below AND the `help_max_w` wrap-ceiling arithmetic so
/// the two can never drift (review #783 round-3 Nit L8).
const PANEL_PAD_X: f32 = 12;
const ROW_PAD_X: f32 = 4;

/// Is the row's product action currently available in the live context? Used
/// to grey rows whose `when` is false (WARM-muted instead of EMBER).
fn rowActive(row: keymap.Row, ctx: keymap.Context) bool {
    // A row matches when_true (subset) and has no forbidden context hit.
    var in_true = true;
    if (row.when_true.composer and !ctx.composer) in_true = false;
    if (row.when_true.queue_editing and !ctx.queue_editing) in_true = false;
    if (row.when_true.busy and !ctx.busy) in_true = false;
    if (row.when_true.help_open and !ctx.help_open) in_true = false;
    if (row.when_true.leader_pending and !ctx.leader_pending) in_true = false;
    if (row.when_true.prompt_empty and !ctx.prompt_empty) in_true = false;
    if (row.when_true.in_history and !ctx.in_history) in_true = false;
    if (!in_true) return false;
    var forbidden = false;
    if (row.when_false.composer and ctx.composer) forbidden = true;
    if (row.when_false.queue_editing and ctx.queue_editing) forbidden = true;
    if (row.when_false.busy and ctx.busy) forbidden = true;
    if (row.when_false.help_open and ctx.help_open) forbidden = true;
    if (row.when_false.leader_pending and ctx.leader_pending) forbidden = true;
    if (row.when_false.prompt_empty and ctx.prompt_empty) forbidden = true;
    if (row.when_false.in_history and ctx.in_history) forbidden = true;
    return !forbidden;
}

/// After the modal subwindow has consumed the frame, scan for a press/release on
/// the dimmed backdrop (outside the panel). The modal wall routes every click to
/// the subwindow, so no base-window widget is steered; we only ask "was it a
/// backdrop click?" (NEW plan #781 behavior — explicit, tested).
fn backdropPressed(panel_phys: dvui.Rect.Physical) bool {
    if (panel_phys.w <= 0 or panel_phys.h <= 0) return false;
    const evts = dvui.events();
    for (evts) |*e| {
        if (e.handled) continue;
        if (e.evt != .mouse) continue;
        const me = e.evt.mouse;
        if (me.action != .press and me.action != .release) continue;
        if (me.button == .none) continue;
        if (panel_phys.contains(me.p)) continue;
        return true;
    }
    return false;
}

/// Paint the help overlay as a modal in-canvas subwindow over the transcript
/// band. `x,y,w,h` is the band rect (logical), `ctx` the live keymap context for
/// greying. Returns TRUE when a backdrop click-outside this frame should close
/// the overlay (the caller flips the open state). Paints every shipped row (≤
/// KEYMAP_MAX).
pub fn paint(x: f32, y: f32, w: f32, h: f32, ctx: keymap.Context) bool {
    if (w < metrics.HELP_OVERLAY_MIN_W or h < metrics.HELP_OVERLAY_MIN_H) return false;

    // Width-first fill-band size: high fraction of the band, clamped to the band
    // minus margins so nothing overflows horizontally, floored so a ~390 px
    // canvas still gets a usable panel (the floor is clamped away when the band
    // sits near the min gate).
    const panel_w = @min(@max(metrics.HELP_OVERLAY_W_FRACTION * w, metrics.HELP_OVERLAY_FLOOR_W), w - 2 * metrics.HELP_OVERLAY_MARGIN_X);
    const panel_h = @min(@max(metrics.HELP_OVERLAY_H_FRACTION * h, metrics.HELP_OVERLAY_FLOOR_H), h - 2 * metrics.HELP_OVERLAY_MARGIN_Y);
    if (panel_w < 1 or panel_h < 1) return false;
    const px = x + (w - panel_w) / 2;
    const py = y + (h - panel_h) / 2;

    // Remaining-width bound for the help column: the panel interior (minus the
    // panel's horizontal padding 2·12 and the row box's 2·4) less the fixed
    // chord column. Long help strings wrap to this line width instead of
    // clipping on a narrow ~390 band (review #783 Minor L1). When the vertical
    // scrollbar is showing, the row box is allocated the narrower client width
    // and `.expand = .horizontal` wraps to that instead — this value is a safe
    // ceiling, never wider than the panel.
    const help_max_w = panel_w - 2 * PANEL_PAD_X - 2 * ROW_PAD_X - metrics.HELP_OVERLAY_CHORD_COL_W;

    // Scratch rect the floatingWindow reads every frame (`init_options.rect`) so
    // the panel follows the band on a resize (not just on its first frame).
    var rect_store: dvui.Rect = .{ .x = px, .y = py, .w = panel_w, .h = panel_h };
    var fw = dvui.floatingWindow(@src(), .{
        .modal = true,
        .modal_alpha = 170,
        .resize = .none,
        .rect = &rect_store,
    }, .{
        .background = true,
        .color_fill = palette.teal_surface,
        .color_border = palette.teal_accent,
        .border = .all(1),
        .padding = .{ .x = PANEL_PAD_X, .y = 10, .w = PANEL_PAD_X, .h = 10 },
    });

    // The panel is centered and never meant to be dragged. With `.resize =
    // .none`, dvui's default `drag_area` is the FULL panel rect, so an unhandled
    // middle-drag press on a row would translate the panel then snap it back
    // next frame (review #783 Minor L1). Zero the drag area so no press can
    // start a panel drag.
    fw.dragAreaSet(.{});

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .color_text = palette.teal_text,
            .font = .theme(.heading),
        });
        tl.addText("Keyboard shortcuts", .{});
        var muted = dvui.textLayout(@src(), .{}, .{
            .color_text = palette.teal_muted,
        });
        muted.addText("  Esc / click outside closes · grey rows are context-off", .{});
        muted.deinit();
        tl.deinit();
    }

    {
        var scroll_area = dvui.scrollArea(@src(), .{
            .scroll_info = &ctx_scroll,
            .vertical_bar = .auto,
        }, .{
            .expand = .both,
            .color_fill = palette.teal_surface,
            .padding = .all(0),
            .tag = "overlay-scroll-area",
        });
        defer scroll_area.deinit();

        var prev_action: ?keymap.Action = null;
        var row_i: usize = 0;
        for (keymap.KEY_TABLE) |row| {
            // The overlay is the table: two rows (`history_older` and
            // `history_older_in`) share a single action but differ only in `when`
            // context — present each distinct action once (L8). `row_i` (not the
            // raw loop index) is the rendered-row counter, so id_extra stays
            // dense across the de-dupe.
            if (prev_action == row.action) continue;
            prev_action = row.action;

            // Loop-unique ids with distinct bases per widget kind so a box, chord,
            // and help never share an id in the same iteration (duplicate-id red
            // outlines — plan #781 Goal 1).
            const id_row = row_i;
            const id_chord = row_i + keymap.KEYMAP_MAX;
            const id_copy = row_i + 2 * keymap.KEYMAP_MAX;

            const active = rowActive(row, ctx);
            const chord_str = rowChord(row);

            // Tags are per-frame copied by dvui, so a reusable stack buffer per
            // row yields distinct tag strings for the test column-x locks.
            var chord_tag_buf: [48]u8 = undefined;
            var copy_tag_buf: [48]u8 = undefined;
            const chord_tag = std.fmt.bufPrint(&chord_tag_buf, "overlay-chord-{d}", .{row_i}) catch "overlay-chord";
            const copy_tag = std.fmt.bufPrint(&copy_tag_buf, "overlay-help-{d}", .{row_i}) catch "overlay-help";

            var line = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .id_extra = id_row,
                .expand = .horizontal,
                .min_size_content = .{ .w = 40, .h = metrics.TOUCH_H - 6 },
                .padding = .{ .x = ROW_PAD_X, .y = 2, .w = ROW_PAD_X, .h = 2 },
            });
            defer line.deinit();

            var chord = dvui.textLayout(@src(), .{}, .{
                .id_extra = id_chord,
                .tag = chord_tag,
                .color_text = if (active) palette.teal_accent else palette.warm_muted,
                .font = .theme(.mono),
                .gravity_y = 0.5,
                // Fixed chord column width keeps every help string's left edge on
                // a stable x (two-column table, Goal 4).
                .min_size_content = .{ .w = metrics.HELP_OVERLAY_CHORD_COL_W, .h = metrics.TOUCH_H - 6 },
            });
            // addTextMixed routes `↑`/`↓` (Arrows block) to the DejaVu symbols
            // face — Noto + Vera (mono) have no Arrows glyphs (L9, same tofu class
            // as #732). ASCII chords keep the mono face.
            mixed_text.addTextMixed(chord, chord_str, .theme(.mono), .{
                .color_text = if (active) palette.teal_accent else palette.warm_muted,
            });
            chord.deinit();

            var help = dvui.textLayout(@src(), .{}, .{
                .id_extra = id_copy,
                .tag = copy_tag,
                .color_text = if (active) palette.teal_text else palette.warm_muted,
                .gravity_y = 0.5,
                // Wrap the help column to the leftover row width (`expand` lets
                // the row box allocate the remaining width after the fixed chord
                // column; `max_size_content.w` is the ceiling so long copy never
                // clips past the panel at a ~390 band). There is NO height cap:
                // `WidgetData.init`/`minSizeSetAndRefresh` clamps min_size to
                // max_sizeGet(), so a wrapped two-line string under a TOUCH_H-high
                // max would report a clipped one-line min — dropping max.h lets
                // the row grow tall enough to show wrapped lines (review #783
                // round-3 Minor L1+L6).
                .expand = .horizontal,
                .max_size_content = .width(help_max_w),
                .min_size_content = .{ .h = metrics.TOUCH_H - 6 },
            });
            help.addText(row.help, .{});
            help.deinit();

            row_i += 1;
        }
    }

    // Dispatch settles the panel's physical rect before the subwindow deinits.
    const panel_phys = fw.data().rectScale().r;
    fw.deinit();

    // Backdrop click-outside now that every child has had a chance to mark its
    // events handled (subwindow deinit runs processEventsAfter).
    return backdropPressed(panel_phys);
}

// Scroll state for the overlay list (persists across frames while open).
// `pub` so the host wheel test can assert `ctx_scroll.offset(.vertical)` moves.
pub var ctx_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

/// Reset the overlay list back to the top when the overlay closes (both the
/// Esc `help_close` in keymap_dispatch and the backdrop click-outside in ui.zig
/// call this), so a reopen resumes at the top rather than mid-table
/// (review #783 Nit L1). Re-initializing the ScrollInfo also drops any
/// stale viewport/offset from the previous open.
pub fn resetScroll() void {
    ctx_scroll = .{ .vertical = .auto, .horizontal = .none };
}
