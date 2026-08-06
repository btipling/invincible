//! Fenced code paint — mono box, muted lang, line cap ~80.
//! Allowlisted langs get token colors via highlight.zig.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");
const highlight = @import("highlight.zig");

pub const FENCE_LINE_CAP: usize = 80;
const JOIN_CAP: usize = 4096;
const TOKEN_CAP: usize = 2048;

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

    if (highlight.resolveFamily(block.meta)) |family| {
        // Join inlines then lex once (plan lock).
        var join_buf: [JOIN_CAP]u8 = undefined;
        var join_len: usize = 0;
        for (block.inlines) |inl| {
            const take = @min(inl.text.len, JOIN_CAP - join_len);
            if (take > 0) {
                @memcpy(join_buf[join_len .. join_len + take], inl.text[0..take]);
                join_len += take;
            }
            if (join_len >= JOIN_CAP) break;
        }
        const body = join_buf[0..join_len];
        var tokens: [TOKEN_CAP]highlight.Token = undefined;
        const ntok = highlight.lexInto(body, family, &tokens);
        paintHighlighted(tl, body, tokens[0..ntok], &line_count, &truncated, ctx);
    } else {
        for (block.inlines) |inl| {
            paintFenceText(tl, inl.text, &line_count, &truncated, ctx);
        }
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

fn tokenColor(kind: highlight.TokenKind, ctx: *const paint_text.PaintCtx) dvui.Color {
    return switch (kind) {
        .default => ctx.style.code_text,
        .comment => ctx.style.code_comment,
        .keyword => ctx.style.code_keyword,
        .string => ctx.style.code_string,
        .number => ctx.style.code_number,
    };
}

/// Paint token spans with 80-line cap (same counting as mono path).
fn paintHighlighted(
    tl: *dvui.TextLayoutWidget,
    body: []const u8,
    tokens: []const highlight.Token,
    line_count: *usize,
    truncated: *usize,
    ctx: *const paint_text.PaintCtx,
) void {
    var line_start: usize = 0;
    var i: usize = 0;
    var tok_i: usize = 0;
    while (i <= body.len) : (i += 1) {
        const at_end = i == body.len;
        const at_nl = !at_end and body[i] == '\n';
        if (!at_end and !at_nl) continue;
        const line_end = i;
        if (line_count.* < FENCE_LINE_CAP) {
            paintLineSpans(tl, body, line_start, line_end, tokens, &tok_i, ctx);
            if (at_nl and line_count.* + 1 < FENCE_LINE_CAP) {
                tl.addText("\n", .{ .font = .theme(.mono) });
            }
            line_count.* += 1;
        } else {
            truncated.* += 1;
        }
        line_start = i + 1;
        if (at_end) break;
    }
}

/// Paint one line [line_start, line_end) using token slices.
/// `tok_i` is advanced so successive lines do not re-scan earlier tokens.
fn paintLineSpans(
    tl: *dvui.TextLayoutWidget,
    body: []const u8,
    line_start: usize,
    line_end: usize,
    tokens: []const highlight.Token,
    tok_i: *usize,
    ctx: *const paint_text.PaintCtx,
) void {
    if (line_start >= line_end) return;
    var cursor = line_start;
    while (tok_i.* < tokens.len) {
        const tok = tokens[tok_i.*];
        const t0 = tok.start;
        const t1 = tok.start + tok.len;
        if (t1 <= line_start) {
            tok_i.* += 1;
            continue;
        }
        if (t0 >= line_end) break;
        const s = @max(t0, line_start);
        const e = @min(t1, line_end);
        if (s < cursor) {
            // shouldn't happen if tokens are contiguous; skip overlap
            tok_i.* += 1;
            continue;
        }
        if (s > cursor) {
            // gap → default (TOKEN_CAP remainder or non-contiguous)
            tl.addText(body[cursor..s], .{
                .color_text = ctx.style.code_text,
                .font = .theme(.mono),
            });
        }
        if (e > s) {
            tl.addText(body[s..e], .{
                .color_text = tokenColor(tok.kind, ctx),
                .font = .theme(.mono),
            });
        }
        cursor = e;
        if (t1 <= line_end) {
            // token fully consumed on this line
            tok_i.* += 1;
        }
        if (cursor >= line_end) break;
    }
    if (cursor < line_end) {
        tl.addText(body[cursor..line_end], .{
            .color_text = ctx.style.code_text,
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
