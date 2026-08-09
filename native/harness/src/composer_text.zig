//! Pure composer-text normalization for the Wasm harness composer.
//!
//! No dvui / bridge frame here: this module is host unit-tested on the
//! self-hosted runner (see `build.zig` `test-rich`, like the rest of `rich/*`).
//!
//! Contract (locked in plan #334):
//!   - Every submitted prompt is LF-only (CRLF and lone CR from a paste are
//!     normalized to LF), so the model/host never sees platform line breaks.
//!   - Total byte length is clamped to the submit cap (`bridge.SUBMIT_CAP`)
//!     at a UTF-8 codepoint boundary — never a truncated/partial codepoint.
//!   - A result that is blank (empty or only whitespace/newlines) is rejected
//!     by the caller (preserves the existing empty-send guard).

const std = @import("std");

pub const NormalizeResult = struct {
    /// Normalized bytes within `dest` (caller-owned). `len <= cap`.
    text: []const u8,
    /// True when `text` is empty or collapses to whitespace/newlines.
    is_blank: bool,
};

/// Normalize `src` into `dest[:cap]` at UTF-8 boundaries.
/// Caller must guarantee `dest.len >= cap`.
///
/// In-place use is safe because normalized output length never exceeds the
/// consumed input length at any point (CRLF `2 -> 1`, lone CR `1 -> 1`,
/// ordinary bytes `1 -> 1`), so we never overwrite unread input.
pub fn normalizeInto(src: []const u8, dest: []u8, cap: usize) NormalizeResult {
    std.debug.assert(dest.len >= cap);

    var out_len: usize = 0;
    var i: usize = 0;

    while (i < src.len and out_len < cap) {
        const b = src[i];

        if (b == '\r') {
            // CRLF -> LF; lone CR -> LF.
            i += if (i + 1 < src.len and src[i + 1] == '\n') 2 else 1;
            if (out_len < cap) {
                dest[out_len] = '\n';
                out_len += 1;
            }
            continue;
        }

        // Ordinary byte: copy a whole UTF-8 sequence (only if it fits `cap`).
        const seq_len = std.unicode.utf8ByteSequenceLength(b) catch 1;
        if (out_len + seq_len > cap) break;
        const n = @min(seq_len, src.len - i);
        @memcpy(dest[out_len..][0..n], src[i..][0..n]);
        out_len += n;
        i += n;
    }

    const text = dest[0..out_len];
    return .{ .text = text, .is_blank = isBlank(text) };
}

/// True when `s` collapses to nothing visible (empty or whitespace/newlines).
pub fn isBlank(s: []const u8) bool {
    for (s) |c| {
        switch (c) {
            '\n', '\r', ' ', '\t', 0 => {},
            else => return false,
        }
    }
    return true;
}
