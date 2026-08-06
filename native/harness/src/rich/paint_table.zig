//! GFM pipe table paint — mono surface box (no token HL, no inner scroll).
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");

pub fn paintTable(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
    var box = dvui.box(src, .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .background = true,
        .color_fill = ctx.style.code_fill,
        .color_border = ctx.style.code_border,
        .padding = .{ .x = 8, .y = 6, .w = 8, .h = 6 },
        .margin = .{ .x = 0, .y = 2, .w = 0, .h = 4 },
    });
    defer box.deinit();

    const mono = dvui.Font.theme(.mono);
    const mono_bold = mono.withWeight(.bold);
    const zero_pad = dvui.Rect{ .x = 0, .y = 0, .w = 0, .h = 0 };

    var tl = dvui.textLayout(@src(), .{}, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .color_text = ctx.style.code_text,
        .font = mono,
        .background = false,
        .padding = zero_pad,
    });
    defer tl.deinit();

    // Join inlines to full grid text
    var join_buf: [4096]u8 = undefined;
    var join_len: usize = 0;
    for (block.inlines) |inl| {
        const take = @min(inl.text.len, join_buf.len - join_len);
        if (take > 0) {
            @memcpy(join_buf[join_len .. join_len + take], inl.text[0..take]);
            join_len += take;
        }
        if (join_len >= join_buf.len) break;
    }
    const grid = join_buf[0..join_len];
    if (grid.len == 0) {
        tl.addText("\n", .{});
        return;
    }

    // First line bold when header present (level == 1)
    const bold_header = block.level == 1;
    var line_start: usize = 0;
    var line_i: usize = 0;
    var i: usize = 0;
    while (i <= grid.len) : (i += 1) {
        const at_end = i == grid.len;
        const at_nl = !at_end and grid[i] == '\n';
        if (!at_end and !at_nl) continue;

        const line = grid[line_start..i];
        const is_overflow = std.mem.startsWith(u8, line, "…");
        if (line.len > 0) {
            if (is_overflow) {
                tl.addText(line, .{
                    .color_text = ctx.style.fence_lang_text,
                    .font = mono,
                });
            } else if (bold_header and line_i == 0) {
                tl.addText(line, .{
                    .color_text = ctx.style.code_text,
                    .font = mono_bold,
                });
            } else {
                tl.addText(line, .{
                    .color_text = ctx.style.code_text,
                    .font = mono,
                });
            }
        }
        tl.addText("\n", .{});
        line_i += 1;
        line_start = i + 1;
        if (at_end) break;
    }
}
