//! Host unit tests for `queue_preview.zig` (plan #664).
const std = @import("std");
const t = std.testing;
const qp = @import("queue_preview.zig");

const BUF_LEN = qp.QUEUE_PREVIEW_MAX_BYTES + 1;

fn preview(buf: []u8, text: []const u8) []const u8 {
    const p: *[BUF_LEN]u8 = buf[0..BUF_LEN];
    return qp.queuePreview(p, text);
}

test "keeps slash+body (does not strip)" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("/skill-name explain this", preview(&buf, "/skill-name explain this"));
}

test "first line only" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("hello", preview(&buf, "hello\nworld"));
}

test "empty" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("", preview(&buf, ""));
}

test "newline at start returns empty" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("", preview(&buf, "\nmore"));
}

test "caps at 100 bytes UTF-8 safe" {
    var buf: [BUF_LEN]u8 = undefined;
    var long: [120]u8 = undefined;
    @memset(long[0..], 'a');
    const got = preview(&buf, &long);
    try t.expectEqual(@as(usize, qp.QUEUE_PREVIEW_MAX_BYTES), got.len);
}

test "UTF-8 back-off does not split a codepoint" {
    var buf: [BUF_LEN]u8 = undefined;
    // Build a string >100 bytes where byte 100 (the cap boundary) falls in
    // the middle of a 3-byte UTF-8 codepoint (€ = 0xE2 0x82 0xAC).
    // 33 × "ab" = 66 bytes → then pad with € (3 bytes each).
    // 66 + 11×3 + 1 = 66+33+1 = 100; byte index 100 is the 2nd byte of
    // the 12th €, which is a continuation byte (0x82). The back-off must
    // strip back to byte 99 (end of the 11th complete €).
    var src: [120]u8 = [_]u8{'a'} ** 120;
    var pos: usize = 0;
    // 33 × "ab" = 66 one-byte chars
    var j: usize = 0;
    while (j < 33) : (j += 1) {
        src[pos] = 'a';
        pos += 1;
        src[pos] = 'b';
        pos += 1;
    }
    // pad with € (U+20AC = 0xE2 0x82 0xAC, 3 bytes) until >100 bytes
    while (pos < 110) : (pos += 3) {
        src[pos] = 0xE2;
        src[pos + 1] = 0x82;
        src[pos + 2] = 0xAC;
    }
    const got = preview(&buf, src[0..]);
    try t.expect(got.len <= qp.QUEUE_PREVIEW_MAX_BYTES);
    // The last byte of the preview must not be a UTF-8 start byte (0b11xxxxxx
    // = 0xC0..0xFF) or a continuation byte (0b10xxxxxx = 0x80..0xBF) — it
    // must be a complete single-byte ASCII or the last byte of a complete
    // multi-byte sequence. In practice the 100th byte is a continuation byte
    // of €, so back-off strips to 99 (end of the previous full €), which is
    // 0xAC — the trailing byte of a complete 3-byte sequence — which passes
    // the start-byte check.
    if (got.len > 0) {
        try t.expect((got[got.len - 1] & 0xC0) != 0xC0);
    }
}
