//! Sticky last-user-message chip preview helper (plan #645).
//! Pure `[]const u8` → `[]const u8` — no dvui / Wasm / bridge deps.
//! Extracted from `ui.zig` so unit tests can run on host (`test-rich`).

const std = @import("std");

/// Byte cap for the one-line truncated preview in the chip button label.
pub const LAST_USER_CHIP_PREVIEW_MAX_BYTES: usize = 100;

/// Returns true when `b` is a UTF-8 continuation byte (0x80..0xBF).
pub fn isUtf8Continuation(b: u8) bool {
    return (b & 0xC0) == 0x80;
}

/// One-line preview of a user message for the sticky last-user-message chip
/// (plan #645). Strips a leading slash command when body text follows (e.g.
/// `/skill-name explain this` → `explain this`); keeps the slash command when
/// it's the only text (e.g. just `/skill-name`). Caps at
/// `LAST_USER_CHIP_PREVIEW_MAX_BYTES` with UTF-8 boundary safety, mirroring
/// `thinkingPreview`. Returns a slice into `buf`.
pub fn chipPreview(buf: *[LAST_USER_CHIP_PREVIEW_MAX_BYTES + 1]u8, text: []const u8) []const u8 {
    // Slash-command stripping: if the message starts with '/', strip the leading
    // command when body text follows; keep the command when it's the only text.
    const body: []const u8 = if (text.len > 0 and text[0] == '/') blk: {
        if (std.mem.indexOfScalar(u8, text, ' ')) |space_idx| {
            const after = text[space_idx + 1 ..];
            if (after.len > 0) {
                var has_content = false;
                for (after) |c| {
                    if (c != ' ' and c != '\t' and c != '\n' and c != '\r') {
                        has_content = true;
                        break;
                    }
                }
                if (has_content) break :blk after;
            }
        }
        break :blk text;
    } else text;

    var out: usize = 0;
    for (body) |c| {
        if (out >= LAST_USER_CHIP_PREVIEW_MAX_BYTES) break;
        if (c == '\n' or c == '\r') break;
        buf[out] = c;
        out += 1;
    }
    // Trailing whitespace isn't part of the preview.
    while (out > 0 and (buf[out - 1] == ' ' or buf[out - 1] == '\t')) out -= 1;
    // Drop a multi-byte char truncated by the byte cap (never mojibake).
    while (out > 0 and isUtf8Continuation(buf[out - 1])) out -= 1;
    if (out > 0 and (buf[out - 1] & 0xC0) == 0xC0) out -= 1;
    return buf[0..out];
}
