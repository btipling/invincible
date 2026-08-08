//! Split text runs across body + emoji + symbols faces (dvui has no per-glyph fallback).
//! Emoji: OpenMoji monochrome outlines inked with Asteronica teal_accent.
//! Symbols: DejaVu subset (arrows / math / dingbats missing from Noto) at body size + body ink.
//! Zig 0.16: `utf8Decode` requires an exact one-codepoint byte slice (len 1–4).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const unicode_face = @import("unicode_face.zig");

pub const isEmojiRelated = unicode_face.isEmojiRelated;
pub const isSymbolRelated = unicode_face.isSymbolRelated;
pub const Face = unicode_face.Face;
pub const faceFor = unicode_face.faceFor;

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

/// Paint `text` switching faces at run boundaries (emoji / symbols / body).
pub fn addTextMixed(
    tl: *dvui.TextLayoutWidget,
    text: []const u8,
    base: dvui.Font,
    opts: PaintOpts,
) void {
    if (text.len == 0) return;
    // OpenMoji outlines need more px than Noto body at the same nominal size.
    const emoji_size = base.size * palette.emoji_size_scale;
    // Forward weight/style/strike from the styled base run so bold/italic/strike
    // compose across emoji splits the same as body text.
    const emoji_font = palette.fontEmoji()
        .withSize(emoji_size)
        .withWeight(base.weight)
        .withStyle(base.style)
        .withStrike(base.strike)
        .withLineHeight(1.0); // size already enlarged; don't double vertical gap
    const symbols_font = palette.fontSymbols()
        .withSize(base.size)
        .withWeight(base.weight)
        .withStyle(base.style)
        .withStrike(base.strike);

    var i: usize = 0;
    while (i < text.len) {
        const start = i;
        const first = nextCodepoint(text, i) orelse {
            // invalid lead — advance 1 byte on body face
            i += 1;
            paintSlice(tl, text[start..i], base, opts);
            continue;
        };
        const want = faceFor(first.cp);
        i += first.len;

        while (nextCodepoint(text, i)) |n| {
            if (faceFor(n.cp) != want) break;
            i += n.len;
        }

        const slice = text[start..i];
        switch (want) {
            .emoji => {
                // Monochrome OpenMoji, always Asteronica teal (not body/link/error ink).
                paintSlice(tl, slice, emoji_font, .{
                    .color_text = palette.emoji_ink,
                    .color_fill = opts.color_fill,
                });
            },
            .symbols => {
                // DejaVu symbols — body size and caller ink (tool lines, prose arrows).
                paintSlice(tl, slice, symbols_font, opts);
            },
            .body => paintSlice(tl, slice, base, opts),
        }
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
