//! Fence-aware GFM-ish blockquote line partition (zmd has no `>` blocks @ pin).
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

/// Max leading spaces before the first `>` on a quote line (quote-under-list indent).
pub const MAX_QUOTE_LEAD: usize = 12;

pub const QuoteLine = struct {
    depth: u8,
    content: []const u8,
    /// Lead spaces before the first `>` (0..MAX_QUOTE_LEAD).
    indent_cols: u8,
};

/// Parse a single physical line (no trailing `\n`) as a quote line.
/// Returns null if not a quote line (or if caller is inside a fence).
/// Depth: consecutive `>>` or GFM-spaced `> >` (optional one space/tab after each `>`).
/// Leading tab before `>` fails closed (not a quote).
pub fn parseQuoteLine(line: []const u8) ?QuoteLine {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < MAX_QUOTE_LEAD and line[i] == ' ') : (i += 1) lead += 1;
    if (i >= line.len or line[i] != '>') return null;

    var gt: u8 = 0;
    while (i < line.len and line[i] == '>') {
        if (gt < 255) gt += 1;
        i += 1;
        // Optional one space/tab after each `>` (content lead-in or nest separator).
        if (i < line.len and (line[i] == ' ' or line[i] == '\t')) i += 1;
    }
    if (gt == 0) return null;
    const depth: u8 = if (gt > 6) 6 else gt;

    return .{
        .depth = depth,
        .content = line[i..],
        .indent_cols = @intCast(lead),
    };
}

pub const Segment = struct {
    is_quote: bool,
    depth: u8 = 0,
    /// Lead spaces before first `>` of this quote group (0 for prose).
    indent_cols: u8 = 0,
    /// Arena- or caller-owned text for this segment.
    text: []const u8,
};

/// Partition `src` into prose and same-depth/same-indent quote segments (fence-aware).
/// Quote bodies are stripped of leading `>` markers; lines joined with `\n`.
/// Splits when quote depth **or** `indent_cols` changes.
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer out.deinit(allocator);

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);
    var quote_body: std.ArrayList(u8) = .empty;
    defer quote_body.deinit(allocator);
    var quote_depth: ?u8 = null;
    var quote_indent: u8 = 0;
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
        fn go(
            a: Allocator,
            o: *std.ArrayList(Segment),
            q: *std.ArrayList(u8),
            depth: *?u8,
            indent: *u8,
        ) !void {
            const d = depth.* orelse {
                q.clearRetainingCapacity();
                return;
            };
            const ind = indent.*;
            depth.* = null;
            indent.* = 0;
            if (!hasNonWs(q.items)) {
                q.clearRetainingCapacity();
                return;
            }
            const t = try a.dupe(u8, q.items);
            q.clearRetainingCapacity();
            try o.append(a, .{ .is_quote = true, .depth = d, .indent_cols = ind, .text = t });
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
            try flushQuote(allocator, &out, &quote_body, &quote_depth, &quote_indent);
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }
        if (in_fence) {
            try flushQuote(allocator, &out, &quote_body, &quote_depth, &quote_indent);
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }

        if (parseQuoteLine(line)) |ql| {
            try flushProse(allocator, &out, &prose);
            if (quote_depth) |d| {
                if (d != ql.depth or quote_indent != ql.indent_cols) {
                    try flushQuote(allocator, &out, &quote_body, &quote_depth, &quote_indent);
                }
            }
            if (quote_depth == null) {
                quote_depth = ql.depth;
                quote_indent = ql.indent_cols;
            }
            if (quote_body.items.len > 0) try quote_body.append(allocator, '\n');
            try quote_body.appendSlice(allocator, ql.content);
            continue;
        }

        // Non-quote prose line
        try flushQuote(allocator, &out, &quote_body, &quote_depth, &quote_indent);
        try prose.appendSlice(allocator, line);
        if (has_nl) try prose.append(allocator, '\n');
    }

    try flushQuote(allocator, &out, &quote_body, &quote_depth, &quote_indent);
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
    try std.testing.expectEqual(@as(u8, 0), q.indent_cols);
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
    try std.testing.expectEqual(@as(u8, 2), q.indent_cols);
}

test "parseQuoteLine lead 4 under nested list" {
    const q = parseQuoteLine("    > under nest").?;
    try std.testing.expectEqual(@as(u8, 1), q.depth);
    try std.testing.expectEqual(@as(u8, 4), q.indent_cols);
    try std.testing.expectEqualStrings("under nest", q.content);
}

test "parseQuoteLine lead 12 max" {
    const q = parseQuoteLine("            > max").?; // 12 spaces
    try std.testing.expectEqual(@as(u8, 1), q.depth);
    try std.testing.expectEqual(@as(u8, 12), q.indent_cols);
    try std.testing.expectEqualStrings("max", q.content);
}

test "parseQuoteLine lead 13 not quote" {
    const q = parseQuoteLine("             > too many"); // 13 spaces
    try std.testing.expect(q == null);
}

test "parseQuoteLine leading tab fails closed" {
    try std.testing.expect(parseQuoteLine("\t> tab") == null);
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
    try std.testing.expectEqual(@as(u8, 0), segs[0].indent_cols);
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

test "partition indent change splits same depth" {
    const segs = try partition(std.testing.allocator, "    > nested\n> top\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 2), segs.len);
    try std.testing.expect(segs[0].is_quote);
    try std.testing.expectEqual(@as(u8, 4), segs[0].indent_cols);
    try std.testing.expectEqualStrings("nested", segs[0].text);
    try std.testing.expect(segs[1].is_quote);
    try std.testing.expectEqual(@as(u8, 0), segs[1].indent_cols);
    try std.testing.expectEqualStrings("top", segs[1].text);
}

test "partition nested list prose then indented quote" {
    const src = "- outer\n  - nested\n    > should be a quote\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 2), segs.len);
    try std.testing.expect(!segs[0].is_quote);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "nested") != null);
    try std.testing.expect(segs[1].is_quote);
    try std.testing.expectEqual(@as(u8, 4), segs[1].indent_cols);
    try std.testing.expectEqualStrings("should be a quote", segs[1].text);
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

test "parseQuoteLine depth clamp" {
    const q = parseQuoteLine(">>>>>>> deep").?;
    try std.testing.expectEqual(@as(u8, 6), q.depth);
    try std.testing.expectEqualStrings("deep", q.content);
}

test "partition empty quote line keeps same-depth continuity" {
    const segs = try partition(std.testing.allocator, "> a\n>\n> b\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(segs[0].is_quote);
    try std.testing.expectEqualStrings("a\n\nb", segs[0].text);
}

test "partition prose then quote then prose" {
    const segs = try partition(std.testing.allocator, "before\n> mid\nafter\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 3), segs.len);
    try std.testing.expect(!segs[0].is_quote);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "before") != null);
    try std.testing.expect(segs[1].is_quote);
    try std.testing.expectEqualStrings("mid", segs[1].text);
    try std.testing.expect(!segs[2].is_quote);
    try std.testing.expect(std.mem.indexOf(u8, segs[2].text, "after") != null);
}

test "parseQuoteLine spaced nest" {
    const q = parseQuoteLine("> > nest").?;
    try std.testing.expectEqual(@as(u8, 2), q.depth);
    try std.testing.expectEqualStrings("nest", q.content);
}

test "partition spaced nest depth" {
    const segs = try partition(std.testing.allocator, "> outer\n> > inner\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 2), segs.len);
    try std.testing.expectEqual(@as(u8, 1), segs[0].depth);
    try std.testing.expectEqualStrings("outer", segs[0].text);
    try std.testing.expectEqual(@as(u8, 2), segs[1].depth);
    try std.testing.expectEqualStrings("inner", segs[1].text);
}
