//! GFM pipe table paint — dvui GridWidget with borders (no box-drawing glyphs).
//! Cell bodies use paintInlineFlow (rich inlines); meta may include per-cell run counts.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");
const table = @import("table.zig");

const MAX_CELLS = table.MAX_CELLS;

/// Horizontal gravity for a column (shared by header + body).
fn colPaintX(aligns: *const [table.MAX_COLS]table.Align, col: usize, cols: usize) f32 {
    if (col >= cols) return 0.0;
    return aligns[col].paintX();
}

fn paintCellInlines(
    slice: []const parse.Inline,
    ctx: *paint_text.PaintCtx,
    base_font: dvui.Font,
    ax: f32,
) void {
    // Outer box carries column gravity; paintInlineFlow has no gravity_x.
    var wrap = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .gravity_x = ax,
        .id_extra = paint_text.nextIdPublic(ctx),
        .background = false,
        .padding = .{},
        .margin = .{},
    });
    defer wrap.deinit();
    paint_text.paintInlineFlow(@src(), slice, ctx, base_font, .{
        .expand = .horizontal,
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
        .color_text = ctx.style.body_text,
    });
}

pub fn paintTable(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
    const inline_n = block.inlines.len;
    if (inline_n == 0) return;

    const meta = table.parsePaintMeta(block.meta, inline_n);
    const cols = meta.cols;
    const overflow = meta.overflow;
    if (cols == 0) return;

    // parsePaintMeta caps soft-fail; tryParseRuns caps valid runs to MAX_CELLS.
    const num_cells = meta.num_cells;
    if (num_cells == 0) return;
    const total_rows = num_cells / cols;
    if (total_rows == 0) return;

    const has_header = block.level == 1 and total_rows >= 1;
    const body_rows: usize = if (has_header) total_rows - 1 else total_rows;
    const header_offset: usize = if (has_header) 1 else 0;

    const body_font = dvui.Font.theme(.body);
    const header_font = body_font.withWeight(.bold);
    const cell_border = dvui.Rect.all(1);
    const cell_pad = dvui.Rect.all(6);

    // Outer frame — palette surface + border (matches fence tokens, no freehand)
    var outer = dvui.box(src, .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .background = true,
        .color_fill = ctx.style.code_fill,
        .color_border = ctx.style.code_border,
        .border = .all(1),
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
        .margin = .{ .x = 0, .y = 2, .w = 0, .h = 4 },
    });
    defer outer.deinit();

    // layout_only: bordered grid without spreadsheet edit/select chrome
    var grid = dvui.grid(@src(), .{
        .layout_only = true,
        .rows = body_rows,
        .scroll_opts = .{
            .horizontal = .auto,
            .vertical = .none,
        },
    }, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .background = true,
        .color_fill = ctx.style.code_fill,
        .color_border = ctx.style.code_border,
        .border = .all(0),
        .padding = .{},
        .margin = .{},
    });
    defer grid.deinit();

    // Force autosize every paint so col widths track content (small tables)
    grid.autoSize(.{
        .auto = .both,
        .min_width = 48,
        .min_height = 20,
        .max_width = 280,
        .max_height = 120,
    });

    // Build cursor offsets: start index of each cell in block.inlines
    var starts: [MAX_CELLS]usize = undefined;
    const cell_n = @min(num_cells, MAX_CELLS);
    {
        var cursor: usize = 0;
        var i: usize = 0;
        while (i < cell_n) : (i += 1) {
            starts[i] = cursor;
            const n = table.cellRunCount(&meta, i);
            const add = @addWithOverflow(cursor, n);
            if (add[1] != 0 or add[0] > inline_n) {
                // Soft-fail: clamp remaining to empty
                cursor = inline_n;
            } else {
                cursor = add[0];
            }
        }
    }

    // Column headers
    if (has_header) {
        var col: usize = 0;
        while (col < cols) : (col += 1) {
            var cell = grid.colHeader(col, .{
                .border = cell_border,
                .color_border = ctx.style.code_border,
                .background = true,
                .color_fill = ctx.style.code_fill,
                .padding = cell_pad,
            });
            defer cell.deinit();
            const ax = colPaintX(&meta.aligns, col, cols);
            const n = table.cellRunCount(&meta, col);
            const start = starts[col];
            const end = @min(start + n, inline_n);
            const slice = if (start < inline_n) block.inlines[start..end] else block.inlines[0..0];
            paintCellInlines(slice, ctx, header_font, ax);
        }
    }

    // Body rows
    var row: usize = 0;
    while (row < body_rows) : (row += 1) {
        const band = (row % 2 == 1);
        var col: usize = 0;
        while (col < cols) : (col += 1) {
            const cell_i = (header_offset + row) * cols + col;
            const fill = if (band) ctx.style.code_fill else null;

            var cell = grid.cell(.{ .col = col, .row = row, .draw_focus = false }, .{
                .border = cell_border,
                .color_border = ctx.style.code_border,
                .background = true,
                .color_fill = if (fill) |f| f else ctx.style.code_fill,
                .padding = cell_pad,
            });
            defer cell.deinit();

            const ax = colPaintX(&meta.aligns, col, cols);
            if (cell_i >= num_cells) {
                paintCellInlines(&.{}, ctx, body_font, ax);
                continue;
            }
            const n = table.cellRunCount(&meta, cell_i);
            const start = starts[cell_i];
            const end = @min(start + n, inline_n);
            const slice = if (start < inline_n) block.inlines[start..end] else block.inlines[0..0];
            paintCellInlines(slice, ctx, body_font, ax);
        }
    }

    if (overflow > 0) {
        var buf: [48]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "… {d} more rows", .{overflow}) catch "… more rows";
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .id_extra = paint_text.nextIdPublic(ctx),
            .color_text = ctx.style.fence_lang_text,
            .font = body_font,
            .background = false,
            .padding = .{ .x = 8, .y = 4, .w = 8, .h = 4 },
        });
        defer tl.deinit();
        tl.addText(msg, .{
            .color_text = ctx.style.fence_lang_text,
            .font = body_font,
        });
        tl.addText("\n", .{});
    }
}
