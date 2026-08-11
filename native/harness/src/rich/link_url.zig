//! http(s) link allowlist for rich transcript (no dvui dep).
const std = @import("std");

/// Cap for bare-URL autolink spans (same spirit as image URL cap).
pub const max_bare_url_len: usize = 2048;

/// Half-open span of a bare http(s) URL inside `s`.
pub const BareUrlSpan = struct {
    start: usize,
    end: usize,
};

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

/// Find next bare `http://` / `https://` URL in `s` at or after `from`.
/// Returns half-open `[start, end)` after trailing-punctuation trim.
/// Does not stop at `?` / `#` / `&` / `=` / path punctuation.
pub fn findBareHttpUrl(s: []const u8, from: usize) ?BareUrlSpan {
    var i = from;
    while (i < s.len) {
        const scheme_len = matchHttpScheme(s, i) orelse {
            i += 1;
            continue;
        };
        // CommonMark angle-bracket autolink: an http(s) scheme immediately
        // preceded by `<` is the opening `<>` wrapper. Stop the body at the
        // FIRST `>` (the closing CM autolink delimiter) so the href stays the
        // clean inner URL instead of absorbing a trailing `>` (#343). Purely
        // additive — bare URLs (no preceding `<`) are untouched.
        const cm_auto = i > 0 and s[i - 1] == '<';
        var j = i + scheme_len;
        while (j < s.len and isUrlBodyByte(s[j])) : (j += 1) {
            if (cm_auto and s[j] == '>') break;
        }
        if (j <= i + scheme_len) {
            i += 1;
            continue;
        }
        const raw = s[i..j];
        const trimmed = trimTrailingUrlPunct(raw);
        if (trimmed.len <= scheme_len) {
            i += 1;
            continue;
        }
        if (trimmed.len > max_bare_url_len) {
            // Fail open as plain text — skip past this scheme match.
            i += scheme_len;
            continue;
        }
        if (!isSafeLinkUrl(trimmed)) {
            i += 1;
            continue;
        }
        return .{ .start = i, .end = i + trimmed.len };
    }
    return null;
}

/// GFM-ish trailing trim: strip `.,;:!?` and unpaired closers `)]}'"`.
/// Does not strip a `)` that balances an open `(` inside the URL.
pub fn trimTrailingUrlPunct(s: []const u8) []const u8 {
    var end = s.len;
    while (end > 0) {
        const c = s[end - 1];
        switch (c) {
            '.', ',', ';', ':', '!', '?' => end -= 1,
            ')' => {
                if (countByte(s[0..end], ')') > countByte(s[0..end], '(')) {
                    end -= 1;
                } else break;
            },
            ']' => {
                if (countByte(s[0..end], ']') > countByte(s[0..end], '[')) {
                    end -= 1;
                } else break;
            },
            '}' => {
                if (countByte(s[0..end], '}') > countByte(s[0..end], '{')) {
                    end -= 1;
                } else break;
            },
            '\'', '"' => end -= 1,
            else => break,
        }
    }
    return s[0..end];
}

fn matchHttpScheme(s: []const u8, i: usize) ?usize {
    const rest = s[i..];
    if (startsWithIgnoreCase(rest, "https://")) return 8;
    if (startsWithIgnoreCase(rest, "http://")) return 7;
    return null;
}

fn isUrlBodyByte(c: u8) bool {
    // Stop at whitespace and ASCII controls; keep path/query/frag punctuation.
    return c > 0x20 and c != 0x7f;
}

fn countByte(s: []const u8, b: u8) usize {
    var n: usize = 0;
    for (s) |c| {
        if (c == b) n += 1;
    }
    return n;
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

test "findBareHttpUrl query frag and case" {
    const s = "See https://example.com/path?q=1&x=y#frag for details.";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings(
        "https://example.com/path?q=1&x=y#frag",
        s[sp.start..sp.end],
    );

    const s2 = "go HTTP://example.com/a next";
    const sp2 = findBareHttpUrl(s2, 0).?;
    try std.testing.expectEqualStrings("HTTP://example.com/a", s2[sp2.start..sp2.end]);

    const s3 = "go HTTPS://EXAMPLE.COM/X";
    const sp3 = findBareHttpUrl(s3, 0).?;
    try std.testing.expectEqualStrings("HTTPS://EXAMPLE.COM/X", s3[sp3.start..sp3.end]);
}

test "trimTrailingUrlPunct sentence and parens" {
    try std.testing.expectEqualStrings(
        "https://example.com/a?b=c#d",
        trimTrailingUrlPunct("https://example.com/a?b=c#d."),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/x?y=1#z",
        trimTrailingUrlPunct("https://example.com/x?y=1#z)"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/foo_(bar)",
        trimTrailingUrlPunct("https://example.com/foo_(bar)"),
    );
    try std.testing.expectEqualStrings(
        "https://example.com/x",
        trimTrailingUrlPunct("https://example.com/x),"),
    );
}

test "findBareHttpUrl trailing punct not in span" {
    const s = "end: https://example.com/a?b=c#d.";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("https://example.com/a?b=c#d", s[sp.start..sp.end]);
    try std.testing.expect(s[sp.end] == '.');

    const s2 = "(https://example.com/x?y=1#z)";
    const sp2 = findBareHttpUrl(s2, 0).?;
    try std.testing.expectEqualStrings("https://example.com/x?y=1#z", s2[sp2.start..sp2.end]);
}

test "findBareHttpUrl CM angle-bracket autolink strips '>' from href" {
    // #343: `<http://example.com/foo/bar>` must autolink to the clean URL; the
    // leading `<` stays plain text and the closing `>` is NOT absorbed.
    const s = "See <http://example.com/foo/bar> for details.";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("http://example.com/foo/bar", s[sp.start..sp.end]);
    // Span starts at the scheme (after the leading `<`).
    try std.testing.expect(sp.start > 0);
    try std.testing.expect(s[sp.start - 1] == '<');
    try std.testing.expect(sp.end < s.len and s[sp.end] == '>');
}

test "findBareHttpUrl CM autolink preserves query and fragment" {
    const s = "<https://example.com/a?b=1#c>";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("https://example.com/a?b=1#c", s[sp.start..sp.end]);
    try std.testing.expect(s[sp.end] == '>');
}

test "findBareHttpUrl CM autolink case-insensitive and sentence punct trim" {
    const s = "go <HTTP://EXAMPLE.COM/X>.";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("HTTP://EXAMPLE.COM/X", s[sp.start..sp.end]);
    // Trailing sentence punct before the closer is still trimmed; the trimmed
    // `.` stays in source just after the span, and the `>` closer comes after it.
    const s2 = "<https://example.com/x.>";
    const sp2 = findBareHttpUrl(s2, 0).?;
    try std.testing.expectEqualStrings("https://example.com/x", s2[sp2.start..sp2.end]);
    try std.testing.expect(s2[sp2.end] == '.');
    try std.testing.expect(s2[sp2.end + 1] == '>');
}

test "findBareHttpUrl CM autolink empty host no link and balanced parens kept" {
    // Empty host: scheme immediately followed by the closer -> no link.
    try std.testing.expect(findBareHttpUrl("<http://>", 0) == null);
    try std.testing.expect(findBareHttpUrl("<https://>", 0) == null);
    // Balanced parens inside an autolink are preserved.
    const s = "<https://example.com/foo_(bar)>";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("https://example.com/foo_(bar)", s[sp.start..sp.end]);
}

test "findBareHttpUrl non-CM bare URL with '>' unchanged" {
    // A bare URL NOT preceded by `<` keeps absorbing `>` (no behavior change).
    const s = "x http://example.com/a>b y";
    const sp = findBareHttpUrl(s, 0).?;
    try std.testing.expectEqualStrings("http://example.com/a>b", s[sp.start..sp.end]);
}

test "findBareHttpUrl rejects non-http and overlong" {
    try std.testing.expect(findBareHttpUrl("javascript:alert(1)", 0) == null);
    try std.testing.expect(findBareHttpUrl("see www.example.com", 0) == null);
    try std.testing.expect(findBareHttpUrl("ftp://example.com", 0) == null);

    var buf: [max_bare_url_len + 64]u8 = undefined;
    const prefix = "https://example.com/";
    @memcpy(buf[0..prefix.len], prefix);
    @memset(buf[prefix.len .. prefix.len + max_bare_url_len], 'a');
    const long = buf[0 .. prefix.len + max_bare_url_len];
    try std.testing.expect(long.len > max_bare_url_len);
    try std.testing.expect(findBareHttpUrl(long, 0) == null);
}
