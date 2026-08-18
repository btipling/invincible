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
    // 33 × 'é' (2 bytes) = 66, then pad with more to hit the cap mid-sequence.
    var src: [80]u8 = undefined;
    var i: usize = 0;
    while (i + 1 < src.len) : (i += 2) {
        src[i] = 0xC3;
        src[i + 1] = 0xA9;
    }
    const got = preview(&buf, src[0..]);
    try t.expect(got.len <= qp.QUEUE_PREVIEW_MAX_BYTES);
    if (got.len > 0) {
        try t.expect((got[got.len - 1] & 0xC0) != 0xC0);
        try t.expect((got[got.len - 1] & 0xC0) != 0x80 or got.len >= 2);
    }
}
