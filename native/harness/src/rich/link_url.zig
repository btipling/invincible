//! http(s) link allowlist for rich transcript (no dvui dep).
const std = @import("std");

/// http(s) only — reject javascript:, data:, relative, etc.
pub fn isSafeLinkUrl(url: []const u8) bool {
    if (url.len < 8) return false;
    if (startsWithIgnoreCase(url, "https://")) return true;
    if (startsWithIgnoreCase(url, "http://")) return true;
    return false;
}

fn startsWithIgnoreCase(hay: []const u8, needle: []const u8) bool {
    if (hay.len < needle.len) return false;
    var i: usize = 0;
    while (i < needle.len) : (i += 1) {
        const a = hay[i];
        const b = needle[i];
        const al: u8 = if (a >= 'A' and a <= 'Z') a + 32 else a;
        const bl: u8 = if (b >= 'A' and b <= 'Z') b + 32 else b;
        if (al != bl) return false;
    }
    return true;
}

test "isSafeLinkUrl allowlist" {
    try std.testing.expect(isSafeLinkUrl("https://example.com"));
    try std.testing.expect(isSafeLinkUrl("http://example.com/x"));
    try std.testing.expect(isSafeLinkUrl("HTTPS://EXAMPLE.COM"));
    try std.testing.expect(!isSafeLinkUrl("javascript:alert(1)"));
    try std.testing.expect(!isSafeLinkUrl("data:text/html,hi"));
    try std.testing.expect(!isSafeLinkUrl(""));
    try std.testing.expect(!isSafeLinkUrl("/relative"));
    try std.testing.expect(!isSafeLinkUrl("ftp://x"));
}
