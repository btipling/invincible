//! Host unit tests for `busy_spinner.zig` (pure LUT — no dvui frame, runs in
//! `build.zig` `test-rich` on the self-hosted runner).
//!
//! Cells are indexed row-major: `i = row * COLS + col`. Intensity 0 = head,
//! 1/2 = trailing dims, 3 = resting/surface.

const std = @import("std");
const t = std.testing;
const bs = @import("busy_spinner.zig");

const COLS = bs.COLS;
const ROWS = bs.ROWS;

fn idx(col: usize, row: usize) usize {
    return row * COLS + col;
}

test "8 phases wrap and each phase lights exactly one head cell" {
    var phase: u8 = 0;
    while (phase < 8) : (phase += 1) {
        const cells = bs.busySpinnerCells(phase);
        var heads: usize = 0;
        for (cells) |c| {
            if (c == 0) heads += 1;
        }
        try t.expectEqual(@as(usize, 1), heads);
    }
}

test "phase 0: head at top-left (0,0); tail from the phase-7 wrap is still fading" {
    // Phase 8 == phase 0 (cycle wrap): the head returns to top-left and the
    // previous cycle's tail (phase 7's head + 2 dims, which lived in column 1)
    // is still visibly fading — mirrors the plan's "Phase 8 wraps → 0" row:
    // trail-1 (1,3), trail-2 (1,2), trail-3 (1,1) = surface/resting.
    const cells = bs.busySpinnerCells(0);
    try t.expectEqual(@as(u3, 0), cells[idx(0, 0)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(1, 3)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(1, 2)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(1, 1)]); // trail-3
    // Column 0 (besides the head) and the leftover (1,0) are resting.
    try t.expectEqual(@as(u3, 3), cells[idx(0, 1)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 3)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 0)]);
}

test "column-wave head descends column 0 then column 1" {
    // Head positions per phase (traversal of column 0 top→bottom, then column 1).
    const expect_head = [8]struct { col: usize, row: usize }{
        .{ .col = 0, .row = 0 },
        .{ .col = 0, .row = 1 },
        .{ .col = 0, .row = 2 },
        .{ .col = 0, .row = 3 },
        .{ .col = 1, .row = 0 },
        .{ .col = 1, .row = 1 },
        .{ .col = 1, .row = 2 },
        .{ .col = 1, .row = 3 },
    };
    var phase: u8 = 0;
    while (phase < 8) : (phase += 1) {
        const cells = bs.busySpinnerCells(phase);
        const expect = expect_head[phase];
        try t.expectEqual(@as(u3, 0), cells[idx(expect.col, expect.row)]);
    }
}

test "phase 3: bottom-left is head, three-cell trail above it" {
    const cells = bs.busySpinnerCells(3);
    try t.expectEqual(@as(u3, 0), cells[idx(0, 3)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(0, 2)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(0, 1)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(0, 0)]); // trail-3 (resting level)
    try t.expectEqual(@as(u3, 3), cells[idx(1, 0)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 1)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 3)]);
}

test "phase 5: head second column row 1; trailing wave wraps through column 0 bottom" {
    const cells = bs.busySpinnerCells(5);
    try t.expectEqual(@as(u3, 0), cells[idx(1, 1)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(1, 0)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(0, 3)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(0, 2)]); // trail-3
    try t.expectEqual(@as(u3, 3), cells[idx(0, 0)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 1)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 3)]);
}

test "phase wraps: phase 8 == phase 0, phase 255 == phase 7" {
    const c0 = bs.busySpinnerCells(0);
    const c8 = bs.busySpinnerCells(8);
    try t.expectEqualSlices(u3, c0[0..], c8[0..]);

    const c7 = bs.busySpinnerCells(7);
    const c255 = bs.busySpinnerCells(255);
    try t.expectEqualSlices(u3, c7[0..], c255[0..]);
    // Head at bottom-right on phase 7.
    try t.expectEqual(@as(u3, 0), c7[idx(1, 3)]);
}
