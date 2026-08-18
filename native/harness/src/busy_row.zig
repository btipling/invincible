//! Busy-row chrome — the 2×4 WARM spinner (plan #574, extracted to
//! `rect_spinner.zig` in #607) + text-wave "Waiting for model…" (plan #655,
//! extracted to `text_wave.zig`) + optional v14 ` · mm:ss` clock, painted as
//! nested dvui boxes + two text layouts sharing one horizontal row container.
//!
//! Standalone on purpose (no `ui.zig` / `bridge` / wasm-web glue) so the host
//! dvui **testing-backend** test `busy_row_layout.test.zig` can run the exact
//! same paint the harness emits and assert the locked geometry off real layout
//! rects (PR #576 Blocker L6). `ui.zig` calls `paintBusyRow` in its busy branch;
//! the 10 Hz phase scalar and the wall-clock seconds are passed in, not read
//! from a global, so no bridge/wasm dependency lives here.
//!
//! Geometry: 4×4 px cells, 2 px sibling gaps, 1.5 px corner radius → inner
//! 10×22 grid, centered by equal pad (1.5 / 3.5) inside a reserved 13×29
//! slot. `W`/`H` are that slot (not recomputed from `CELL`/`GAP`). 8 px
//! left inset (`LEAD`) via a wrapper box with left margin, 6 px right margin
//! before the text (`TRAIL`). Gaps are SIBLING-ONLY (see `rect_spinner.zig`);
//! the layout tests lock inner sizes, the pad inset on all four sides, the
//! LEAD+TRAIL insets, and the unchanged 13×29 slot.
//!
//! Vertical placement uses `gravity_y = 0.5` on the outer spinner box and the
//! busy text (the house convention for inline chrome — status chips, kind
//! labels). Exact dvui baseline-bottom anchoring of a 29 px grid would push the
//! grid's top above the text line and is tracked as the PR's open alignment
//! decision pending operator smoke (#576 living comment #1, options A/B/C).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const rect_spinner = @import("rect_spinner.zig");
const text_wave = @import("text_wave.zig");
const elapsed_clock = @import("elapsed_clock.zig");

/// Re-export geometry constants from `rect_spinner.zig` for backward compat
/// with `busy_row_layout.test.zig`.
pub const COLS = rect_spinner.COLS;
pub const ROWS = rect_spinner.ROWS;
pub const CELL = rect_spinner.CELL;
pub const GAP = rect_spinner.GAP;
pub const RADIUS = rect_spinner.RADIUS;
pub const INNER_W = rect_spinner.INNER_W;
pub const INNER_H = rect_spinner.INNER_H;
pub const W = rect_spinner.W;
pub const H = rect_spinner.H;
pub const PAD_X = rect_spinner.PAD_X;
pub const PAD_Y = rect_spinner.PAD_Y;
/// Left inset from the bar's left edge before the spinner+text pack. Applied
/// via a wrapper box with left margin — dvui has no CSS-padding, so margin on
/// a wrapper is the standard way to indent child content within a horizontal row.
pub const LEAD: f32 = 8;
/// Right margin before the busy text — inline spacing like the kind-label rows.
pub const TRAIL: f32 = 6;

// id namespace for the busy row inner boxes — never aliases message-loop rows
// (which use their own high ids) or the busy textLayout (`0xffff_ffff`).
const LEAD_WRAPPER_ID = 0x60_0050;
const SPINNER_ID = 0x60_00a0;
const ROW_CONTAINER_ID = 0x60_0000;
const TEXT_WAVE_ID = 0x60_0100;
const TEXT_ID = 0xffff_ffff;

/// Paint the whole busy row (spinner + "Waiting for model…" + optional v14
/// clock) inside one horizontal container. This is what `ui.zig` emits in its
/// busy branch and what the host layout test runs under the dvui testing backend.
pub fn paintBusyRow(phase: u8, turn_elapsed: u32) void {
    const src = @src();
    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .background = true,
        .color_fill = palette.teal_bg,
        .tag = "busy-row",
        .id_extra = ROW_CONTAINER_ID,
    });
    defer row.deinit();
    // LEAD inset: wrap the spinner+text in a horizontal box with left margin.
    // dvui has no CSS-padding — margin on a wrapper box is the standard indent.
    var lead_wrapper = dvui.box(src, .{ .dir = .horizontal }, .{
        .margin = .{ .x = LEAD, .y = 0, .w = 0, .h = 0 },
        .background = false,
        .tag = "busy-row-lead",
        .id_extra = LEAD_WRAPPER_ID,
    });
    defer lead_wrapper.deinit();
    rect_spinner.paint(src, .{
        .phase = phase,
        .ramp = rect_spinner.WARM_RAMP,
        .tag_prefix = "busy-spinner",
        .id_extra = SPINNER_ID,
        .margin_right = TRAIL,
    });
    text_wave.paint(src, .{
        .text = "Waiting for model…",
        .phase = phase,
        .ramp = rect_spinner.WARM_RAMP,
        .tag = "busy-waiting-text",
        .id_extra = TEXT_WAVE_ID,
    });
    // Protocol v14 — whole-turn clock: paint ` · mm:ss` only while > 0 so
    // no bare `0:00` lingers at t=0. Skip the textLayout entirely at t=0
    // (no ghost padded box between the wave and nothing). The host resets
    // to 0 on idle/stop/error/clear. Reduced motion keeps this clock
    // (plan #574 Major).
    if (turn_elapsed > 0) {
        var tl = dvui.textLayout(src, .{}, .{
            .expand = .horizontal,
            .background = false,
            .color_text = palette.warm_accent,
            .gravity_y = 0.5,
            .padding = dvui.Rect.all(0),
            .tag = "busy-clock-text",
            .id_extra = TEXT_ID,
        });
        defer tl.deinit();
        var clock_buf: [32]u8 = undefined;
        const clock = elapsed_clock.formatElapsedClock(&clock_buf, turn_elapsed);
        tl.addText(" · ", .{});
        tl.addText(clock, .{});
    }
}
