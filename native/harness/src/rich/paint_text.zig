//! Paragraph / heading / list_item / plain + inline runs (style flags compose).
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const style_mod = @import("style.zig");
const mixed_text = @import("mixed_text.zig");

pub const PaintCtx = struct {
    style: style_mod.StyleMap,
    id_base: usize,
    run_seq: *usize,
};

fn nextId(ctx: *PaintCtx) usize {
    const id = ctx.id_base + ctx.run_seq.*;
    ctx.run_seq.* += 1;
    return id;
}

pub fn nextIdPublic(ctx: *PaintCtx) usize {
    return nextId(ctx);
}

fn fontFor(base: dvui.Font, kind: parse.InlineKind, f: parse.StyleFlags) dvui.Font {
    var font = switch (kind) {
        .code => dvui.Font.theme(.mono),
        .text, .link => base,
    };
    if (f.strong) font = font.withWeight(.bold);
    if (f.emph) font = font.withStyle(.italic);
    if (f.strike) font = font.withStrike(.{});
    return font;
}

fn colorFor(st: style_mod.StyleMap, kind: parse.InlineKind, f: parse.StyleFlags) dvui.Color {
    if (kind == .code) return st.code_text;
    if (kind == .link) return st.link_text;
    if (f.strong) return st.strong_text;
    if (f.emph) return st.emph_text;
    return st.body_text;
}

/// Paint flat inline runs. `base_font` is the block face (body for paragraphs,
/// title/heading for headings). Style flags compose bold/italic/strike.
/// Emoji code points switch to OpenMoji (see mixed_text.zig).
pub fn paintInlines(tl: *dvui.TextLayoutWidget, inlines: []const parse.Inline, ctx: *const PaintCtx, base_font: dvui.Font) void {
    const st = ctx.style;
    for (inlines) |inl| {
        if (inl.text.len == 0) continue;
        const font = fontFor(base_font, inl.kind, inl.flags);
        switch (inl.kind) {
            .text => {
                mixed_text.addTextMixed(tl, inl.text, font, .{ .color_text = colorFor(st, .text, inl.flags) });
            },
            .code => {
                mixed_text.addTextMixed(tl, inl.text, font, .{
                    .color_text = st.code_text,
                    .color_fill = st.code_fill,
                });
            },
            .link => {
                const href = inl.href orelse "";
                if (style_mod.isSafeLinkUrl(href)) {
                    const label = if (inl.text.len > 0) inl.text else href;
                    tl.addLink(.{
                        .text = label,
                        .url = href,
                    }, .{
                        .color_text = st.link_text,
                        .font = font.withUnderline(.{}),
                    });
                } else {
                    mixed_text.addTextMixed(tl, if (inl.text.len > 0) inl.text else href, font, .{ .color_text = st.body_text });
                }
            },
        }
    }
}

pub fn paintHeading(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const level = if (block.level == 0) 1 else block.level;
    // H1–H3: existing title/section/subsection faces.
    // H4–H6: detail → fine print → whisper ladder (#149 / plan #182).
    const font = switch (level) {
        1 => dvui.Font.theme(.title),
        2 => dvui.Font.theme(.heading).larger(2),
        3 => dvui.Font.theme(.heading),
        4 => dvui.Font.theme(.body).withWeight(.bold),
        5 => dvui.Font.theme(.body),
        else => dvui.Font.theme(.body).smaller(), // H6+
    };
    const color = switch (level) {
        1, 2, 3, 4 => ctx.style.heading_text,
        else => ctx.style.muted_text, // H5 / H6
    };
    // paintInlines always sets explicit color_text from StyleMap (never inherits
    // textLayout.color_text). Override body_text so plain heading runs use the
    // ladder color; strong/code/link keep StyleMap colors — same as paintBlockquote.
    var heading_style = ctx.style;
    heading_style.body_text = color;
    var heading_ctx = PaintCtx{
        .style = heading_style,
        .id_base = ctx.id_base,
        .run_seq = ctx.run_seq,
    };
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .color_text = color,
        .font = font,
        .background = false,
        .padding = .{ .x = 0, .y = 2, .w = 0, .h = 2 },
    });
    defer tl.deinit();
    paintInlines(tl, block.inlines, &heading_ctx, font);
    tl.addText("\n", .{});
}

pub fn paintParagraph(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .color_text = ctx.style.body_text,
        .font = body,
        .background = false,
        .padding = .{ .x = 0, .y = 1, .w = 0, .h = 2 },
    });
    defer tl.deinit();
    paintInlines(tl, block.inlines, ctx, body);
    tl.addText("\n", .{});
}

pub fn paintListItem(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    const depth: f32 = @floatFromInt(@min(block.level, 6));
    const indent: f32 = 8.0 + depth * 10.0;
    // textLayout defaults pad 6px — must zero both marker and body or the bullet sits high.
    const zero_pad = dvui.Rect{ .x = 0, .y = 0, .w = 0, .h = 0 };
    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
        .margin = .{ .x = indent, .y = 0, .w = 0, .h = 1 },
    });
    defer row.deinit();

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .id_extra = nextId(ctx),
            .color_text = ctx.style.bullet_text,
            .font = body,
            .background = false,
            .padding = .{ .x = 0, .y = 0, .w = 4, .h = 0 },
        });
        defer tl.deinit();
        tl.addText("• ", .{ .color_text = ctx.style.bullet_text, .font = body });
    }
    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .id_extra = nextId(ctx),
            .color_text = ctx.style.body_text,
            .font = body,
            .background = false,
            .padding = zero_pad,
        });
        defer tl.deinit();
        paintInlines(tl, block.inlines, ctx, body);
        tl.addText("\n", .{});
    }
}


pub fn paintBlockquote(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    const level: u8 = if (block.level == 0) 1 else block.level;
    const depth: f32 = @floatFromInt(@min(level -| 1, 6));
    const indent: f32 = 8.0 + depth * 10.0;
    // Plain runs use quote_text (muted); strong/code/link keep StyleMap colors.
    var quote_style = ctx.style;
    quote_style.body_text = ctx.style.quote_text;
    var quote_ctx = PaintCtx{
        .style = quote_style,
        .id_base = ctx.id_base,
        .run_seq = ctx.run_seq,
    };
    // textLayout defaults pad 6px — zero it so the bar top matches text top.
    const zero_pad = dvui.Rect{ .x = 0, .y = 0, .w = 0, .h = 0 };
    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
        .margin = .{ .x = indent, .y = 1, .w = 0, .h = 2 },
    });
    defer row.deinit();

    // Left bar (~3px) — expands to row height so multi-line quotes keep a full rule.
    {
        var bar = dvui.box(@src(), .{ .dir = .vertical }, .{
            .id_extra = nextId(ctx),
            .background = true,
            .color_fill = ctx.style.quote_bar,
            .min_size_content = .{ .w = 3, .h = 1 },
            .expand = .vertical,
            .margin = .{ .x = 0, .y = 0, .w = 8, .h = 0 },
        });
        defer bar.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .id_extra = nextId(ctx),
            .color_text = ctx.style.quote_text,
            .font = body,
            .background = false,
            .padding = zero_pad,
        });
        defer tl.deinit();
        paintInlines(tl, block.inlines, &quote_ctx, body);
        tl.addText("\n", .{});
    }
}

pub fn paintPlain(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    paintParagraph(src, block, ctx);
}

pub fn paintThematicBreak(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    _ = block;
    // Horizontal rule — dvui.separator fill bar (palette teal_border via quote_bar).
    // No text / box-drawing glyphs (avoids tofu).
    _ = dvui.separator(src, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .color_fill = ctx.style.quote_bar,
        .min_size_content = .{ .w = 1, .h = 2 },
        .margin = .{ .x = 0, .y = 6, .w = 0, .h = 6 },
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
    });
}

