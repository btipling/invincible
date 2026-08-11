//! Orchestrate message body paint for user/assistant/thinking kinds.
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
    /// #404 physical ring slot (bridge.messageSlotAt) backing this visible index.
    /// When present the painter goes through the slot-keyed parse cache
    /// (growable, O(dirty)); absent falls back to the flat 48-entry fingerprint
    /// cache (non-ring / one-shot paints).
    slot: ?usize = null,
    /// #404 per-slot write-revision (bridge.messageRevisionAt) for dirty detect
    /// — an unchanged revision reuses the cached doc with zero re-parse/shaft.
    revision: u32 = 0,
};

pub const KIND_USER = kinds.KIND_USER;
pub const KIND_ASSISTANT = kinds.KIND_ASSISTANT;
pub const KIND_SYSTEM = kinds.KIND_SYSTEM;
pub const KIND_ERROR = kinds.KIND_ERROR;
pub const shouldPaintMarkdown = kinds.shouldPaintMarkdown;

/// Paint user/assistant/thinking MD body, or plain fallback. System/error stay plain.
pub fn paintMessageBody(src: std.builtin.SourceLocation, kind: u8, text: []const u8, opts: MessagePaintOpts) void {
    if (text.len == 0) return;

    if (!shouldPaintMarkdown(kind)) {
        paintPlainBody(src, text, opts, kind == KIND_ERROR);
        return;
    }

    // #404: slot-keyed parse cache when the caller supplies the ring slot +
    // revision (unchanged revision → cache hit → cache_layout for committed rows);
    // otherwise the flat fingerprint cache (input bytes are still scanned every
    // frame there, so it is only a fallback for non-ring paints).
    const res: cache.SlotResult = if (opts.slot) |s|
        cache.parseSlot(s, opts.revision, text)
    else
        .{ .doc = cache.parseCached(text) };
    const doc = res.doc;
    if (doc) |d| {
        // Never empty bubble: zero blocks still shows original body bytes.
        if (d.blocks.len == 0) {
            paintPlainBody(src, text, opts, false);
        } else {
            paintDocument(src, d, opts, res.hit);
        }
    } else {
        paintPlainBody(src, text, opts, false);
    }
}

pub fn paintDocument(
    src: std.builtin.SourceLocation,
    doc: *const parse.ParsedDoc,
    opts: MessagePaintOpts,
    cache_layout: bool,
) void {
    var run_seq: usize = 0;
    var ctx = paint_text.PaintCtx{
        .style = style_mod.defaultStyle(),
        .id_base = opts.msg_index *% 1024,
        .run_seq = &run_seq,
        // #404: committed rows (cache hit, revision unchanged) set DVUI
        // cache_layout so unchanged widget text stops re-shaping every frame.
        // The live row that just changed is NOT a hit → cache_layout=false
        // (DVUI cache_layout asserts a stable append-only prefix; a dirty row
        // would otherwise churn CacheLayoutError each stream frame).
        .cache_layout = cache_layout,
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
