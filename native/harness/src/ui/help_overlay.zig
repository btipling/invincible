//! In-canvas help overlay — plan #741.
//!
//! A TEAL absolute-rect panel over the transcript band listing the product
//! keymap (help labels + chord); rows whose `when` is currently false are
//! greyed (WARM-muted, not EMBER). Pure paint from the static `keymap.KEY_TABLE`
//! — no GPA alloc, no host I/O, no per-frame parsing (frame budget).
//!
//! Open/close state lives in `state.help_overlay_open` (toggled by the keymap
//! dispatcher: Ctrl/Cmd+/ and leader+`?`; Esc closes — wins over busy cancel).
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

/// Paint the help overlay over the transcript band. `x,y,w,h` is the transcript
/// band rect (the overlay centers within it), `ctx` the live keymap context for
/// greying. Paints every shipped row (≤ KEYMAP_MAX).
pub fn paint(x: f32, y: f32, w: f32, h: f32, ctx: keymap.Context) void {
    if (w < metrics.HELP_OVERLAY_MIN_W or h < metrics.HELP_OVERLAY_MIN_H) return;

    const panel_w = @min(metrics.HELP_OVERLAY_W, w - 2 * metrics.HELP_OVERLAY_MARGIN_X);
    const panel_h = @min(metrics.HELP_OVERLAY_H, h - 2 * metrics.HELP_OVERLAY_MARGIN_Y);
    if (panel_w < 1 or panel_h < 1) return;
    const px = x + (w - panel_w) / 2;
    const py = y + (h - panel_h) / 2;

    var panel = dvui.box(@src(), .{ .dir = .vertical }, .{
        .rect = .{ .x = px, .y = py, .w = panel_w, .h = panel_h },
        .background = true,
        .color_fill = palette.teal_surface,
        .color_border = palette.teal_accent,
        .border = .all(1),
        .padding = .{ .x = 12, .y = 10, .w = 12, .h = 10 },
    });
    defer panel.deinit();

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .color_text = palette.teal_text,
            .font = .theme(.heading),
        });
        tl.addText("Keyboard shortcuts", .{});
        var muted = dvui.textLayout(@src(), .{}, .{
            .color_text = palette.teal_muted,
        });
        muted.addText("  Esc closes · grey rows are context-off", .{});
        muted.deinit();
        tl.deinit();
    }

    var scroll_area = dvui.scrollArea(@src(), .{
        .scroll_info = &ctx_scroll,
        .vertical_bar = .auto,
    }, .{
        .expand = .both,
        .color_fill = palette.teal_surface,
        .padding = .all(0),
    });
    defer scroll_area.deinit();

    var prev_action: ?keymap.Action = null;
    for (keymap.KEY_TABLE) |row| {
        // The overlay is the table: two rows (`history_older` and
        // `history_older_in`) share a single action but differ only in `when`
        // context — present each distinct action once (L8).
        if (prev_action == row.action) continue;
        prev_action = row.action;

        const active = rowActive(row, ctx);
        const chord_str = rowChord(row);
        var line = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 40, .h = metrics.TOUCH_H - 6 },
            .padding = .{ .x = 4, .y = 2, .w = 4, .h = 2 },
        });
        defer line.deinit();

        var chord = dvui.textLayout(@src(), .{}, .{
            .color_text = if (active) palette.teal_accent else palette.warm_muted,
            .font = .theme(.mono),
            .gravity_y = 0.5,
        });
        // addTextMixed routes `↑`/`↓` (Arrows block) to the DejaVu symbols
        // face — Noto + Vera (mono) have no Arrows glyphs (L9, same tofu class
        // as #732). ASCII chords keep the mono face.
        mixed_text.addTextMixed(chord, chord_str, .theme(.mono), .{
            .color_text = if (active) palette.teal_accent else palette.warm_muted,
        });
        chord.deinit();

        var help = dvui.textLayout(@src(), .{}, .{
            .color_text = if (active) palette.teal_text else palette.warm_muted,
            .gravity_y = 0.5,
        });
        help.addText(row.help, .{});
        help.deinit();
    }
}

// Scroll state for the overlay list (persists across frames while open).
var ctx_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};
