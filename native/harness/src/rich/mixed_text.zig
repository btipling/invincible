//! Split text runs across body + emoji faces (dvui has no per-glyph fallback).
//! Zig 0.16: `utf8Decode` requires an exact one-codepoint byte slice (len 1–4).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const unicode_face = @import("unicode_face.zig");

pub const isEmojiRelated = unicode_face.isEmojiRelated;

pub const PaintOpts = struct {
    color_text: ?dvui.Color = null,
    color_fill: ?dvui.Color = null,
};

/// Decode one code point at `i`. Returns null on invalid/incomplete.
fn nextCodepoint(text: []const u8, i: usize) ?struct { cp: u21, len: usize } {
    if (i >= text.len) return null;
    const need = std.unicode.utf8ByteSequenceLength(text[i]) catch return null;
    if (i + need > text.len) return null;
    const cp = std.unicode.utf8Decode(text[i .. i + need]) catch return null;
    return .{ .cp = cp, .len = need };
}

/// Paint `text` switching between `base` and emoji face at run boundaries.
pub fn addTextMixed(
    tl: *dvui.TextLayoutWidget,
    text: []const u8,
    base: dvui.Font,
    opts: PaintOpts,
) void {
    if (text.len == 0) return;
    // OpenMoji outlines need more px than Noto body at the same nominal size.
    const emoji_size = base.size * palette.emoji_size_scale;
    const emoji_font = palette.fontEmoji()
        .withSize(emoji_size)
        .withWeight(base.weight)
        .withStyle(base.style)
        .withLineHeight(1.0); // size already enlarged; don't double vertical gap

    var i: usize = 0;
    while (i < text.len) {
        const start = i;
        const first = nextCodepoint(text, i) orelse {
            // invalid lead — advance 1 byte on body face
            i += 1;
            paintSlice(tl, text[start..i], base, opts);
            continue;
        };
        const want_emoji = isEmojiRelated(first.cp);
        i += first.len;

        while (nextCodepoint(text, i)) |n| {
            if (isEmojiRelated(n.cp) != want_emoji) break;
            i += n.len;
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
