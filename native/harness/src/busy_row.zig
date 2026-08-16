//! Busy-row chrome — the 2×4 WARM spinner (plan #574, extracted to
//! `rect_spinner.zig` in #607) + "Waiting for model…" + optional v14
//! ` · mm:ss` clock, painted as nested dvui boxes + a text layout sharing one
//! horizontal row container.
//!
//! Standalone on purpose (no `ui.zig` / `bridge` / wasm-web glue) so the host
//! dvui **testing-backend** test `busy_row_layout.test.zig` can run the exact
//! same paint the harness emits and assert the locked geometry off real layout
//! rects (PR #576 Blocker L6). `ui.zig` calls `paintBusyRow` in its busy branch;
//! the 10 Hz phase scalar and the wall-clock seconds are passed in, not read
//! from a global, so no bridge/wasm dependency lives here.
//!
//! Geometry locked by plan #574: 5×5 px cells, 3 px sibling gaps, 2 px corner
//! radius → 13×29 grid, 10 px right margin before the text (TRAIL). Gaps are
//! SIBLING-ONLY (see `rect_spinner.zig`); the layout tests lock this: cell 5×5,
//! exact 3 px gaps, outer rect 13×29.
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
const elapsed_clock = @import("elapsed_clock.zig");

/// Re-export geometry constants from `rect_spinner.zig` for backward compat
/// with `busy_row_layout.test.zig`.
pub const COLS = rect_spinner.COLS;
pub const ROWS = rect_spinner.ROWS;
pub const CELL = rect_spinner.CELL;
pub const GAP = rect_spinner.GAP;
pub const RADIUS = rect_spinner.RADIUS;
pub const W = rect_spinner.W;
pub const H = rect_spinner.H;
/// Right margin before the busy text — inline spacing like the kind-label rows.
pub const TRAIL: f32 = 10;

// id namespace for the busy row inner boxes — never aliases message-loop rows
// (which use their own high ids) or the busy textLayout (`0xffff_ffff`).
const SPINNER_ID = 0x60_00a0;
const ROW_CONTAINER_ID = 0x60_0000;
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
    rect_spinner.paint(src, .{
        .phase = phase,
        .ramp = rect_spinner.WARM_RAMP,
        .tag_prefix = "busy-spinner",
        .id_extra = SPINNER_ID,
    });
    {
        var tl = dvui.textLayout(src, .{}, .{
            .expand = .horizontal,
            .background = false,
            .color_text = palette.warm_accent,
            .gravity_y = 0.5,
            .tag = "busy-waiting-text",
            .id_extra = TEXT_ID,
        });
        tl.addText("Waiting for model…", .{});
        // Protocol v14 — whole-turn clock: append ` · mm:ss` only while > 0 so
        // no bare `0:00` lingers at t=0. The host resets to 0 on idle/stop/
        // error/clear. Reduced motion keeps this clock (plan #574 Major).
        if (turn_elapsed > 0) {
            var clock_buf: [32]u8 = undefined;
            const clock = elapsed_clock.formatElapsedClock(&clock_buf, turn_elapsed);
            tl.addText(" · ", .{});
            tl.addText(clock, .{});
        }
        tl.deinit();
    }
}
