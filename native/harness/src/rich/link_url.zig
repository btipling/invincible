//! http(s) link allowlist for rich transcript (no dvui dep).
const std = @import("std");

/// Strip CommonMark optional title and `<>` wrappers from a zmd destination.
/// zmd sets `node.href` to the full paren contents, e.g. `https://x/a.png "title"`.
/// Host fetch keys and paint cache lookups must use the bare URL only.
pub fn normalizeDestination(raw: []const u8) []const u8 {
    const s = std.mem.trim(u8, raw, " \t\r\n");
    if (s.len == 0) return s;

    // <url> optional-title
    if (s[0] == '<') {
        if (std.mem.indexOfScalar(u8, s[1..], '>')) |rel| {
            return std.mem.trim(u8, s[1 .. 1 + rel], " \t\r\n");
        }
    }

    // Unquoted destination then title: space + "…" / '…' / (…)
    // Unquoted destinations cannot contain spaces (use <> form for those).
    if (std.mem.indexOfScalar(u8, s, ' ')) |sp| {
        var i = sp;
        while (i < s.len and (s[i] == ' ' or s[i] == '\t')) : (i += 1) {}
        if (i < s.len and (s[i] == '"' or s[i] == '\'' or s[i] == '(')) {
            var end = sp;
            while (end > 0 and (s[end - 1] == ' ' or s[end - 1] == '\t')) : (end -= 1) {}
            return s[0..end];
        }
    }
    return s;
}

/// http(s) only — reject javascript:, data:, relative, whitespace (dirty title left on), etc.
pub fn isSafeLinkUrl(url: []const u8) bool {
    if (url.len < 8) return false;
    // Destinations with spaces are not bare URLs (title leak or unescaped space).
    if (std.mem.indexOfScalar(u8, url, ' ') != null) return false;
    if (std.mem.indexOfScalar(u8, url, '\t') != null) return false;
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
    try std.testing.expect(!isSafeLinkUrl("https://example.com/a.png \"title\""));
}

test "normalizeDestination strips title and angle brackets" {
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("https://example.com/a.png"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("https://example.com/a.png \"Random test image\""),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("https://example.com/a.png 'title'"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("https://example.com/a.png (title)"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("<https://example.com/a.png>"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/a.png",
        normalizeDestination("  <https://example.com/a.png> \"t\"  "),
    );
}
