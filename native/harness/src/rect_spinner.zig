//! Generic reusable 2×4 rectangle spinner. Callers pass a palette ramp, a tag
//! prefix, and an id_extra base — no dependency on busy row / waiting copy /
//! bridge. Two instances on one frame do not collide as long as they use
//! different `tag_prefix` values **and** `id_extra` bases spaced at least
//! `ID_SPAN` apart (see `ID_SPAN` below). A shared `src` (two calls to
//! `paint` from the same call site, e.g. a future caller painting two
//! spinners) is disambiguated only by `id_extra`, so bases closer than
//! `ID_SPAN` alias each other's row/cell boxes.
//!
//! Named ramps: WARM_RAMP (busy row) and TEAL_RAMP (future chrome). No EMBER.
//!
//! Geometry: 4×4 px cells, 2 px sibling gaps, 1.5 px corner radius → inner
//! 10×22 grid, centered by equal pad (1.5 / 3.5) inside a reserved 13×29
//! slot. `W`/`H` **are** that slot, not products of `CELL`/`GAP`. Margin
//! between the slot and the next element is caller-controlled via
//! `Options.margin_right` (default 10 px, matching the original busy-row TRAIL).
//!
//! The pulse travels **clockwise**: left column **bottom→top**, then right
//! column **top→bottom**, over 8 phases. The LUT lives in `busy_spinner.zig`
//! (pure logic, no dvui dependency); this module is paint-only.

const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const busy_spinner = @import("busy_spinner.zig");

/// 2×4 grid (row-major) — matches `busy_spinner.zig` COLS/ROWS.
pub const COLS: usize = busy_spinner.COLS;
pub const ROWS: usize = busy_spinner.ROWS;
/// Cell edge (px).
pub const CELL: f32 = 4;
/// Padding gap between cells (px) — sibling-only spacing.
pub const GAP: f32 = 2;
/// Cell corner radius (px).
pub const RADIUS: f32 = 1.5;
/// Inner grid footprint (px) — 2×4+2 = 10 wide, 4×4+3×2 = 22 tall.
pub const INNER_W: f32 = @as(f32, @floatFromInt(COLS)) * CELL + @as(f32, @floatFromInt(COLS - 1)) * GAP;
pub const INNER_H: f32 = @as(f32, @floatFromInt(ROWS)) * CELL + @as(f32, @floatFromInt(ROWS - 1)) * GAP;
/// Reserved outer slot (px), independent of `CELL`/`GAP`. Leftover is pad.
pub const W: f32 = 13;
pub const H: f32 = 29;
/// Equal inset that centers the inner grid in the slot.
pub const PAD_X: f32 = (W - INNER_W) / 2.0;
pub const PAD_Y: f32 = (H - INNER_H) / 2.0;
/// Span of the `id_extra` namespace this spinner consumes: the base (outer
/// box), rows `base+0x10..0x13`, cells `base+0x20..0x27`. Two spinners sharing
/// one `src` must use `id_extra` bases spaced **at least this many apart** so
/// no row/cell id aliases another instance's tree. Same for any other dvui
/// widget drawing into the same id domain.
pub const ID_SPAN: usize = 0x28;

/// 4-step ramp: [head, trail1, trail2, rest] → dvui.Color per LUT step.
pub const ColorRamp = [4]dvui.Color;

/// WARM ramp — busy-row spinner (warm_accent → warm_muted → warm_border → warm_surface).
pub const WARM_RAMP: ColorRamp = .{ palette.warm_accent, palette.warm_muted, palette.warm_border, palette.warm_surface };

/// TEAL ramp — future chrome spinner (teal_accent → teal_muted → teal_border → teal_surface).
pub const TEAL_RAMP: ColorRamp = .{ palette.teal_accent, palette.teal_muted, palette.teal_border, palette.teal_surface };

pub const Options = struct {
    /// Current tick phase (0..7, wraps internally).
    phase: u8,
    /// 4-step palette ramp picked by the caller.
    ramp: ColorRamp,
    /// Tag namespace prefix (e.g. "busy-spinner"). The outer box gets
    /// `{tag_prefix}`; each cell gets `{tag_prefix}-cell-{row}-{col}`.
    tag_prefix: []const u8,
    /// Base id for inner box id_extra values. When a caller paints more than
    /// one spinner from the same call site (shared `src`), it must space the
    /// `id_extra` bases at least `ID_SPAN` apart so no row/cell box aliases
    /// another spinner's tree. Different `tag_prefix` values keep tags
    /// disjoint but do **not** fix id aliasing.
    id_extra: usize,
    /// Right margin on the outer box (px), applied before the next element.
    /// Default 10 px matches the busy-row TRAIL.
    margin_right: f32 = 10,
};

/// Paint the 2×4 spinner from the current tick phase. Pure paint — no I/O /
/// alloc in the frame path; cell color is a LUT lookup only. `dvui.tag` names
/// are registered once into the window tag map and updated in place; they are
/// how the host layout test reads the resulting rects. Inner boxes use the
/// caller's `id_extra` namespace (+0x10 row offset, +0x20 cell offset,
/// consuming `ID_SPAN` = 0x28 in total). Two callers sharing a `src` must
/// space their `id_extra` bases at least `ID_SPAN` apart, or the row/cell
/// boxes alias each other's ids.
pub fn paint(src: std.builtin.SourceLocation, opts: Options) void {
    const cells = busy_spinner.busySpinnerCells(opts.phase);
    var out = dvui.box(src, .{ .dir = .vertical }, .{
        .gravity_y = 0.5,
        // padSize(INNER) + PAD + TRAIL margin → tagged slot stays W×H.
        // Do not bake+null padding (TextEntry-only); contentRect insets PAD.
        .min_size_content = .{ .w = INNER_W, .h = INNER_H },
        .padding = .{ .x = PAD_X, .y = PAD_Y, .w = PAD_X, .h = PAD_Y },
        .margin = .{ .x = 0, .y = 0, .w = opts.margin_right, .h = 0 },
        .tag = opts.tag_prefix,
        .id_extra = opts.id_extra,
    });
    defer out.deinit();
    var row: usize = 0;
    while (row < ROWS) : (row += 1) {
        // Sibling-only vertical gap: each row box after the first gets a top
        // margin of GAP, so 4×4 + 3×2 = 22 inner tall (pad fills the 29 slot).
        var rb = dvui.box(src, .{ .dir = .horizontal }, .{
            .margin = .{ .x = 0, .y = if (row == 0) 0 else GAP, .w = 0, .h = 0 },
            .id_extra = opts.id_extra + 0x10 + row,
        });
        defer rb.deinit();
        var col: usize = 0;
        while (col < COLS) : (col += 1) {
            const step = cells[row * COLS + col];
            var cell_tag_buf: [64]u8 = undefined;
            const cell_tag = std.fmt.bufPrint(&cell_tag_buf, "{s}-cell-{d}-{d}", .{ opts.tag_prefix, row, col }) catch unreachable;
            // Sibling-only horizontal gap: leading cell (col>0) adds a left
            // margin of GAP, so each row is 2×4 + 2 = 10 inner wide.
            var cell = dvui.box(src, .{}, .{
                .background = true,
                .color_fill = opts.ramp[@intCast(step)],
                .corners = .round(RADIUS),
                .min_size_content = .{ .w = CELL, .h = CELL },
                .margin = .{ .x = if (col == 0) 0 else GAP, .y = 0, .w = 0, .h = 0 },
                .tag = cell_tag,
                .id_extra = opts.id_extra + 0x20 + row * COLS + col,
            });
            defer cell.deinit();
        }
    }
}
