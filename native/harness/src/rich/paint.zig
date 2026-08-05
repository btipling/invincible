//! Orchestrate message body paint for user/assistant kinds.
const std = @import("std");
const dvui = @import("dvui");
const parse = @import("parse.zig");
const cache = @import("cache.zig");
const style_mod = @import("style.zig");
const paint_text = @import("paint_text.zig");
const registry = @import("registry.zig");
const kinds = @import("kinds.zig");

pub const MessagePaintOpts = struct {
    /// Visible ring index (0..n) used for id_extra base: msg_index * 1024.
    msg_index: usize = 0,
};

pub const KIND_USER = kinds.KIND_USER;
pub const KIND_ASSISTANT = kinds.KIND_ASSISTANT;
pub const KIND_SYSTEM = kinds.KIND_SYSTEM;
pub const KIND_ERROR = kinds.KIND_ERROR;
pub const shouldPaintMarkdown = kinds.shouldPaintMarkdown;

/// Paint user/assistant MD body, or plain fallback. System/error callers should
/// keep their existing plain path; this still plain-paints if kind is not MD.
pub fn paintMessageBody(src: std.builtin.SourceLocation, kind: u8, text: []const u8, opts: MessagePaintOpts) void {
    if (text.len == 0) return;

    if (!shouldPaintMarkdown(kind)) {
        paintPlainBody(src, text, opts, kind == KIND_ERROR);
        return;
    }

    const doc = cache.parseCached(text);
    if (doc) |d| {
        // Never empty bubble: zero blocks still shows original body bytes.
        if (d.blocks.len == 0) {
            paintPlainBody(src, text, opts, false);
        } else {
            paintDocument(src, d, opts);
        }
    } else {
        paintPlainBody(src, text, opts, false);
    }
}

pub fn paintDocument(src: std.builtin.SourceLocation, doc: *const parse.ParsedDoc, opts: MessagePaintOpts) void {
    var run_seq: usize = 0;
    var ctx = paint_text.PaintCtx{
        .style = style_mod.defaultStyle(),
        .id_base = opts.msg_index *% 1024,
        .run_seq = &run_seq,
    };

    var col = dvui.box(src, .{ .dir = .vertical }, .{
        .expand = .horizontal,
        .id_extra = paint_text.nextIdPublic(&ctx),
        .background = false,
        .padding = .{ .x = 0, .y = 0, .w = 0, .h = 0 },
    });
    defer col.deinit();

    for (doc.blocks) |block| {
        registry.paintBlock(@src(), block, &ctx);
    }
}

fn paintPlainBody(src: std.builtin.SourceLocation, text: []const u8, opts: MessagePaintOpts, is_err: bool) void {
    const st = style_mod.defaultStyle();
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = opts.msg_index *% 1024,
        .color_text = if (is_err) @import("../palette.zig").ember_text else st.body_text,
        .font = .theme(.body),
        .background = false,
    });
    defer tl.deinit();
    if (text.len > 0) tl.addText(text, .{});
}
