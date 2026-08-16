//! Busy-row chrome — the 2×4 WARM spinner (plan #574) + "Waiting for model…"
//! + optional v14 ` · mm:ss` clock, painted as nested dvui boxes + a text
//! layout sharing one horizontal row container.
//!
//! Standalone on purpose (no `ui.zig` / `bridge` / wasm-web glue) so the host
//! dvui **testing-backend** test `busy_row_layout.test.zig` can run the exact
//! same paint the harness emits and assert the locked geometry off real layout
//! rects (PR #576 Blocker L6). `ui.zig` calls `paintBusyRow` in its busy branch;
//! the 10 Hz phase scalar and the wall-clock seconds are passed in, not read
//! from a global, so no bridge/wasm dependency lives here.
//!
//! Geometry locked by plan #574: 5×5 px cells, 3 px sibling gaps, 2 px corner
//! radius → 13×29 grid, 10 px right margin before the text (BUSY_SPINNER_TRAIL).
//! Gaps are SIBLING-ONLY: vertical gaps come from each row box's top margin
//! (rows after the first), horizontal gaps from each leading cell's left margin
//! (cols after the first). We never apply `col*GAP` / `row*GAP` on top of the
//! stacked box tree, which double-applies and inflates the footprint past 13×29
//! (PR #576 Major L1+L9). The layout tests lock this: cell 5×5, exact 3 px gaps,
//! outer rect 13×29.
//!
//! Vertical placement uses `gravity_y = 0.5` on the outer spinner box and the
//! busy text (the house convention for inline chrome — status chips, kind
//! labels). Exact dvui baseline-bottom anchoring of a 29 px grid would push the
//! grid's top above the text line and is tracked as the PR's open alignment
//! decision pending operator smoke (#576 living comment #1, options A/B/C).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const busy_spinner = @import("busy_spinner.zig");
const elapsed_clock = @import("elapsed_clock.zig");

/// 2×4 grid (row-major) — matches `busy_spinner.zig` COLS/ROWS.
pub const COLS: usize = busy_spinner.COLS;
pub const ROWS: usize = busy_spinner.ROWS;
/// Cell edge (px).
pub const CELL: f32 = 5;
/// Padding gap between cells (px) — sibling-only spacing.
pub const GAP: f32 = 3;
/// Cell corner radius (px).
pub const RADIUS: f32 = 2;
/// Grid overall footprint (px) — 2×5+3 = 13 wide, 4×5+3×3 = 29 tall.
pub const W: f32 = @as(f32, @floatFromInt(COLS)) * CELL + @as(f32, @floatFromInt(COLS - 1)) * GAP;
pub const H: f32 = @as(f32, @floatFromInt(ROWS)) * CELL + @as(f32, @floatFromInt(ROWS - 1)) * GAP;
/// Right margin before the busy text — inline spacing like the kind-label rows.
pub const TRAIL: f32 = 10;

// id namespace for the busy row inner boxes — never aliases message-loop rows
// (which use their own high ids) or the busy textLayout (`0xffff_ffff`).
const SPINNER_ID = 0x60_00a0;
const ROW_ID_BASE = 0x60_00b0;
const CELL_ID_BASE = 0x60_00c0;
const ROW_CONTAINER_ID = 0x60_0000;
const TEXT_ID = 0xffff_ffff;

/// Map a LUT step (0=head .. 3=surface) to its WARM palette token. No freehand
/// hex; monotone WARM keeps the spinner unified with the warm waiting text.
fn busySpinnerColor(step: u3) dvui.Color {
    return switch (step) {
        0 => palette.warm_accent,
        1 => palette.warm_muted,
        2 => palette.warm_border,
        else => palette.warm_surface,
    };
}

/// Paint the 2×4 WARM spinner from the current busy-tick phase. Pure paint — no
/// I/O / alloc in the frame path; cell color is a LUT lookup only. `dvui.tag`
/// names are registered once into the window tag map and updated in place; they
/// are how the host layout test reads the resulting rects. Inner boxes use the
/// dedicated `0x60_…` id namespace so they never alias other chrome.
fn paintBusySpinner(src: std.builtin.SourceLocation, phase: u8) void {
    const cells = busy_spinner.busySpinnerCells(phase);
    var out = dvui.box(src, .{ .dir = .vertical }, .{
        .gravity_y = 0.5,
        .min_size_content = .{ .w = W, .h = H },
        .margin = .{ .x = 0, .y = 0, .w = TRAIL, .h = 0 },
        .tag = "busy-spinner",
        .id_extra = SPINNER_ID,
    });
    defer out.deinit();
    var row: usize = 0;
    while (row < ROWS) : (row += 1) {
        // Sibling-only vertical gap: each row box after the first gets a top
        // margin of GAP, so 4×5 + 3×3 = 29 total.
        var rb = dvui.box(src, .{ .dir = .horizontal }, .{
            .margin = .{ .x = 0, .y = if (row == 0) 0 else GAP, .w = 0, .h = 0 },
            .id_extra = ROW_ID_BASE + row,
        });
        defer rb.deinit();
        var col: usize = 0;
        while (col < COLS) : (col += 1) {
            const step = cells[row * COLS + col];
            var cell_tag_buf: [64]u8 = undefined;
            const cell_tag = std.fmt.bufPrint(&cell_tag_buf, "busy-spinner-cell-{d}-{d}", .{ row, col }) catch unreachable;
            // Sibling-only horizontal gap: leading cell (col>0) adds a left
            // margin of GAP, so each row is 2×5 + 3 = 13 wide — never col*GAP.
            var cell = dvui.box(src, .{}, .{
                .background = true,
                .color_fill = busySpinnerColor(step),
                .corners = .round(RADIUS),
                .min_size_content = .{ .w = CELL, .h = CELL },
                .margin = .{ .x = if (col == 0) 0 else GAP, .y = 0, .w = 0, .h = 0 },
                .tag = cell_tag,
                .id_extra = CELL_ID_BASE + row * COLS + col,
            });
            defer cell.deinit();
        }
    }
}

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
    paintBusySpinner(src, phase);
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
