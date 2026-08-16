//! Split text runs across body + emoji + symbols faces (dvui has no per-glyph fallback).
//! Emoji: OpenMoji monochrome outlines inked with Asteronica teal_accent.
//! Symbols: DejaVu subset (arrows / math / dingbats missing from Noto) at body size + body ink.
//! Report separators with no embedded glyph paint as Noto U+2015 (see separatorLookalike).
//! Zig 0.16: `utf8Decode` requires an exact one-codepoint byte slice (len 1–4).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const unicode_face = @import("unicode_face.zig");

pub const isEmojiRelated = unicode_face.isEmojiRelated;
pub const isSymbolRelated = unicode_face.isSymbolRelated;
pub const Face = unicode_face.Face;
pub const faceFor = unicode_face.faceFor;
pub const separatorLookalike = unicode_face.separatorLookalike;

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
        if (separatorLookalike(first.cp) != null) {
            // No shipped face embeds these CPs — paint Noto U+2015 (Vera/mono
            // does not have that glyph). Ring bytes stay the original scalars.
            var n: usize = 1;
            i += first.len;
            while (nextCodepoint(text, i)) |nx| {
                if (separatorLookalike(nx.cp) == null) break;
                n += 1;
                i += nx.len;
            }
            paintLookalikeRun(tl, n, base, opts);
            continue;
        }
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

/// Paint `text` on a single `base` face/ink, substituting report-separator CPs
/// (U+23AF etc., no embedded glyph) with Noto U+2015 at the surrounding size.
/// For mono / plain paths that bypass addTextMixed (diff/patch fences, plain-body
/// fallback). Lookalike is always Noto — Vera has no U+2015, so painting the
/// substitute on `base` when `base` is mono still tofus (fences / inline code).
/// Ring/Copy bytes stay the original scalars.
pub fn addTextSubstituted(
    tl: *dvui.TextLayoutWidget,
    text: []const u8,
    base: dvui.Font,
    opts: PaintOpts,
) void {
    if (text.len == 0) return;
    var i: usize = 0;
    while (i < text.len) {
        const first = nextCodepoint(text, i) orelse {
            // invalid lead — advance one byte on the base face
            i += 1;
            paintSlice(tl, text[i - 1 .. i], base, opts);
            continue;
        };
        if (separatorLookalike(first.cp) != null) {
            var n: usize = 1;
            i += first.len;
            while (nextCodepoint(text, i)) |nx| {
                if (separatorLookalike(nx.cp) == null) break;
                n += 1;
                i += nx.len;
            }
            paintLookalikeRun(tl, n, base, opts);
            continue;
        }
        const start = i;
        i += first.len;
        while (nextCodepoint(text, i)) |nc| {
            if (separatorLookalike(nc.cp) != null) break;
            i += nc.len;
        }
        paintSlice(tl, text[start..i], base, opts);
    }
}

const hbar_utf8 = "\u{2015}";

fn paintLookalikeRun(
    tl: *dvui.TextLayoutWidget,
    count: usize,
    base: dvui.Font,
    opts: PaintOpts,
) void {
    if (count == 0) return;
    // Vera (mono) and the DejaVu symbols subset do not embed U+2015; Noto body
    // does. Always paint the lookalike on Noto at the surrounding run's size
    // so fenced / inline code (base = .theme(.mono)) does not tofu.
    const font = palette.fontBody()
        .withSize(base.size)
        .withWeight(base.weight)
        .withStyle(base.style)
        .withStrike(base.strike);
    var buf: [96]u8 = undefined;
    const per = hbar_utf8.len;
    const chunk = buf.len / per;
    var left = count;
    while (left > 0) {
        const take = @min(left, chunk);
        var k: usize = 0;
        while (k < take) : (k += 1) {
            @memcpy(buf[k * per ..][0..per], hbar_utf8);
        }
        paintSlice(tl, buf[0 .. take * per], font, opts);
        left -= take;
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
