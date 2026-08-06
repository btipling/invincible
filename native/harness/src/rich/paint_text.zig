//! Paragraph / heading / list_item / deflist / plain + inline runs (style flags compose).
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const style_mod = @import("style.zig");
const mixed_text = @import("mixed_text.zig");
const palette = @import("../palette.zig");
const image_cache = @import("image_cache.zig");
const link_url = @import("link_url.zig");

/// `[^` + label≤32 + `]` fits in 36 bytes; pad for safety.
const MAX_FN_MARK: usize = 48;

pub const PaintCtx = struct {
    style: style_mod.StyleMap,
    id_base: usize,
    run_seq: *usize,
    /// Set after drawing the bar before the first footnote_def in a message.
    footnote_section_started: bool = false,
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
        .footnote_ref => dvui.Font.theme(.body).larger(-1),
        .text, .link, .image => base,
    };
    if (f.strong) font = font.withWeight(.bold);
    if (f.emph) font = font.withStyle(.italic);
    if (f.strike) font = font.withStrike(.{});
    return font;
}

fn colorFor(st: style_mod.StyleMap, kind: parse.InlineKind, f: parse.StyleFlags) dvui.Color {
    if (kind == .code) return st.code_text;
    if (kind == .link) return st.link_text;
    if (kind == .footnote_ref) return st.muted_text;
    if (f.strong) return st.strong_text;
    if (f.emph) return st.emph_text;
    return st.body_text;
}

const MAX_IMAGE_DISPLAY_H: f32 = 280.0;
const PLACEHOLDER_MIN_H: f32 = 24.0;

fn hasImageInline(inlines: []const parse.Inline) bool {
    for (inlines) |inl| {
        if (inl.kind == .image) return true;
    }
    return false;
}

/// Paint flat non-image inline runs into an open TextLayout.
/// Emoji code points switch to OpenMoji (see mixed_text.zig).
/// `.image` is ignored here — use `paintInlineFlow`.
pub fn paintInlines(tl: *dvui.TextLayoutWidget, inlines: []const parse.Inline, ctx: *const PaintCtx, base_font: dvui.Font) void {
    const st = ctx.style;
    for (inlines) |inl| {
        if (inl.kind == .image) continue;
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
            .footnote_ref => {
                // Display as [label] (no caret) — source still uses [^label].
                var mark_buf: [MAX_FN_MARK]u8 = undefined;
                const mark = std.fmt.bufPrint(&mark_buf, "[{s}]", .{inl.text}) catch inl.text;
                mixed_text.addTextMixed(tl, mark, font, .{ .color_text = st.muted_text });
            },
            .image => {},
        }
    }
}

fn paintImageInline(src: std.builtin.SourceLocation, inl: parse.Inline, ctx: *PaintCtx) void {
    const href = inl.href orelse "";
    const alt = if (inl.text.len > 0) inl.text else "(image)";

    if (href.len == 0 or !link_url.isSafeLinkUrl(href)) {
        paintImagePlaceholder(src, alt, ctx);
        return;
    }
    if (image_cache.get(href)) |hit| {
        // Desired paint size from natural pixels with aspect preserved.
        // Do **not** expand=.horizontal — that forces full column width while
        // height stays natural and stretches the texture into a panoramic strip.
        const nw: f32 = @floatFromInt(hit.width);
        const nh: f32 = @floatFromInt(hit.height);
        var dw = nw;
        var dh = nh;
        if (dh > MAX_IMAGE_DISPLAY_H and dh > 0) {
            const s = MAX_IMAGE_DISPLAY_H / dh;
            dw *= s;
            dh = MAX_IMAGE_DISPLAY_H;
        }
        // Fit column width (transcript content / ~390) without upscaling.
        const parent_w = dvui.parentGet().data().contentRect().w;
        if (parent_w > 1 and dw > parent_w) {
            const s = parent_w / dw;
            dw = parent_w;
            dh *= s;
        }
        // Never request a zero edge (dvui placeIn ratio divides by size).
        if (dw < 1) dw = 1;
        if (dh < 1) dh = 1;
        _ = dvui.image(src, .{
            .source = .{
                .pixels = .{
                    .rgba = hit.rgba,
                    .width = hit.width,
                    .height = hit.height,
                    .interpolation = .linear,
                    .invalidation = .ptr,
                },
            },
            // Safety net if layout avail is smaller than min (first frame / nest).
            .shrink = .ratio,
        }, .{
            // Natural (capped) size only — never stretch to column width.
            .expand = .none,
            .id_extra = nextId(ctx),
            .min_size_content = .{ .w = dw, .h = dh },
            .max_size_content = .{ .w = dw, .h = dh },
            .margin = .{ .x = 0, .y = 2, .w = 0, .h = 2 },
            .label = .{ .text = alt },
            .background = false,
        });
        return;
    }
    paintImagePlaceholder(src, alt, ctx);
}

fn paintImagePlaceholder(src: std.builtin.SourceLocation, alt: []const u8, ctx: *PaintCtx) void {
    const st = ctx.style;
    var box = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = true,
        .color_fill = st.code_fill,
        .color_border = st.code_border,
        .border = .all(1),
        .min_size_content = .{ .w = 40, .h = PLACEHOLDER_MIN_H },
        .margin = .{ .x = 0, .y = 2, .w = 0, .h = 2 },
        .padding = .{ .x = 6, .y = 4, .w = 6, .h = 4 },
    });
    defer box.deinit();
    var tl = dvui.textLayout(@src(), .{}, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .color_text = st.muted_text,
        .font = dvui.Font.theme(.body).larger(-1),
        .background = false,
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
    });
    defer tl.deinit();
    const label = if (alt.len > 0) alt else "(image)";
    mixed_text.addTextMixed(tl, label, dvui.Font.theme(.body).larger(-1), .{ .color_text = st.muted_text });
}

const TextLayoutOpts = struct {
    expand: dvui.Options.Expand = .horizontal,
    padding: dvui.Rect = .{ .x = 0, .y = 1, .w = 0, .h = 2 },
    color_text: ?dvui.Color = null,
};

/// Paint inlines with optional images via segmented vertical flow (locked plan).
pub fn paintInlineFlow(
    src: std.builtin.SourceLocation,
    inlines: []const parse.Inline,
    ctx: *PaintCtx,
    base_font: dvui.Font,
    layout: TextLayoutOpts,
) void {
    const default_color = layout.color_text orelse ctx.style.body_text;
    if (!hasImageInline(inlines)) {
        var tl = dvui.textLayout(src, .{}, .{
            .expand = layout.expand,
            .id_extra = nextId(ctx),
            .color_text = default_color,
            .font = base_font,
            .background = false,
            .padding = layout.padding,
        });
        defer tl.deinit();
        paintInlines(tl, inlines, ctx, base_font);
        tl.addText("\n", .{});
        return;
    }

    var col = dvui.box(src, .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
        .margin = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
    });
    defer col.deinit();

    var i: usize = 0;
    while (i < inlines.len) {
        if (inlines[i].kind == .image) {
            paintImageInline(@src(), inlines[i], ctx);
            i += 1;
            continue;
        }
        const start = i;
        while (i < inlines.len and inlines[i].kind != .image) : (i += 1) {}
        const slice = inlines[start..i];
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = layout.expand,
            .id_extra = nextId(ctx),
            .color_text = default_color,
            .font = base_font,
            .background = false,
            .padding = layout.padding,
        });
        defer tl.deinit();
        paintInlines(tl, slice, ctx, base_font);
        if (i >= inlines.len) tl.addText("\n", .{});
    }
}

pub fn paintHeading(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const level = if (block.level == 0) 1 else block.level;
    // Strict size ladder (DefaultSize=10 in palette): H1>H2>H3>H4≥H5>H6.
    // title is already DefaultSize+2; heading/body share DefaultSize (heading is bold only).
    // H1 was plain title and H2 heading.larger(2) → both 12px. H3 plain heading == H4 body.bold.
    const font = switch (level) {
        1 => dvui.Font.theme(.title).larger(2), // 14
        2 => dvui.Font.theme(.heading).larger(2), // 12
        3 => dvui.Font.theme(.heading).larger(1), // 11
        4 => dvui.Font.theme(.body).withWeight(.bold), // 10
        5 => dvui.Font.theme(.body), // 10 muted
        // No Font.smaller on this dvui pin — larger(-N) steps down from body.
        else => dvui.Font.theme(.body).larger(-2), // 8 whisper
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
    // Segmented flow so ![alt](url) in headings paints (paintInlines skips .image).
    paintInlineFlow(src, block.inlines, &heading_ctx, font, .{
        .padding = .{ .x = 0, .y = 2, .w = 0, .h = 2 },
        .color_text = color,
    });
}

pub fn paintParagraph(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    // Primary MD image path is paragraph inlines — must use paintInlineFlow.
    paintInlineFlow(src, block.inlines, ctx, body, .{
        .padding = .{ .x = 0, .y = 1, .w = 0, .h = 2 },
        .color_text = ctx.style.body_text,
    });
}

/// Cumulative left margin clamp for list/quote nest + indent_cols (~390px safety).
const MAX_LEFT_MARGIN: f32 = 96.0;

fn clampMargin(x: f32) f32 {
    return @min(x, MAX_LEFT_MARGIN);
}

/// Display-only task checkbox (non-interactive). Uses palette TEAL tokens only.
/// Not `dvui.checkbox` / `dvui.checkmark` defaults — those use a ~1px inset "border"
/// (`rs.s`) that vanishes on dark Asteronica bg. We stroke a real 2px ring instead.
fn paintTaskCheckbox(src: std.builtin.SourceLocation, is_checked: bool, body: dvui.Font, ctx: *PaintCtx) void {
    // Optical size under body height; gap to label via margin (not baked into draw rect).
    const check_size = @max(14.0, body.textHeight() * 0.88);
    // Body textLayout ends with "\n" so the row is ~2 line-boxes tall. gravity_y=0.5
    // centers the box in *that* full height (looks high/low vs the label). Top-align and
    // nudge to the vertical center of the *first* line only (same band as bullet glyphs).
    const line_h = body.lineHeight();
    const y_off = @max(0.0, (line_h - check_size) * 0.5);
    const box_wd = dvui.spacer(src, .{
        .id_extra = nextId(ctx),
        .min_size_content = .{ .w = check_size, .h = check_size },
        .margin = .{ .x = 0, .y = y_off, .w = 8, .h = 0 },
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
        .gravity_y = 0,
        .tab_index = 0,
        .background = false,
    });
    if (!box_wd.visible()) return;

    const rs = box_wd.contentRectScale();
    const corners = dvui.CornerRect.round(2.5).scale(rs.s, dvui.CornerRect.Physical);
    // 2 natural-px stroke — readable muted ring on teal_bg (checkmark's 1px was not).
    const border_t = 2.0 * rs.s;

    if (is_checked) {
        rs.r.fill(corners, .{ .color = palette.teal_accent, .fade = 1.0 });
        // Check stroke (same geometry as dvui.checkmark) in dark ink on accent fill.
        const r = rs.r.insetAll(0.5 * rs.s);
        const pad = @max(1.0, r.w / 6.0);
        var thick = @max(1.5 * rs.s, r.w / 5.0);
        const size = r.w - (thick / 2.0) - pad * 2.0;
        const third = size / 3.0;
        const x = r.x + pad + (0.25 * thick) + third;
        const y = r.y + pad + (0.25 * thick) + size - (third * 0.5);
        thick /= 1.5;
        const path: dvui.Path = .{ .points = &.{
            .{ .x = x - third, .y = y - third },
            .{ .x = x, .y = y },
            .{ .x = x + third * 2.0, .y = y - third * 2.0 },
        } };
        path.stroke(.{
            .thickness = thick,
            .color = palette.teal_bg,
            .endcap_style = .square,
        });
    } else {
        rs.r.stroke(corners, .{
            .thickness = border_t,
            .color = palette.teal_muted,
        });
    }
}

/// Parse list_item.meta: "u" → bullet; "o,{n}" → ordered number (1–99) else "· ".
fn listMarkerText(meta: ?[]const u8, buf: *[8]u8) []const u8 {
    const m = meta orelse return "• ";
    if (m.len >= 3 and m[0] == 'o' and m[1] == ',') {
        const n = std.fmt.parseInt(u16, m[2..], 10) catch return "· ";
        if (n == 0 or n > 99) return "· ";
        return std.fmt.bufPrint(buf, "{d}. ", .{n}) catch "· ";
    }
    return "• ";
}

pub fn paintListItem(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    const depth: f32 = @floatFromInt(@min(block.level, 6));
    const indent_cols_px: f32 = @as(f32, @floatFromInt(block.indent_cols)) * 8.0;
    const quote_nest: f32 = if (block.quote_depth > 0)
        @as(f32, @floatFromInt(@min(block.quote_depth -| 1, 6))) * 10.0
    else
        0.0;
    const indent: f32 = clampMargin(8.0 + depth * 10.0 + indent_cols_px + quote_nest);
    // textLayout defaults pad 6px — must zero both marker and body or the bullet sits high.
    const zero_pad = dvui.Rect{ .x = 0, .y = 0, .w = 0, .h = 0 };
    const in_quote = block.quote_depth > 0;

    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
        .margin = .{ .x = indent, .y = 0, .w = 0, .h = 1 },
    });
    defer row.deinit();

    if (in_quote) {
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

    if (block.checked) |is_checked| {
        paintTaskCheckbox(@src(), is_checked, body, ctx);
    } else {
        var marker_buf: [8]u8 = undefined;
        const marker = listMarkerText(block.meta, &marker_buf);
        const marker_color = if (in_quote) ctx.style.quote_text else ctx.style.bullet_text;
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .id_extra = nextId(ctx),
                .color_text = marker_color,
                .font = body,
                .background = false,
                .padding = .{ .x = 0, .y = 0, .w = 4, .h = 0 },
            });
            defer tl.deinit();
            tl.addText(marker, .{ .color_text = marker_color, .font = body });
        }
    }

    var body_style = ctx.style;
    if (in_quote) body_style.body_text = ctx.style.quote_text;
    var body_ctx = PaintCtx{
        .style = body_style,
        .id_base = ctx.id_base,
        .run_seq = ctx.run_seq,
    };
    const body_color = if (in_quote) ctx.style.quote_text else ctx.style.body_text;
    paintInlineFlow(@src(), block.inlines, &body_ctx, body, .{
        .padding = zero_pad,
        .color_text = body_color,
    });
}


pub fn paintBlockquote(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    const body = dvui.Font.theme(.body);
    const level: u8 = if (block.level == 0) 1 else block.level;
    const depth: f32 = @floatFromInt(@min(level -| 1, 6));
    const indent_cols_px: f32 = @as(f32, @floatFromInt(block.indent_cols)) * 8.0;
    const indent: f32 = clampMargin(8.0 + depth * 10.0 + indent_cols_px);
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

    paintInlineFlow(@src(), block.inlines, &quote_ctx, body, .{
        .padding = zero_pad,
        .color_text = ctx.style.quote_text,
    });
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

pub fn paintFootnoteDef(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    // One section bar before the first def in this message.
    if (!ctx.footnote_section_started) {
        ctx.footnote_section_started = true;
        paintThematicBreak(src, .{ .kind = .thematic_break, .inlines = &.{} }, ctx);
    }
    const body = dvui.Font.theme(.body);
    const mark_font = body.larger(-1);
    const label = block.meta orelse "";
    var mark_buf: [MAX_FN_MARK]u8 = undefined;
    const mark = std.fmt.bufPrint(&mark_buf, "[{s}]: ", .{label}) catch "[?]: ";
    var col = dvui.box(src, .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
    });
    defer col.deinit();
    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .id_extra = nextId(ctx),
            .color_text = ctx.style.muted_text,
            .font = mark_font,
            .background = false,
            .padding = .{ .x = 0, .y = 1, .w = 0, .h = 0 },
        });
        defer tl.deinit();
        mixed_text.addTextMixed(tl, mark, mark_font, .{ .color_text = ctx.style.muted_text });
    }
    paintInlineFlow(@src(), block.inlines, ctx, body, .{
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 2 },
        .color_text = ctx.style.muted_text,
    });
}


pub fn paintDefTerm(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    // Term: body face bold, body ink, tight bottom gap before defs.
    const body = dvui.Font.theme(.body).withWeight(.bold);
    paintInlineFlow(src, block.inlines, ctx, body, .{
        .padding = .{ .x = 0, .y = 2, .w = 0, .h = 0 },
        .color_text = ctx.style.body_text,
    });
}

pub fn paintDefDesc(src: std.builtin.SourceLocation, block: parse.Block, ctx: *PaintCtx) void {
    // Definition: ~16px indent via box margin; body_text only → muted (blockquote pattern).
    const body = dvui.Font.theme(.body);
    var desc_style = ctx.style;
    desc_style.body_text = ctx.style.muted_text;
    var desc_ctx = PaintCtx{
        .style = desc_style,
        .id_base = ctx.id_base,
        .run_seq = ctx.run_seq,
    };
    var row = dvui.box(src, .{ .dir = .horizontal }, .{
        .expand = .horizontal,
        .id_extra = nextId(ctx),
        .background = false,
        .margin = .{ .x = 16, .y = 0, .w = 0, .h = 2 },
    });
    defer row.deinit();
    paintInlineFlow(@src(), block.inlines, &desc_ctx, body, .{
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 1 },
        .color_text = ctx.style.muted_text,
    });
}
