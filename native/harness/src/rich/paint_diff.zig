//! Unified diff / patch fence paint — line colors from palette (no freehand hex).
//! EMBER on '-' lines is intentional **removed-line** semantics, not error chrome.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");
const paint_code = @import("paint_code.zig");
const diff_lang = @import("diff_lang.zig");
const mixed_text = @import("mixed_text.zig");

pub const isDiffLang = diff_lang.isDiffLang;
pub const classifyLine = diff_lang.classifyLine;
pub const LineKind = diff_lang.LineKind;

pub fn paintDiffFence(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
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

    var line_count: usize = 0;
    var truncated: usize = 0;
    var in_hunk: bool = false;
    var tl = dvui.textLayout(@src(), .{}, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(ctx),
        .color_text = ctx.style.code_text,
        .font = .theme(.mono),
        .background = false,
    });
    defer tl.deinit();

    for (block.inlines) |inl| {
        paintDiffText(tl, inl.text, &line_count, &truncated, &in_hunk, ctx);
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

fn paintDiffText(
    tl: *dvui.TextLayoutWidget,
    text: []const u8,
    line_count: *usize,
    truncated: *usize,
    in_hunk: *bool,
    ctx: *const paint_text.PaintCtx,
) void {
    const cap = paint_code.FENCE_LINE_CAP;
    var start: usize = 0;
    var i: usize = 0;
    while (i <= text.len) : (i += 1) {
        const at_end = i == text.len;
        const at_nl = !at_end and text[i] == '\n';
        if (!at_end and !at_nl) continue;
        const line = text[start..i];
        if (line_count.* < cap) {
            const kind = classifyLine(line, in_hunk.*);
            if (std.mem.startsWith(u8, line, "@@")) in_hunk.* = true;
            const color = lineColor(kind, ctx);
            // Mixed: DejaVu for text symbols (✎ U+270E, arrows, …) at mono
            // size; report-bar lookalike (U+23AF/U+2500/U+2501 → U+2015) stays
            // inside addTextMixed. Substituted-only would pin Vera and tofu.
            mixed_text.addTextMixed(tl, line, .theme(.mono), .{
                .color_text = color,
            });
            if (at_nl and line_count.* + 1 < cap) {
                tl.addText("\n", .{ .font = .theme(.mono) });
            }
            line_count.* += 1;
        } else {
            // Still advance hunk state so color stays correct if we ever paint past cap later.
            if (std.mem.startsWith(u8, line, "@@")) in_hunk.* = true;
            truncated.* += 1;
        }
        start = i + 1;
        if (at_end) break;
    }
}

fn lineColor(kind: LineKind, ctx: *const paint_text.PaintCtx) dvui.Color {
    return switch (kind) {
        .add => ctx.style.diff_add,
        .del => ctx.style.diff_del,
        .meta => ctx.style.diff_meta,
        .context => ctx.style.code_text,
    };
}
