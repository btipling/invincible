//! Fence-aware GFM-ish blockquote line partition (zmd has no `>` blocks @ pin).
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const QuoteLine = struct {
    depth: u8,
    content: []const u8,
};

/// Parse a single physical line (no trailing `\n`) as a quote line.
/// Returns null if not a quote line (or if caller is inside a fence).
pub fn parseQuoteLine(line: []const u8) ?QuoteLine {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < 3 and line[i] == ' ') : (i += 1) lead += 1;
    if (i >= line.len or line[i] != '>') return null;

    var gt: u8 = 0;
    while (i < line.len and line[i] == '>') : (i += 1) {
        if (gt < 255) gt += 1;
    }
    if (gt == 0) return null;
    const depth: u8 = if (gt > 6) 6 else gt;

    // Optional whitespace after the `>` run
    if (i < line.len and (line[i] == ' ' or line[i] == '\t')) i += 1;

    return .{ .depth = depth, .content = line[i..] };
}

pub const Segment = struct {
    is_quote: bool,
    depth: u8 = 0,
    /// Arena- or caller-owned text for this segment.
    text: []const u8,
};

/// Partition `src` into prose and same-depth quote segments (fence-aware).
/// Quote bodies are stripped of leading `>` markers; lines joined with `\n`.
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer out.deinit(allocator);

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);
    var quote_body: std.ArrayList(u8) = .empty;
    defer quote_body.deinit(allocator);
    var quote_depth: ?u8 = null;
    var in_fence = false;

    const flushProse = struct {
        fn go(a: Allocator, o: *std.ArrayList(Segment), p: *std.ArrayList(u8)) !void {
            if (p.items.len == 0) return;
            if (!hasNonWs(p.items)) {
                p.clearRetainingCapacity();
                return;
            }
            const t = try a.dupe(u8, p.items);
            p.clearRetainingCapacity();
            try o.append(a, .{ .is_quote = false, .text = t });
        }
    }.go;

    const flushQuote = struct {
        fn go(a: Allocator, o: *std.ArrayList(Segment), q: *std.ArrayList(u8), depth: *?u8) !void {
            const d = depth.* orelse {
                q.clearRetainingCapacity();
                return;
            };
            depth.* = null;
            if (!hasNonWs(q.items)) {
                q.clearRetainingCapacity();
                return;
            }
            const t = try a.dupe(u8, q.items);
            q.clearRetainingCapacity();
            try o.append(a, .{ .is_quote = true, .depth = d, .text = t });
        }
    }.go;

    var i: usize = 0;
    while (i < src.len) {
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line = src[line_start..i];
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;

        if (preprocess.isFenceLine(line)) {
            in_fence = !in_fence;
            try flushQuote(allocator, &out, &quote_body, &quote_depth);
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }
        if (in_fence) {
            try flushQuote(allocator, &out, &quote_body, &quote_depth);
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }

        if (parseQuoteLine(line)) |ql| {
            try flushProse(allocator, &out, &prose);
            if (quote_depth) |d| {
                if (d != ql.depth) {
                    try flushQuote(allocator, &out, &quote_body, &quote_depth);
                }
            }
            if (quote_depth == null) {
                quote_depth = ql.depth;
            }
            if (quote_body.items.len > 0) try quote_body.append(allocator, '\n');
            try quote_body.appendSlice(allocator, ql.content);
            continue;
        }

        // Non-quote prose line
        try flushQuote(allocator, &out, &quote_body, &quote_depth);
        try prose.appendSlice(allocator, line);
        if (has_nl) try prose.append(allocator, '\n');
    }

    try flushQuote(allocator, &out, &quote_body, &quote_depth);
    try flushProse(allocator, &out, &prose);
    return try out.toOwnedSlice(allocator);
}

pub fn hasNonWs(s: []const u8) bool {
    for (s) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return true;
    }
    return false;
}

test "parseQuoteLine basic" {
    const q = parseQuoteLine("> hi").?;
    try std.testing.expectEqual(@as(u8, 1), q.depth);
    try std.testing.expectEqualStrings("hi", q.content);
}

test "parseQuoteLine nested" {
    const q = parseQuoteLine(">> nest").?;
    try std.testing.expectEqual(@as(u8, 2), q.depth);
    try std.testing.expectEqualStrings("nest", q.content);
}

test "parseQuoteLine lead spaces" {
    const q = parseQuoteLine("  > x").?;
    try std.testing.expectEqual(@as(u8, 1), q.depth);
    try std.testing.expectEqualStrings("x", q.content);
}

test "partition same-depth merge" {
    const segs = try partition(std.testing.allocator, "> a\n> b\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(segs[0].is_quote);
    try std.testing.expectEqual(@as(u8, 1), segs[0].depth);
    try std.testing.expectEqualStrings("a\nb", segs[0].text);
}

test "partition depth change splits" {
    const segs = try partition(std.testing.allocator, "> a\n>> b\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 2), segs.len);
    try std.testing.expectEqual(@as(u8, 1), segs[0].depth);
    try std.testing.expectEqualStrings("a", segs[0].text);
    try std.testing.expectEqual(@as(u8, 2), segs[1].depth);
    try std.testing.expectEqualStrings("b", segs[1].text);
}

test "partition skips fence body quotes" {
    const src = "```\n> not\n```\n> yes\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    var saw_quote = false;
    var saw_fence_prose = false;
    for (segs) |s| {
        if (s.is_quote) {
            saw_quote = true;
            try std.testing.expectEqualStrings("yes", s.text);
        } else if (std.mem.indexOf(u8, s.text, "> not") != null) {
            saw_fence_prose = true;
        }
    }
    try std.testing.expect(saw_quote);
    try std.testing.expect(saw_fence_prose);
}
