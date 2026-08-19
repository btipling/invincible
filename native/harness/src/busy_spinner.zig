//! 2×4 WARM busy spinner (plan #574) — pure layout/logic only; no dvui frame
//! dependency so it runs under `zig build test-rich` on the self-hosted runner.
//!
//! The pulse travels **clockwise**: left column **bottom→top**, then right
//! column **top→bottom**, over 8 phases → ~0.8 s cycle at the host's 10 Hz
//! busy tick (`HARNESS_BUSY_TICK_HZ`, protocol v14 addendum `inv_set_busy_tick`).
//!
//! `busySpinnerCells` returns a compile-time-style `[8]u3` intensity ramp —
//! 0 = head (brightest) · 1/2 = fading trail · 3 = resting/surface. Paint maps
//! each step to a WARM palette token (accent → muted → border → surface).

const std = @import("std");

pub const COLS: usize = 2;
pub const ROWS: usize = 4;
pub const CELL_COUNT: usize = COLS * ROWS;

const CYCLE: usize = 8;

/// Where a cell sits in the traversal ("head at phase p = the cell whose order
/// is p"): column 0 takes order 0..3 **bottom→top**, column 1 takes order 4..7
/// **top→bottom** (clockwise loop).
pub fn cellTraversalOrder(col: usize, row: usize) usize {
    if (col == 0) return (ROWS - 1) - row;
    return ROWS + row;
}

/// Cell intensity steps for a given phase (natural wrap, mod 8).
/// `out[i]` is row-major (`i = row * COLS + col`).
pub fn busySpinnerCells(phase: u32) [CELL_COUNT]u3 {
    const head_order: usize = @intCast(@mod(@as(usize, phase), CYCLE));
    var out: [CELL_COUNT]u3 = undefined;
    var i: usize = 0;
    while (i < CELL_COUNT) : (i += 1) {
        const col = i % COLS;
        const row = i / COLS;
        const cell_order = cellTraversalOrder(col, row);
        // Cyclic distance the head has advanced past this cell: 0 = cell is the
        // head right now; 1/2 = trailing cells; >= 3 = resting/surface.
        const dist: usize = (head_order + CYCLE - cell_order) % CYCLE;
        out[i] = @intCast(@min(dist, 3));
    }
    return out;
}
