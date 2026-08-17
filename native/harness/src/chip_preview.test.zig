//! Host unit tests for `chip_preview.zig` (plan #645 review L6).
//! Pure `[]const u8` → `[]const u8` — no dvui, no Wasm frame.
//! Each test owns its preview buffer so the returned slice always points at
//! memory that outlives the helper call.

const std = @import("std");
const t = std.testing;
const chip_preview = @import("chip_preview.zig");

const BUF_LEN = chip_preview.LAST_USER_CHIP_PREVIEW_MAX_BYTES + 1;

fn preview(buf: []u8, text: []const u8) []const u8 {
    const p: *[BUF_LEN]u8 = buf[0..BUF_LEN];
    return chip_preview.chipPreview(p, text);
}

test "slash+body strips leading slash command" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("explain this", preview(&buf, "/skill-name explain this"));
}

test "slash-only keeps the slash command" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("/skill-name", preview(&buf, "/skill-name"));
}

test "slash with only whitespace after keeps the slash command" {
    var buf: [BUF_LEN]u8 = undefined;
    // Trailing whitespace is always stripped; the slash command is kept because
    // the text after the first space is all whitespace (no body content).
    try t.expectEqualStrings("/skill-name", preview(&buf, "/skill-name  "));
    try t.expectEqualStrings("/skill-name", preview(&buf, "/skill-name\t"));
}

test "no slash — normal text passes through unchanged" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("hello world", preview(&buf, "hello world"));
    try t.expectEqualStrings("what is the weather?", preview(&buf, "what is the weather?"));
}

test "empty input returns empty" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("", preview(&buf, ""));
}

test "newline at start returns empty (first char is \\n, stop-at-newline fires)" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("", preview(&buf, "\nmore text"));
}

test "newline terminates preview" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("first line", preview(&buf, "first line\nsecond line"));
    try t.expectEqualStrings("before cr", preview(&buf, "before cr\rafter cr"));
}

test "trailing whitespace stripped" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("hello", preview(&buf, "hello   "));
    try t.expectEqualStrings("hello", preview(&buf, "hello\t\t"));
}

test "UTF-8 multi-byte char truncated at byte cap — backs off to codepoint boundary" {
    var buf: [BUF_LEN]u8 = undefined;
    // Build a string that is exactly 99 ASCII bytes + a 2-byte UTF-8 char (© = 0xC2 0xA9).
    // The byte cap is 100, so the copy loop writes bytes 0..99 (100 bytes),
    // then the UTF-8 back-off drops the leading byte 0xC2, leaving 99 clean bytes.
    var input: [101]u8 = undefined;
    @memset(&input, 'a');
    input[99] = 0xC2; // leading byte of ©
    input[100] = 0xA9; // continuation byte
    const result = preview(&buf, &input);
    // Should be exactly 99 'a' bytes — the '©' was dropped.
    try t.expectEqual(@as(usize, 99), result.len);
    for (result) |c| try t.expectEqual(@as(u8, 'a'), c);
}

test "slash command + body with leading whitespace strips correctly" {
    var buf: [BUF_LEN]u8 = undefined;
    // After `/cmd ` the remaining text is `  hello`. The has_content scan finds
    // non-whitespace ('h'), so the command is stripped. Leading whitespace in
    // the body IS preserved (unlike trailing whitespace which is trimmed).
    // Result: `  hello` stripped of trailing ws → `  hello`.
    try t.expectEqualStrings("  hello", preview(&buf, "/cmd   hello"));
}
