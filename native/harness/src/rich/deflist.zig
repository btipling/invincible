//! Fence-aware PHP Markdown Extra / pandoc-style definition lists
//! (zmd has no dl/dt/dd @ pin). Term line + one or more line-start `: ` defs.
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const MAX_TERMS: usize = 32;
pub const MAX_DESCS: usize = 64;

pub const Segment = struct {
    is_deflist: bool,
    /// Prose when !is_deflist (allocator-owned).
    text: []const u8 = "",
    /// Def group when is_deflist (allocator-owned).
    term: []const u8 = "",
    descs: []const []const u8 = &.{},
};

pub fn freeSegmentContents(allocator: Allocator, s: Segment) void {
    if (s.is_deflist) {
        if (s.term.len > 0) allocator.free(s.term);
        for (s.descs) |d| {
            if (d.len > 0) allocator.free(d);
        }
        if (s.descs.len > 0) allocator.free(s.descs);
    } else if (s.text.len > 0) {
        allocator.free(s.text);
    }
}

pub fn freeSegments(allocator: Allocator, segs: []Segment) void {
    for (segs) |s| freeSegmentContents(allocator, s);
    allocator.free(segs);
}

pub fn hasNonWs(s: []const u8) bool {
    for (s) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return true;
    }
    return false;
}

/// Optional ≤3 spaces, `:`, optional spaces, rest of line = body.
/// Fail closed on leading tab. Does not match footnote defs (`[^id]:`) —
/// those require `[` before `:` and are extracted earlier in the pipeline.
pub fn parseDefLine(line: []const u8) ?[]const u8 {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < 3 and line[i] == ' ') : (i += 1) lead += 1;
    if (i < line.len and line[i] == '\t') return null;
    if (i >= line.len or line[i] != ':') return null;
    i += 1;
    while (i < line.len and line[i] == ' ') : (i += 1) {}
    return line[i..];
}

/// Unordered (`- `/`* `/`+ `) or ordered (`1. `) list marker line — not a term.
pub fn isListMarkerLine(line: []const u8) bool {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < 3 and line[i] == ' ') : (i += 1) lead += 1;
    if (i >= line.len) return false;
    if (line[i] == '-' or line[i] == '*' or line[i] == '+') {
        if (i + 1 < line.len and line[i + 1] == ' ') return true;
        return false;
    }
    // ordered: digits + '.' + space
    if (line[i] < '0' or line[i] > '9') return false;
    while (i < line.len and line[i] >= '0' and line[i] <= '9') : (i += 1) {}
    if (i + 1 >= line.len) return false;
    if (line[i] != '.') return false;
    return line[i + 1] == ' ';
}

fn isEligibleTerm(line: []const u8) bool {
    if (!hasNonWs(line)) return false;
    if (parseDefLine(line) != null) return false;
    if (isListMarkerLine(line)) return false;
    // Fence openers are never terms (handled by fence state, but fail closed).
    if (preprocess.isFenceLine(line)) return false;
    return true;
}

const Line = struct {
    text: []const u8,
    has_nl: bool,
};

fn collectLines(src: []const u8, a: Allocator) ![]Line {
    var lines: std.ArrayList(Line) = .empty;
    errdefer lines.deinit(a);
    var i: usize = 0;
    while (i < src.len) {
        const start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const text = src[start..i];
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;
        try lines.append(a, .{ .text = text, .has_nl = has_nl });
    }
    return try lines.toOwnedSlice(a);
}

fn appendLine(buf: *std.ArrayList(u8), a: Allocator, line: Line) !void {
    try buf.appendSlice(a, line.text);
    if (line.has_nl) try buf.append(a, '\n');
}

/// Fence-aware partition into prose / definition-list groups.
/// Caps: ≤MAX_TERMS groups, ≤MAX_DESCS desc lines total; excess stays prose.
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer {
        for (out.items) |s| freeSegmentContents(allocator, s);
        out.deinit(allocator);
    }

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);

    const lines = try collectLines(src, allocator);
    defer allocator.free(lines);

    var terms_used: usize = 0;
    var descs_used: usize = 0;
    var in_fence = false;
    var i: usize = 0;

    const flushProse = struct {
        fn go(a: Allocator, o: *std.ArrayList(Segment), p: *std.ArrayList(u8)) !void {
            if (p.items.len == 0) return;
            if (!hasNonWs(p.items)) {
                p.clearRetainingCapacity();
                return;
            }
            const t = try a.dupe(u8, p.items);
            p.clearRetainingCapacity();
            try o.append(a, .{ .is_deflist = false, .text = t });
        }
    }.go;

    while (i < lines.len) {
        const line = lines[i];

        if (preprocess.isFenceLine(line.text)) {
            in_fence = !in_fence;
            try appendLine(&prose, allocator, line);
            i += 1;
            continue;
        }
        if (in_fence) {
            try appendLine(&prose, allocator, line);
            i += 1;
            continue;
        }

        // Potential term + one or more def lines (no blank between term and first :).
        if (terms_used < MAX_TERMS and descs_used < MAX_DESCS and
            isEligibleTerm(line.text) and i + 1 < lines.len and
            parseDefLine(lines[i + 1].text) != null)
        {
            // Collect consecutive def lines.
            var desc_list: std.ArrayList([]const u8) = .empty;
            errdefer {
                for (desc_list.items) |d| allocator.free(d);
                desc_list.deinit(allocator);
            }
            var j = i + 1;
            while (j < lines.len and descs_used + desc_list.items.len < MAX_DESCS) {
                if (parseDefLine(lines[j].text)) |body| {
                    try desc_list.append(allocator, try allocator.dupe(u8, body));
                    j += 1;
                } else break;
            }
            if (desc_list.items.len == 0) {
                // Cap hit with zero descs — treat term as prose.
                try appendLine(&prose, allocator, line);
                i += 1;
                continue;
            }

            try flushProse(allocator, &out, &prose);
            const term = try allocator.dupe(u8, line.text);
            errdefer allocator.free(term);
            const descs = try desc_list.toOwnedSlice(allocator);
            // Owned by `out` after append; free on append failure (GPA callers).
            errdefer {
                for (descs) |d| {
                    if (d.len > 0) allocator.free(d);
                }
                if (descs.len > 0) allocator.free(descs);
            }
            try out.append(allocator, .{
                .is_deflist = true,
                .term = term,
                .descs = descs,
            });
            terms_used += 1;
            descs_used += descs.len;
            i = j;
            continue;
        }

        // Orphan def line or ordinary prose — stay in prose path.
        try appendLine(&prose, allocator, line);
        i += 1;
    }

    try flushProse(allocator, &out, &prose);
    return try out.toOwnedSlice(allocator);
}

// --- tests ------------------------------------------------------------------

test "parseDefLine basic" {
    try std.testing.expectEqualStrings("hello", parseDefLine(": hello").?);
    try std.testing.expectEqualStrings("x", parseDefLine("  : x").?);
    try std.testing.expectEqualStrings("y", parseDefLine(":y").?);
    try std.testing.expect(parseDefLine("   : z") != null);
    try std.testing.expect(parseDefLine("    : too many spaces") == null);
    try std.testing.expect(parseDefLine("\t: tab") == null);
    try std.testing.expect(parseDefLine("not: def") == null);
    try std.testing.expect(parseDefLine("") == null);
}

test "isListMarkerLine" {
    try std.testing.expect(isListMarkerLine("- item"));
    try std.testing.expect(isListMarkerLine("* item"));
    try std.testing.expect(isListMarkerLine("+ item"));
    try std.testing.expect(isListMarkerLine("1. item"));
    try std.testing.expect(isListMarkerLine("  - indented"));
    try std.testing.expect(!isListMarkerLine("Term"));
    try std.testing.expect(!isListMarkerLine("-no space"));
    try std.testing.expect(!isListMarkerLine("1.no"));
}

test "partition multi-term multi-def" {
    const src =
        \\Term one
        \\: First definition
        \\: Second definition for the same term
        \\
        \\Term two
        \\: Definition of term two
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer freeSegments(std.testing.allocator, segs);

    var terms: usize = 0;
    var descs: usize = 0;
    for (segs) |s| {
        if (s.is_deflist) {
            terms += 1;
            descs += s.descs.len;
        }
    }
    try std.testing.expectEqual(@as(usize, 2), terms);
    try std.testing.expectEqual(@as(usize, 3), descs);
    try std.testing.expectEqualStrings("Term one", segs[0].term);
    try std.testing.expectEqual(@as(usize, 2), segs[0].descs.len);
    try std.testing.expectEqualStrings("First definition", segs[0].descs[0]);
    try std.testing.expectEqualStrings("Second definition for the same term", segs[0].descs[1]);
}

test "partition fence body not deflist" {
    const src =
        \\```
        \\Term
        \\: not a def
        \\```
        \\
        \\Real term
        \\: real def
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer freeSegments(std.testing.allocator, segs);

    var def_n: usize = 0;
    var saw_fence_prose = false;
    for (segs) |s| {
        if (s.is_deflist) {
            def_n += 1;
            try std.testing.expectEqualStrings("Real term", s.term);
        } else if (std.mem.indexOf(u8, s.text, ": not a def") != null) {
            saw_fence_prose = true;
        }
    }
    try std.testing.expectEqual(@as(usize, 1), def_n);
    try std.testing.expect(saw_fence_prose);
}

test "partition orphan def stays prose" {
    const src = ": orphan only\n\n";
    const segs = try partition(std.testing.allocator, src);
    defer freeSegments(std.testing.allocator, segs);
    for (segs) |s| {
        try std.testing.expect(!s.is_deflist);
        try std.testing.expect(std.mem.indexOf(u8, s.text, "orphan") != null);
    }
}

test "partition list marker not term" {
    const src =
        \\- item
        \\: not attached
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer freeSegments(std.testing.allocator, segs);
    for (segs) |s| {
        try std.testing.expect(!s.is_deflist);
    }
}

test "partition blank between term and colon is orphan" {
    const src =
        \\Term
        \\
        \\: orphan
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer freeSegments(std.testing.allocator, segs);
    for (segs) |s| {
        try std.testing.expect(!s.is_deflist);
    }
}

test "partition cap fail open" {
    // Build > MAX_TERMS groups; remainder should stay as prose (visible).
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    var n: usize = 0;
    while (n < MAX_TERMS + 3) : (n += 1) {
        var line_buf: [64]u8 = undefined;
        const line = try std.fmt.bufPrint(&line_buf, "T{d}\n: d{d}\n\n", .{ n, n });
        try buf.appendSlice(std.testing.allocator, line);
    }
    const segs = try partition(std.testing.allocator, buf.items);
    defer freeSegments(std.testing.allocator, segs);
    var terms: usize = 0;
    var saw_overflow_prose = false;
    for (segs) |s| {
        if (s.is_deflist) terms += 1 else {
            if (std.mem.indexOf(u8, s.text, "T32") != null or std.mem.indexOf(u8, s.text, "T33") != null)
                saw_overflow_prose = true;
        }
    }
    try std.testing.expectEqual(MAX_TERMS, terms);
    try std.testing.expect(saw_overflow_prose);
}

test "partition cap descs fail open" {
    // One term with > MAX_DESCS defs; overflow def lines stay prose (visible).
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    try buf.appendSlice(std.testing.allocator, "Term\n");
    var n: usize = 0;
    while (n < MAX_DESCS + 5) : (n += 1) {
        var line_buf: [32]u8 = undefined;
        const line = try std.fmt.bufPrint(&line_buf, ": d{d}\n", .{n});
        try buf.appendSlice(std.testing.allocator, line);
    }
    const segs = try partition(std.testing.allocator, buf.items);
    defer freeSegments(std.testing.allocator, segs);
    var terms: usize = 0;
    var descs: usize = 0;
    var saw_overflow_prose = false;
    for (segs) |s| {
        if (s.is_deflist) {
            terms += 1;
            descs += s.descs.len;
        } else if (std.mem.indexOf(u8, s.text, "d64") != null or std.mem.indexOf(u8, s.text, "d65") != null) {
            saw_overflow_prose = true;
        }
    }
    try std.testing.expectEqual(@as(usize, 1), terms);
    try std.testing.expectEqual(MAX_DESCS, descs);
    try std.testing.expect(saw_overflow_prose);
}
