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
//! Padding on the outer box is **not** in the tag the same way: it insets
//! `contentRect`, so cells sit `PAD_X`/`PAD_Y` inside the 13×29 slot. Right-
//! edge locks must use `W` (the slot), never `spinner.w` (which includes TRAIL).
//!
//! TextLayout heights are non-zero when the host build includes freetype
//! rasterization (which the host-target testing build does). Vertical-
//! alignment tests assert h>0 so the midpoint measurement is real, not a
//! fail-open no-op (adversarial-review Minor L6).

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const busy_row = @import("busy_row.zig");
const rect_spinner = @import("rect_spinner.zig");

/// Gap tolerance for floating-point position assertions (sub-pixel rounding).
const EPS: f32 = 1.0;
/// Physical pixel scale: testing-backend init defaults to 2×.
const PX: f32 = 2;

/// Run TWO frames painting only the busy row and return the tag rects from the
/// SECOND frame. See file-level doc for the two-frame rationale.
fn paintAndGetRects() struct {
    row: dvui.Rect.Physical,
    lead: dvui.Rect.Physical,
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
    const lead = (dvui.tagGet("busy-row-lead") orelse @panic("tag 'busy-row-lead' not found")).rect;
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

    return .{ .row = row_rect, .lead = lead, .spinner = spinner, .cells = cells, .text = text };
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

test "slot identity: INNER + 2×PAD == W×H" {
    try t.expectEqual(busy_row.W, busy_row.INNER_W + 2.0 * busy_row.PAD_X);
    try t.expectEqual(busy_row.H, busy_row.INNER_H + 2.0 * busy_row.PAD_Y);
    try t.expectEqual(rect_spinner.W, rect_spinner.INNER_W + 2.0 * rect_spinner.PAD_X);
    try t.expectEqual(rect_spinner.H, rect_spinner.INNER_H + 2.0 * rect_spinner.PAD_Y);
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
    // Outer box has margin.w=TRAIL, padSize(INNER)+PAD → w=W+TRAIL, h=H.
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

test "first cell of each row is inset by PAD_X from spinner left" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        try t.expectApproxEqAbs(rects.spinner.x + busy_row.PAD_X * PX, rects.cells[row][0].x, EPS);
    }
}

test "first row cells are inset by PAD_Y from spinner top" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    var col: usize = 0;
    while (col < busy_row.COLS) : (col += 1) {
        try t.expectApproxEqAbs(rects.spinner.y + busy_row.PAD_Y * PX, rects.cells[0][col].y, EPS);
    }
}

test "last col visual right is inset by PAD_X from the slot (not spinner.w)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // col-1 tag includes left GAP, so x+w is the visual right of the cell.
    // Use W (13) — spinner.w includes TRAIL and would miss the slot.
    const want = rects.spinner.x + busy_row.W * PX - busy_row.PAD_X * PX;
    var row: usize = 0;
    while (row < busy_row.ROWS) : (row += 1) {
        const cell = rects.cells[row][1];
        try t.expectApproxEqAbs(want, cell.x + cell.w, EPS);
    }
}

test "last row visual bottom is inset by PAD_Y from the slot" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    const want = rects.spinner.y + busy_row.H * PX - busy_row.PAD_Y * PX;
    var col: usize = 0;
    while (col < busy_row.COLS) : (col += 1) {
        const cell = rects.cells[busy_row.ROWS - 1][col];
        try t.expectApproxEqAbs(want, cell.y + cell.h, EPS);
    }
}

test "LEAD wrapper: x=0 pinned at bar left edge, wraps spinner+text with left margin" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // The LEAD wrapper is the first child of the row, pinned at x=0.
    // Its rect.w includes the left margin plus its children (spinner+text).
    try t.expectApproxEqAbs(rects.row.x, rects.lead.x, EPS);
    // The wrapper must be at least LEAD wide (margin) plus the spinner.
    try t.expect(rects.lead.w >= busy_row.LEAD * PX + rects.spinner.w - EPS);
}

test "spinner x = LEAD (inset from bar left edge via wrapper margin)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // The spinner is the first child of the LEAD wrapper, which has
    // margin.x=LEAD. The spinner starts at the wrapper's content origin:
    // lead.x + margin.x = 0 + LEAD = LEAD.
    try t.expectApproxEqAbs(busy_row.LEAD * PX, rects.spinner.x, EPS);
}

test "LEAD wrapper contains spinner+text: children are packed inside the wrapper" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const rects = paintAndGetRects();
    // Spinner+text are inside the lead_wrapper (children of the inner
    // horizontal box), so the wrapper's outer rect encompasses both.
    try t.expect(rects.lead.x <= rects.spinner.x);
    try t.expect(rects.spinner.x + rects.spinner.w <= rects.lead.x + rects.lead.w + EPS);
    try t.expect(rects.text.x + rects.text.w <= rects.lead.x + rects.lead.w + EPS);
    // Text still starts immediately after spinner (TRAIL in spinner rect).
    try t.expectApproxEqAbs(rects.spinner.x + rects.spinner.w, rects.text.x, EPS);
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

/// Paint TWO `rect_spinner.paint` instances from the same call site in one
/// frame, with disjoint `tag_prefix` values and `id_extra` bases spaced
/// `ID_SPAN` apart. Returns both spinners' outer rects and their 8 cells, so
/// the caller can assert every widget of each instance landed without aliasing
/// (PR #608 Minor L1+L8 — the reuse contract must not rely on lucky ids).
fn paintTwoSpinners() struct {
    a_root: dvui.Rect.Physical,
    b_root: dvui.Rect.Physical,
    a_cells: [rect_spinner.ROWS][rect_spinner.COLS]dvui.Rect.Physical,
    b_cells: [rect_spinner.ROWS][rect_spinner.COLS]dvui.Rect.Physical,
} {
    const ID_A: usize = 0x70_0000;
    const ID_B: usize = ID_A + rect_spinner.ID_SPAN;
    const frame = struct {
        fn paint() !dvui.App.Result {
            const src = @src();
            rect_spinner.paint(src, .{ .phase = 0, .ramp = rect_spinner.WARM_RAMP, .tag_prefix = "spa", .id_extra = ID_A });
            rect_spinner.paint(src, .{ .phase = 2, .ramp = rect_spinner.TEAL_RAMP, .tag_prefix = "spb", .id_extra = ID_B });
            return .ok;
        }
    }.paint;

    _ = dvui.testing.step(frame) catch @panic("step 1 failed");
    _ = dvui.testing.step(frame) catch @panic("step 2 failed");

    const a_root = (dvui.tagGet("spa") orelse @panic("tag 'spa' not found")).rect;
    const b_root = (dvui.tagGet("spb") orelse @panic("tag 'spb' not found")).rect;

    var a_cells: [rect_spinner.ROWS][rect_spinner.COLS]dvui.Rect.Physical = undefined;
    var b_cells: [rect_spinner.ROWS][rect_spinner.COLS]dvui.Rect.Physical = undefined;
    var r: usize = 0;
    while (r < rect_spinner.ROWS) : (r += 1) {
        var col: usize = 0;
        while (col < rect_spinner.COLS) : (col += 1) {
            var buf_a: [64]u8 = undefined;
            var buf_b: [64]u8 = undefined;
            const ta = std.fmt.bufPrint(&buf_a, "spa-cell-{d}-{d}", .{ r, col }) catch unreachable;
            const tb = std.fmt.bufPrint(&buf_b, "spb-cell-{d}-{d}", .{ r, col }) catch unreachable;
            a_cells[r][col] = (dvui.tagGet(ta) orelse @panic("spa cell tag not found")).rect;
            b_cells[r][col] = (dvui.tagGet(tb) orelse @panic("spb cell tag not found")).rect;
        }
    }

    return .{ .a_root = a_root, .b_root = b_root, .a_cells = a_cells, .b_cells = b_cells };
}

test "two spinners from one src with ID_SPAN-apart bases do not alias (PR #608 Minor L1+L8)" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();
    const both = paintTwoSpinners();

    // Both outer boxes rendered with the same W×H geometry (margin default 10).
    try t.expectApproxEqAbs((rect_spinner.W + 10) * PX, both.a_root.w, EPS);
    try t.expectApproxEqAbs(rect_spinner.H * PX, both.a_root.h, EPS);
    try t.expectApproxEqAbs((rect_spinner.W + 10) * PX, both.b_root.w, EPS);
    try t.expectApproxEqAbs(rect_spinner.H * PX, both.b_root.h, EPS);

    // Both instances' cells are laid out at the same geometry as the single
    // busy-row caller (independence of the shared src): dvui tag rects include
    // each widget's margin, so col-0 is CELL×CELL and col-1 is (CELL+GAP)×CELL.
    // If the two instances' ids aliased each other, dvui would fold one
    // instance's widgets into the other and these width checks would differ.
    var row: usize = 0;
    while (row < rect_spinner.ROWS) : (row += 1) {
        try t.expectApproxEqAbs(rect_spinner.CELL * PX, both.a_cells[row][0].w, EPS);
        try t.expectApproxEqAbs(rect_spinner.CELL * PX, both.b_cells[row][0].w, EPS);
        try t.expectApproxEqAbs((rect_spinner.CELL + rect_spinner.GAP) * PX, both.a_cells[row][1].w, EPS);
        try t.expectApproxEqAbs((rect_spinner.CELL + rect_spinner.GAP) * PX, both.b_cells[row][1].w, EPS);
    }
}
