//! Which face paints which code point (body vs emoji vs symbols). Pure — host-testable.
//!
//! Paint has no automatic per-glyph fallback across faces. Route code points to a face
//! that embeds the glyph: Noto Sans (body), OpenMoji subset (emoji), DejaVu symbols subset
//! (arrows / math / dingbats missing from Noto).
const std = @import("std");

/// True for code points that should paint with the emoji face (OpenMoji).
/// Includes ZWJ / VS / skin tones so clusters stay on one face.
///
/// Note: basic text arrows (U+2190–U+2193 → etc.) are **not** here — OpenMoji lacks
/// those code points; they go to the symbols face (DejaVu subset).
pub fn isEmojiRelated(cp: u21) bool {
    return switch (cp) {
        0x200D => true, // ZWJ
        0x20E3 => true, // combining enclosing keycap
        0xFE0E, 0xFE0F => true, // text/emoji variation selectors
        // Pictographs / emoticons / skin tones / many supplemental symbols
        0x1F000...0x1FAFF => true,
        // Emoji-style arrows OpenMoji actually ships (not U+2190–U+2193 text arrows)
        0x2194...0x2199 => true,
        0x21A9...0x21AA => true,
        // Misc Technical emoji OpenMoji actually ships. Do **not** span
        // 0x231A…0x23FA — that range includes Vitest U+23AF ⎯ (and scan lines)
        // which OpenMoji lacks; those go to isSymbolRelated + separatorLookalike.
        0x231A, 0x231B => true, // watch / hourglass
        0x2328 => true, // keyboard
        0x23CF => true, // eject
        0x23E9...0x23EF => true, // media skip / play
        0x23F0...0x23F3 => true, // clocks / timer hourglass
        0x23F8...0x23FA => true, // pause / stop / record
        0x24C2 => true,
        0x25AA...0x25FE => true,
        // Misc symbols + dingbats as emoji — except text check/ballot marks used in
        // toolTrace ("✓ ok" / "✗ failed"). OpenMoji subset lacks those glyphs; DejaVu
        // symbols has them (isSymbolRelated). Without this carve-out paint shows tofu.
        0x2600...0x2712 => true,
        0x2719...0x27BF => true,
        0x2934...0x2935 => true,
        0x2B05...0x2B55 => true,
        0x3030, 0x303D => true,
        0x3297...0x3299 => true,
        else => false,
    };
}

/// True for text symbols missing from Noto Sans body that paint with DejaVu symbols.
/// Checked **after** isEmojiRelated — emoji face wins when both could apply.
pub fn isSymbolRelated(cp: u21) bool {
    if (isEmojiRelated(cp)) return false;
    return switch (cp) {
        // Arrows (includes → U+2192 used in toolTrace / prose)
        0x2190...0x21FF => true,
        // Mathematical operators (minus, etc. when not in Noto)
        0x2200...0x22FF => true,
        // Miscellaneous technical
        0x2300...0x23FF => true,
        // Box-drawing light/heavy horizontal (report rules). Paint uses
        // separatorLookalike → U+2015 until a face embeds these CPs.
        0x2500...0x2501 => true,
        // Geometric shapes
        0x25A0...0x25FF => true,
        // Misc symbols / dingbats (only those not claimed by emoji face)
        0x2600...0x27BF => true,
        // Supplemental arrows A/B + misc arrows
        0x27F0...0x27FF => true,
        0x2900...0x297F => true,
        0x2B00...0x2BFF => true,
        else => false,
    };
}

/// Paint face for a code point.
pub const Face = enum { body, emoji, symbols };

pub fn faceFor(cp: u21) Face {
    if (isEmojiRelated(cp)) return .emoji;
    if (isSymbolRelated(cp)) return .symbols;
    return .body;
}

/// Noto body HORIZONTAL BAR — lookalike for report separators no shipped face embeds.
pub const HBAR_LOOKALIKE: u21 = 0x2015;

/// Paint-only substitute for Vitest/report separator CPs. Null = paint `cp` as usual.
/// Copy / ring bytes stay the original scalar.
pub fn separatorLookalike(cp: u21) ?u21 {
    return switch (cp) {
        0x23AF, 0x23BA...0x23BD, 0x2500, 0x2501 => HBAR_LOOKALIKE,
        else => null,
    };
}

test "isEmojiRelated covers smile and zwj" {
    try std.testing.expect(isEmojiRelated(0x1F600));
    try std.testing.expect(isEmojiRelated(0x200D));
    try std.testing.expect(isEmojiRelated(0xFE0F));
    try std.testing.expect(isEmojiRelated(0x2764));
    try std.testing.expect(isEmojiRelated(0x1F3FB));
    try std.testing.expect(!isEmojiRelated('A'));
    try std.testing.expect(!isEmojiRelated(0x00E9));
    try std.testing.expect(!isEmojiRelated(0x65E5));
}

test "text arrows route to symbols not emoji" {
    // U+2192 RIGHTWARDS ARROW — toolTrace / http_get summaries
    try std.testing.expect(!isEmojiRelated(0x2192));
    try std.testing.expect(isSymbolRelated(0x2192));
    try std.testing.expect(faceFor(0x2192) == .symbols);
    try std.testing.expect(faceFor(0x2190) == .symbols);
    try std.testing.expect(faceFor(0x2191) == .symbols);
    try std.testing.expect(faceFor(0x2193) == .symbols);
    // Double arrow ⇒
    try std.testing.expect(faceFor(0x21D2) == .symbols);
    // Latin stays body
    try std.testing.expect(faceFor('A') == .body);
    // Grin stays emoji
    try std.testing.expect(faceFor(0x1F600) == .emoji);
}

test "tool status check and ballot marks route to symbols not emoji" {
    // U+2713 CHECK MARK, U+2717 BALLOT X — summarizeToolLine status
    try std.testing.expect(!isEmojiRelated(0x2713));
    try std.testing.expect(!isEmojiRelated(0x2717));
    try std.testing.expect(isSymbolRelated(0x2713));
    try std.testing.expect(isSymbolRelated(0x2717));
    try std.testing.expect(faceFor(0x2713) == .symbols);
    try std.testing.expect(faceFor(0x2717) == .symbols);
    // Heavy variants too
    try std.testing.expect(faceFor(0x2714) == .symbols);
    try std.testing.expect(faceFor(0x2718) == .symbols);
    // Still-emoji dingbat (e.g. heavy black heart U+2764) stays emoji
    try std.testing.expect(faceFor(0x2764) == .emoji);
}

test "utf8 stress sample splits emoji from latin" {
    const grin = "\xf0\x9f\x98\x80"; // U+1F600
    const cafe = "caf\xc3\xa9"; // café
    const s = "Hi " ++ grin ++ " " ++ cafe;
    var n_emoji: usize = 0;
    var n_body: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const seq_len = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            i += 1;
            n_body += 1;
            continue;
        };
        if (i + seq_len > s.len) break;
        const cp = try std.unicode.utf8Decode(s[i .. i + seq_len]);
        if (isEmojiRelated(cp)) n_emoji += 1 else n_body += 1;
        i += seq_len;
    }
    try std.testing.expectEqual(@as(usize, 1), n_emoji);
    try std.testing.expectEqual(@as(usize, 8), n_body);
}

test "arrow in tool-style summary is symbols face" {
    const s = "http_get https://example.com/ \xe2\x86\x92 200"; // →
    var saw_sym = false;
    var i: usize = 0;
    while (i < s.len) {
        const need = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            i += 1;
            continue;
        };
        if (i + need > s.len) break;
        const cp = try std.unicode.utf8Decode(s[i .. i + need]);
        if (faceFor(cp) == .symbols) saw_sym = true;
        i += need;
    }
    try std.testing.expect(saw_sym);
}

test "vitest U+23AF and box-drawing horizontals are not emoji" {
    try std.testing.expect(!isEmojiRelated(0x23AF));
    try std.testing.expect(isSymbolRelated(0x23AF));
    try std.testing.expect(faceFor(0x23AF) == .symbols);
    try std.testing.expect(faceFor(0x2500) == .symbols);
    try std.testing.expect(faceFor(0x2501) == .symbols);
    // Watch / timer / eject stay emoji (OpenMoji has them)
    try std.testing.expect(faceFor(0x231A) == .emoji);
    try std.testing.expect(faceFor(0x23F3) == .emoji);
    try std.testing.expect(faceFor(0x23CF) == .emoji);
    // Prior carve-outs still hold
    try std.testing.expect(faceFor(0x2713) == .symbols);
    try std.testing.expect(faceFor(0x2192) == .symbols);
}

test "separatorLookalike maps report bars to U+2015; latin is null" {
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x23AF));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x23BA));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x23BB));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x23BC));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x23BD));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x2500));
    try std.testing.expectEqual(@as(?u21, 0x2015), separatorLookalike(0x2501));
    try std.testing.expectEqual(@as(?u21, null), separatorLookalike('A'));
    try std.testing.expectEqual(@as(?u21, null), separatorLookalike(0x231A));
    try std.testing.expectEqual(@as(?u21, null), separatorLookalike(0x2713));
}

test "vitest banner utf8 sample has a lookalike CP" {
    const s = "\u{23AF} Failed Tests 5 \u{23AF}";
    var n_look: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const need = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            i += 1;
            continue;
        };
        if (i + need > s.len) break;
        const cp = try std.unicode.utf8Decode(s[i .. i + need]);
        if (separatorLookalike(cp) != null) n_look += 1;
        i += need;
    }
    try std.testing.expectEqual(@as(usize, 2), n_look);
}
