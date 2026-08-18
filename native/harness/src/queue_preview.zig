//! First-line preview for a queued operator prompt (plan #664).
//! Pure — no dvui / slash-stripping. Host-unit-tested via `test-rich`.

const std = @import("std");

pub const QUEUE_PREVIEW_MAX_BYTES: usize = 100;

fn isUtf8Continuation(b: u8) bool {
    return (b & 0xC0) == 0x80;
}

/// First line of `text`, capped at `QUEUE_PREVIEW_MAX_BYTES`, UTF-8 safe.
/// Does **not** strip a leading `/slash` (queued prompts are operator text).
pub fn queuePreview(buf: *[QUEUE_PREVIEW_MAX_BYTES + 1]u8, text: []const u8) []const u8 {
    var out: usize = 0;
    for (text) |c| {
        if (out >= QUEUE_PREVIEW_MAX_BYTES) break;
        if (c == '\n' or c == '\r') break;
        buf[out] = c;
        out += 1;
    }
    while (out > 0 and (buf[out - 1] == ' ' or buf[out - 1] == '\t')) out -= 1;
    while (out > 0 and isUtf8Continuation(buf[out - 1])) out -= 1;
    if (out > 0 and (buf[out - 1] & 0xC0) == 0xC0) out -= 1;
    return buf[0..out];
}
