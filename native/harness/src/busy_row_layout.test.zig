//! Host dvui testing-backend layout-rect tests for `busy_row.zig` (PR #576
//! Blocker L6 — plan #574 2×4 WARM spinner geometry guard). Asserts the locked
//! spinner geometry from real dvui layout rects, not just constant arithmetic.
//!
//! No pixels, no SDL/GLFW/OpenGL. The dvui testing backend computes layout
//! (x/y/w/h rects) but drawClippedTriangles is a no-op. **Two frames** are
//! needed because auto-sized horizontal boxes start at 0×0 on frame 1 before
//! children report their sizes upward in deinit/minSizeSetAndRefresh; the
//! second frame picks up the settled layout.
//!
//! The testing backend uses a **2× physical pixel scale** by default
//! (window_size 600×400 → size_pixels 1200×800). All assertions use physical
//! pixels with `PX = 2`.
//!
//! dvui tag rects **include the widget's margin**. So cell (row,1) has
//! margin.x=GAP inside its rect → rect.w = CELL + GAP. The spinner outer box
//! has margin.w=TRAIL inside its rect → rect.w = W + TRAIL. Gap assertions
//! measure rect-to-rect boundaries, not content-to-content visual gaps.
//!
//! TextLayout heights are non-zero when the host build includes freetype
//! rasterization (which the host-target testing build does). Vertical-
//! alignment tests assert h>0 so the midpoint measurement is real, not a
//! fail-open no-op (adversarial-review Minor L6).

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const busy_row = @import("busy_row.zig");

/// Gap tolerance for floating-point position assertions (sub-pixel rounding).
const EPS: f32 = 1.0;
/// Physical pixel scale: testing-backend init defaults to 2×.
const PX: f32 = 2;

/// Run TWO frames painting only the busy row and return the tag rects from the
/// SECOND frame. See file-level doc for the two-frame rationale.
fn paintAndGetRects() struct {
    row: dvui.Rect.Physical,
    spinner: dvui.Rect.Physical,
    cells: [busy_row.ROWS][busy_row.COLS]dvui.Rect.Physical,
    text: dvui.Rect.Physical,
} {
    const frame = struct {
        fn paint() !dvui.App.Result {
            busy_row.paintBusyRow(0, 0);
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const row_rect = (dvui.tagGet("busy-row") orelse @panic("tag 'busy-row' not found")).rect;
    const spinner = (dvui.tagGet("busy-spinner") orelse @panic("tag 'busy-spinner' not found")).rect;
    const text = (dvui.tagGet("busy-waiting-text") orelse @panic("tag 'busy-waiting-text' not found")).rect;

    var cells: [busy_row.ROWS][busy_row.COLS]dvui.Rect.Physical = undefined;
    var r: usize = 0;
    while (r < busy_row.ROWS) : (r += 1) {
        var col: usize = 0;
        while (col < busy_row.COLS) : (col += 1) {
            var buf: [64]u8 = undefined;
            const cell_tag = std.fmt.bufPrint(&buf, "busy-spinner-cell-{d}-{d}", .{ r, col }) catch unreachable;
            cells[r][col] = (dvui.tagGet(cell_tag) orelse {
                std.debug.print("tag '{s}' not found\n", .{cell_tag});
                @panic("cell tag not found");
            }).rect;
        }
    }

    return .{ .row = row_rect, .spinner = spinner, .cells = cells, .text = text };
}

test "busy-row fills window content width edge-to-edge (full-width teal_bg bar)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // Tag rects are physical pixels; use windowRectPixels() so this passes
    // regardless of the testing backend's pixel-scale version (local vs CI).
    const win = dvui.windowRectPixels();
    // expand=.horizontal must fill window content width, not shrink-wrap.
    try t.expectApproxEqAbs(win.w, rects.row.w, EPS);
    // Must be pinned to the content origin (x=0), not inset.
    try t.expectApproxEqAbs(win.x, rects.row.x, EPS);
}

test "cell rect: col-0 = CELL×CELL, col-1 = (CELL+GAP)×CELL (margin in rect)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        // col=0: no left margin, rect = CELL×CELL.
        try t.expectApproxEqAbs(busy_row.CELL * PX, rects.cells[row][0].w, EPS);
        try t.expectApproxEqAbs(busy_row.CELL * PX, rects.cells[row][0].h, EPS);
        // col=1: left margin = GAP, rect = (CELL+GAP)×CELL.
        try t.expectApproxEqAbs((busy_row.CELL + busy_row.GAP) * PX, rects.cells[row][1].w, EPS);
        try t.expectApproxEqAbs(busy_row.CELL * PX, rects.cells[row][1].h, EPS);
    }
}

test "horizontal gap: rects are adjacent, col-1 is exactly GAP wider" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        // Cell rects are adjacent (cell 1 starts where cell 0 ends).
        try t.expectApproxEqAbs(rects.cells[row][0].x + rects.cells[row][0].w, rects.cells[row][1].x, EPS);
        // The visual gap (GAP) lives in cell 1's left margin → rect.w diff.
        try t.expectApproxEqAbs(busy_row.GAP * PX, rects.cells[row][1].w - rects.cells[row][0].w, EPS);
    }
}

test "vertical gap: consecutive rows are exactly GAP apart" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 1;
    while (row < busy_row.ROWS) : (row += 1) {
        const above = rects.cells[row - 1][0];
        const below = rects.cells[row][0];
        try t.expectApproxEqAbs(busy_row.GAP * PX, below.y - (above.y + above.h), EPS);
    }
}

test "spinner rect: (W + TRAIL) × H (right margin in rect, no vert margin)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // Outer box has margin.w=TRAIL, min_size_content=W×H → w=W+TRAIL, h=H.
    try t.expectApproxEqAbs((busy_row.W + busy_row.TRAIL) * PX, rects.spinner.w, EPS);
    try t.expectApproxEqAbs(busy_row.H * PX, rects.spinner.h, EPS);
}

test "spinner content area: (w - TRAIL) × h = W × H (13×29 locked)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    try t.expectApproxEqAbs(busy_row.W * PX, rects.spinner.w - busy_row.TRAIL * PX, EPS);
    try t.expectApproxEqAbs(busy_row.H * PX, rects.spinner.h, EPS);
}

test "text starts immediately after spinner rect (TRAIL is inside spinner)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // TRAIL lives in the spinner's right margin (inside its rect). The text
    // starts at spinner.x + spinner.w — exactly after the spinner rect.
    try t.expectApproxEqAbs(rects.spinner.x + rects.spinner.w, rects.text.x, EPS);
}

test "spinner and text midpoints are gravity-centered (gravity_y=0.5)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();

    // Host build includes freetype — require non-zero text height so this is a
    // real measured midpoint, not a silent skip (adversarial-review Minor L6).
    try t.expect(rects.text.h > 0);

    const smy = rects.spinner.y + rects.spinner.h / 2.0;
    const tmy = rects.text.y + rects.text.h / 2.0;
    // Both gravity_y=0.5 in same horizontal row; 4 px tolerance for a 58 px
    // tall row (rounding / baseline offset).
    try t.expect(@abs(smy - tmy) <= 4.0);
}

test "first cell of each row sits at spinner left edge (no col*GAP on box tree)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        try t.expectApproxEqAbs(rects.spinner.x, rects.cells[row][0].x, EPS);
    }
}

test "first row cells sit at spinner top edge (no row*GAP on box tree)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    try t.expectApproxEqAbs(rects.spinner.y, rects.cells[0][0].y, EPS);
}

test "all 8 cells share the same painted height (CELL)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        var col: usize = 0;
        while (col < busy_row.COLS) : (col += 1) {
            try t.expectApproxEqAbs(busy_row.CELL * PX, rects.cells[row][col].h, EPS);
        }
    }
}
