//! Host unit tests for `composer_text.zig` (no dvui frame — runs in
//! `build.zig` `test-rich` on the self-hosted runner).

const std = @import("std");
const t = std.testing;
const composer_text = @import("composer_text.zig");
const kinds = @import("rich/kinds.zig");

var BUF: [64]u8 = undefined;

fn normalize(src: []const u8, cap: usize) composer_text.NormalizeResult {
    return composer_text.normalizeInto(src, BUF[0..], cap);
}

// ── paint-omit rule (issue #324 / plan #340) ────────────────────────────────

test "empty assistant -> omit at paint" {
    try t.expect(composer_text.shouldOmitMessageAtPaint(kinds.KIND_ASSISTANT, ""));
}

test "whitespace-only assistant -> omit at paint" {
    try t.expect(composer_text.shouldOmitMessageAtPaint(kinds.KIND_ASSISTANT, " \n\t "));
    try t.expect(composer_text.shouldOmitMessageAtPaint(kinds.KIND_ASSISTANT, "\n\n "));
}

test "non-blank assistant -> paint" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_ASSISTANT, "hello"));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_ASSISTANT, "x"));
}

test "empty/blank user -> do not omit" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_USER, ""));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_USER, "   \n"));
}

test "empty/blank system -> do not omit" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_SYSTEM, ""));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_SYSTEM, " "));
}

test "empty/blank error -> do not omit" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_ERROR, ""));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_ERROR, "\t\n"));
}

test "empty/blank thinking -> do not omit" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_THINKING, ""));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(kinds.KIND_THINKING, "  "));
}

test "unknown kind with blank text -> do not omit" {
    try t.expect(!composer_text.shouldOmitMessageAtPaint(0, ""));
    try t.expect(!composer_text.shouldOmitMessageAtPaint(99, " "));
}

test "empty input is blank and zero length" {
    const r = normalize("", 64);
    try t.expect(r.is_blank);
    try t.expectEqual(0, r.text.len);
}

test "ascii is preserved verbatim" {
    const r = normalize("hello world", 64);
    try t.expect(!r.is_blank);
    try t.expectEqualStrings("hello world", r.text);
}

test "CRLF pairs collapse to LF" {
    const r = normalize("a\r\nb\r\n\r\nc", 64);
    try t.expectEqualStrings("a\nb\n\nc", r.text);
}

test "lone CR collapses to LF" {
    const r = normalize("a\rb\rc", 64);
    try t.expectEqualStrings("a\nb\nc", r.text);
}

test "mixed CRLF and lone CR normalize to LF only" {
    const r = normalize("one\r\ntwo\rthree\nfour", 64);
    try t.expectEqualStrings("one\ntwo\nthree\nfour", r.text);
    // No \r remains at all.
    try t.expect(std.mem.indexOfScalar(u8, r.text, '\r') == null);
}

test "multiline text survives with newlines intact" {
    const src = "- bullet one\n- bullet two\n\nParagraph two.\n";
    const r = normalize(src, 64);
    try t.expectEqualStrings(src, r.text);
}

test "oversize input clamps to cap" {
    const src = "abcdefghijklmnopqrstuvwxyz";
    const r = normalize(src, 10);
    try t.expectEqual(10, r.text.len);
    try t.expectEqualStrings("abcdefghij", r.text);
    try t.expect(!r.is_blank);
}

test "clamp stops at a UTF-8 codepoint boundary, not mid-codepoint" {
    // "a" + U+00E9 (é, 2 bytes) + "c". cap=2 would split the é at its second
    // byte boundary, so the clamp must stop cleanly after the "a" (1 byte).
    const src = "a" ++ "\xc3\xa9" ++ "c";
    const r = normalize(src, 2);
    try t.expectEqual(1, r.text.len);
    try t.expectEqualStrings("a", r.text);

    // A full codepoint that fits exactly is kept.
    const keep = normalize(src, 3);
    try t.expectEqualStrings("a" ++ "\xc3\xa9", keep.text);
}

test "truncated multi-byte at end of src emits no partial sequence" {
    // "a" (valid) + first byte of a 2-byte codepoint (0xC3) with no continuation
    // byte left in `src`. The invalid tail must be dropped, not copied.
    const src = "a" ++ "\xc3";
    const r = normalize(src, 64);
    try t.expectEqual(1, r.text.len);
    try t.expectEqualStrings("a", r.text);
    try t.expect(std.mem.indexOfScalar(u8, r.text, 0xc3) == null);

    // 3-byte lead (0xE2) truncated the same way — still no partial sequence.
    const src3 = "xy" ++ "\xe2\x82";
    const r3 = normalize(src3, 64);
    try t.expectEqual(2, r3.text.len);
    try t.expectEqualStrings("xy", r3.text);
    try t.expect(std.mem.indexOfScalar(u8, r3.text, 0xe2) == null);
}

test "clamp with oversized cap keeps the whole multiline source" {
    const src = "line one\nline two\nline three";
    const r = normalize(src, 64);
    try t.expectEqualStrings(src, r.text);
}

test "CRLF pair exactly at cap boundary yields a single LF at the cap" {
    const src = "ab\r\n"; // 4 bytes, cap=3 -> "ab\n" (3 bytes)
    const r = normalize(src, 3);
    try t.expectEqual(3, r.text.len);
    try t.expectEqualStrings("ab\n", r.text);
}

test "whitespace-only input is blank" {
    try t.expect(normalize("   \n\t ", 64).is_blank);
    try t.expect(normalize(" \n \n ", 64).is_blank);
}

test "blank input does not submit even when non-empty bytes present" {
    const r = normalize("\n\n\r\n ", 64);
    try t.expect(r.is_blank);
}

test "text that is only newlines collapses to blank after LF normalization" {
    const r = normalize("\r\n\r\n", 64);
    try t.expect(r.is_blank);
    // ...but the collapsed slice is just newlines.
    try t.expectEqualStrings("\n\n", r.text);
}

test "cap=1 with leading newline keeps a single LF and is blank" {
    const r = normalize("\r\nx", 1);
    try t.expectEqual(1, r.text.len);
    try t.expectEqualStrings("\n", r.text);
    try t.expect(r.is_blank);
}

test "null byte is treated as ignorable (not visible)" {
    const src = "hi\x00there";
    const r = normalize(src, 64);
    // 0 is copied verbatim but counts as blank-neither; non-space "h" leads.
    try t.expect(!r.is_blank);
    try t.expectEqualStrings("hi\x00there", r.text);
}
