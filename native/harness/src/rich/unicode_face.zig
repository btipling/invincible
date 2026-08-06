//! Which face paints which code point (body vs emoji). Pure — host-testable.
const std = @import("std");

/// True for code points that should paint with the emoji face.
/// Includes ZWJ / VS / skin tones so clusters stay on one face.
pub fn isEmojiRelated(cp: u21) bool {
    return switch (cp) {
        0x200D => true, // ZWJ
        0x20E3 => true, // combining enclosing keycap
        0xFE0E, 0xFE0F => true, // text/emoji variation selectors
        // Pictographs / emoticons / skin tones / many supplemental symbols
        0x1F000...0x1FAFF => true,
        0x2194...0x21AA => true,
        0x231A...0x23FA => true,
        0x24C2 => true,
        0x25AA...0x25FE => true,
        0x2600...0x27BF => true,
        0x2934...0x2935 => true,
        0x2B05...0x2B55 => true,
        0x3030, 0x303D => true,
        0x3297...0x3299 => true,
        else => false,
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
