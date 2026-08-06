//! GFM pipe table paint — dvui GridWidget with borders (no box-drawing glyphs).
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");

/// Parse meta "cols,overflow" → (cols, overflow_rows). Defaults: cols from cells, 0 overflow.
fn parseMeta(meta: ?[]const u8, cell_n: usize) struct { usize, usize } {
    if (meta) |m| {
        var it = std.mem.splitScalar(u8, m, ',');
        const c_s = it.next() orelse "";
        const o_s = it.next() orelse "0";
        const cols = std.fmt.parseInt(usize, c_s, 10) catch 0;
        const overflow = std.fmt.parseInt(usize, o_s, 10) catch 0;
        if (cols > 0) return .{ cols, overflow };
    }
    // fallback: treat as single column
    _ = cell_n;
    return .{ 1, 0 };
}

pub fn paintTable(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
    const cell_n = block.inlines.len;
    if (cell_n == 0) return;

    const cols, const overflow = parseMeta(block.meta, cell_n);
    if (cols == 0) return;
    const total_rows = cell_n / cols;
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

    // Column headers
    if (has_header) {
        var col: usize = 0;
        while (col < cols) : (col += 1) {
            const cell = grid.colHeader(col, .{
                .border = cell_border,
                .color_border = ctx.style.code_border,
                .background = true,
                .color_fill = ctx.style.code_fill,
                .padding = cell_pad,
            });
            defer cell.deinit();
            const text = block.inlines[col].text;
            dvui.labelNoFmt(@src(), text, .{}, .{
                .font = header_font,
                .color_text = ctx.style.body_text,
                .id_extra = paint_text.nextIdPublic(ctx),
            });
        }
    }

    // Body rows
    var row: usize = 0;
    while (row < body_rows) : (row += 1) {
        const band = (row % 2 == 1);
        var col: usize = 0;
        while (col < cols) : (col += 1) {
            const idx = (header_offset + row) * cols + col;
            const text = if (idx < block.inlines.len) block.inlines[idx].text else "";
            const fill = if (band) ctx.style.code_fill else null;

            var cell = grid.cell(.{ .col = col, .row = row, .draw_focus = false }, .{
                .border = cell_border,
                .color_border = ctx.style.code_border,
                .background = true,
                .color_fill = if (fill) |f| f else ctx.style.code_fill,
                .padding = cell_pad,
            });
            defer cell.deinit();

            dvui.labelNoFmt(@src(), text, .{}, .{
                .font = body_font,
                .color_text = ctx.style.body_text,
                .id_extra = paint_text.nextIdPublic(ctx),
            });
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
