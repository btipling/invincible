//! Host unit test for queue_band.zig cancel glyph (PR #681).
//! Pins that the cancel button uses U+2715 (DejaVu symbols subset), not
//! U+00D7 (not in DejaVu subset — tofus at 40 px).
const std = @import("std");
const t = std.testing;
const queue_band = @import("ui/queue_band.zig");

test "cancel glyph is U+2715 (DejaVu subset)" {
    // queue_band.cancel_glyph must be exactly U+2715 (3 bytes UTF-8).
    const expected = "\u{2715}";
    try t.expectEqualStrings(expected, queue_band.cancel_glyph);
    try t.expectEqual(@as(usize, 3), queue_band.cancel_glyph.len);

    // U+2715 decodes correctly.
    const cp = std.unicode.utf8Decode(queue_band.cancel_glyph) catch @panic("invalid UTF-8");
    try t.expectEqual(@as(u21, 0x2715), cp);
}
