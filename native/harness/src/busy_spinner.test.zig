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

test "phase 0: head at bottom-left (0,3); previous-cycle tail fades up the right column" {
    // Phase 8 == phase 0 (cycle wrap): the head returns to bottom-left and the
    // previous cycle's tail (phase 7's head at bottom-right + dims above it)
    // is still visibly fading.
    const cells = bs.busySpinnerCells(0);
    try t.expectEqual(@as(u3, 0), cells[idx(0, 3)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(1, 3)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(1, 2)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(1, 1)]); // trail-3
    try t.expectEqual(@as(u3, 3), cells[idx(0, 0)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 1)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 0)]);
}

test "clockwise head: left column bottom→top, then right column top→bottom" {
    const expect_head = [8]struct { col: usize, row: usize }{
        .{ .col = 0, .row = 3 },
        .{ .col = 0, .row = 2 },
        .{ .col = 0, .row = 1 },
        .{ .col = 0, .row = 0 },
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

test "phase 3: top-left is head, three-cell trail down the left column" {
    const cells = bs.busySpinnerCells(3);
    try t.expectEqual(@as(u3, 0), cells[idx(0, 0)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(0, 1)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(0, 2)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(0, 3)]); // trail-3
    try t.expectEqual(@as(u3, 3), cells[idx(1, 0)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 1)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(1, 3)]);
}

test "phase 5: head second column row 1; trail wraps through top-right then top-left" {
    const cells = bs.busySpinnerCells(5);
    try t.expectEqual(@as(u3, 0), cells[idx(1, 1)]); // head
    try t.expectEqual(@as(u3, 1), cells[idx(1, 0)]); // trail-1
    try t.expectEqual(@as(u3, 2), cells[idx(0, 0)]); // trail-2
    try t.expectEqual(@as(u3, 3), cells[idx(0, 1)]); // trail-3
    try t.expectEqual(@as(u3, 3), cells[idx(0, 2)]);
    try t.expectEqual(@as(u3, 3), cells[idx(0, 3)]);
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

test "phase wraps: phase 256 == phase 0 (plan #674 Goal 3 — continuity across old fold)" {
    const c0 = bs.busySpinnerCells(0);
    const c256 = bs.busySpinnerCells(256);
    try t.expectEqualSlices(u3, c0[0..], c256[0..]);
    // Head at bottom-left (phase 0 / 8 / 256).
    try t.expectEqual(@as(u3, 0), c256[idx(0, 3)]);
}
