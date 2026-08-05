//! Paragraph / heading / list_item / plain + inline runs.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const style_mod = @import("style.zig");

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

/// Paint flat inline runs. `base_font` is the block face (body for paragraphs,
/// title/heading for headings) so strong/emph/link keep block size.
pub fn paintInlines(tl: *dvui.TextLayoutWidget, inlines: []const parse.Inline, ctx: *const PaintCtx, base_font: dvui.Font) void {
    const st = ctx.style;
    for (inlines) |inl| {
        switch (inl.kind) {
            .text => {
                tl.addText(inl.text, .{
                    .color_text = st.body_text,
                    .font = base_font,
                });
            },
            .strong => {
                tl.addText(inl.text, .{
                    .color_text = st.strong_text,
                    .font = base_font.withWeight(.bold),
                });
            },
            .emph => {
                tl.addText(inl.text, .{
                    .color_text = st.emph_text,
                    .font = base_font.withStyle(.italic),
                });
            },
            .code => {
                tl.addText(inl.text, .{
                    .color_text = st.code_text,
                    .color_fill = st.code_fill,
                    .font = .theme(.mono),
                });
            },
            .link => {
                const href = inl.href orelse "";
                if (style_mod.isSafeLinkUrl(href)) {
                    tl.addLink(.{
                        .text = if (inl.text.len > 0) inl.text else href,
                        .url = href,
                    }, .{
                        .color_text = st.link_text,
                        .font = base_font.withUnderline(.{}),
                    });
                } else {
                    tl.addText(if (inl.text.len > 0) inl.text else href, .{
                        .color_text = st.body_text,
                        .font = base_font,
                    });
                }
            },
        }
    }
}

pub fn paintHeading(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const level = if (block.level == 0) 1 else block.level;
    const font = switch (level) {
        1 => dvui.Font.theme(.title),
        2 => dvui.Font.theme(.heading).larger(2),
        3 => dvui.Font.theme(.heading),
        else => dvui.Font.theme(.body).withWeight(.bold),
    };
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .color_text = ctx.style.heading_text,
        .font = font,
        .background = false,
        .padding = .{ .x = 0, .y = 2, .w = 0, .h = 2 },
    });
    defer tl.deinit();
    paintInlines(tl, block.inlines, ctx, font);
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
        });
        defer tl.deinit();
        paintInlines(tl, block.inlines, ctx, body);
        tl.addText("\n", .{});
    }
}

pub fn paintPlain(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    paintParagraph(src, block, ctx);
}
