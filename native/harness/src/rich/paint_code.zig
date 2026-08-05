//! Fenced code paint — mono box, muted lang, line cap ~80.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");

pub const FENCE_LINE_CAP: usize = 80;

pub fn paintCodeFence(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
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

    if (block.meta) |lang| {
        if (lang.len > 0) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .id_extra = paint_text.nextIdPublic(ctx),
                .color_text = ctx.style.fence_lang_text,
                .font = .theme(.mono),
                .background = false,
                .padding = .{ .x = 0, .y = 0, .w = 0, .h = 2 },
            });
            defer tl.deinit();
            tl.addText(lang, .{ .color_text = ctx.style.fence_lang_text, .font = .theme(.mono) });
            tl.addText("\n", .{});
        }
    }

    // Join inlines into body text (fence content is usually plain text runs)
    var line_count: usize = 0;
    var truncated: usize = 0;
    var tl = dvui.textLayout(@src(), .{}, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .color_text = ctx.style.code_text,
        .font = .theme(.mono),
        .background = false,
    });
    defer tl.deinit();

    for (block.inlines) |inl| {
        paintFenceText(tl, inl.text, &line_count, &truncated, ctx);
    }
    if (truncated > 0) {
        var buf: [48]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "\n… {d} more lines", .{truncated}) catch "\n… more lines";
        tl.addText(msg, .{
            .color_text = ctx.style.fence_lang_text,
            .font = .theme(.mono),
        });
    }
}

fn paintFenceText(tl: *dvui.TextLayoutWidget, text: []const u8, line_count: *usize, truncated: *usize, ctx: *const paint_text.PaintCtx) void {
    var start: usize = 0;
    var i: usize = 0;
    while (i <= text.len) : (i += 1) {
        const at_end = i == text.len;
        const at_nl = !at_end and text[i] == '\n';
        if (!at_end and !at_nl) continue;
        const line = text[start..i];
        if (line_count.* < FENCE_LINE_CAP) {
            tl.addText(line, .{
                .color_text = ctx.style.code_text,
                .font = .theme(.mono),
            });
            if (at_nl and line_count.* + 1 < FENCE_LINE_CAP) {
                tl.addText("\n", .{ .font = .theme(.mono) });
            }
            line_count.* += 1;
        } else {
            truncated.* += 1;
        }
        start = i + 1;
        if (at_end) break;
    }
}
