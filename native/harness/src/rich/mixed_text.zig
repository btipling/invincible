//! Split text runs across body + emoji faces (dvui has no per-glyph fallback).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const unicode_face = @import("unicode_face.zig");

pub const isEmojiRelated = unicode_face.isEmojiRelated;

pub const PaintOpts = struct {
    color_text: ?dvui.Color = null,
    color_fill: ?dvui.Color = null,
};

/// Paint `text` switching between `base` and emoji face at run boundaries.
pub fn addTextMixed(
    tl: *dvui.TextLayoutWidget,
    text: []const u8,
    base: dvui.Font,
    opts: PaintOpts,
) void {
    if (text.len == 0) return;
    const emoji_font = palette.fontEmoji().withSize(base.size).withWeight(base.weight).withStyle(base.style);

    var i: usize = 0;
    while (i < text.len) {
        const start = i;
        const first_cp = std.unicode.utf8Decode(text[i..]) catch {
            i += 1;
            paintSlice(tl, text[start..i], base, opts);
            continue;
        };
        const first_len = std.unicode.utf8CodepointSequenceLength(first_cp) catch 1;
        const want_emoji = isEmojiRelated(first_cp);
        i += first_len;

        while (i < text.len) {
            const cp = std.unicode.utf8Decode(text[i..]) catch break;
            if (isEmojiRelated(cp) != want_emoji) break;
            const len = std.unicode.utf8CodepointSequenceLength(cp) catch break;
            i += len;
        }

        const slice = text[start..i];
        const font = if (want_emoji) emoji_font else base;
        paintSlice(tl, slice, font, opts);
    }
}

fn paintSlice(
    tl: *dvui.TextLayoutWidget,
    slice: []const u8,
    font: dvui.Font,
    opts: PaintOpts,
) void {
    if (slice.len == 0) return;
    var o: dvui.Options = .{ .font = font };
    if (opts.color_text) |c| o.color_text = c;
    if (opts.color_fill) |c| o.color_fill = c;
    tl.addText(slice, o);
}
