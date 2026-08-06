//! Fence-aware CommonMark-ish thematic break partition (zmd has no HR @ pin).
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const Segment = struct {
    is_hr: bool,
    /// Prose span (owned) when !is_hr; empty when is_hr.
    text: []const u8 = "",
};

pub fn hasNonWs(s: []const u8) bool {
    for (s) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return true;
    }
    return false;
}

/// CommonMark-ish thematic break: optional ≤3 leading spaces, then only spaces and
/// one of `-` / `*` / `_` with ≥3 occurrences of that marker (no mixing).
pub fn isThematicBreak(line: []const u8) bool {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < 3 and line[i] == ' ') : (i += 1) lead += 1;
    // Leading tab → fail closed (not HR)
    if (i < line.len and line[i] == '\t') return false;

    var marker: ?u8 = null;
    var count: usize = 0;
    while (i < line.len) : (i += 1) {
        const c = line[i];
        if (c == ' ') continue;
        if (c == '\t') return false;
        if (c != '-' and c != '*' and c != '_') return false;
        if (marker) |m| {
            if (c != m) return false;
        } else {
            marker = c;
        }
        count += 1;
    }
    return marker != null and count >= 3;
}

/// Partition into prose / HR segments (fence-aware). HR segments have empty text.
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer {
        for (out.items) |s| {
            if (!s.is_hr and s.text.len > 0) allocator.free(s.text);
        }
        out.deinit(allocator);
    }

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);
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
            try o.append(a, .{ .is_hr = false, .text = t });
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
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }
        if (in_fence) {
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }

        if (isThematicBreak(line)) {
            try flushProse(allocator, &out, &prose);
            try out.append(allocator, .{ .is_hr = true, .text = "" });
            continue;
        }

        try prose.appendSlice(allocator, line);
        if (has_nl) try prose.append(allocator, '\n');
    }

    try flushProse(allocator, &out, &prose);
    return try out.toOwnedSlice(allocator);
}

test "isThematicBreak forms" {
    try std.testing.expect(isThematicBreak("---"));
    try std.testing.expect(isThematicBreak("***"));
    try std.testing.expect(isThematicBreak("___"));
    try std.testing.expect(isThematicBreak("- - -"));
    try std.testing.expect(isThematicBreak("  ---"));
    try std.testing.expect(isThematicBreak("----"));
    try std.testing.expect(!isThematicBreak("--"));
    try std.testing.expect(!isThematicBreak("-*-"));
    try std.testing.expect(!isThematicBreak("--- hello"));
    try std.testing.expect(!isThematicBreak("| --- |"));
    try std.testing.expect(!isThematicBreak("\t---"));
}

test "partition hr between prose" {
    const src = "before\n\n---\n\nafter\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| {
            if (!s.is_hr and s.text.len > 0) std.testing.allocator.free(s.text);
        }
        std.testing.allocator.free(segs);
    }
    try std.testing.expect(segs.len >= 3);
    try std.testing.expect(!segs[0].is_hr);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "before") != null);
    var saw_hr = false;
    var saw_after = false;
    for (segs) |s| {
        if (s.is_hr) saw_hr = true;
        if (!s.is_hr and std.mem.indexOf(u8, s.text, "after") != null) saw_after = true;
    }
    try std.testing.expect(saw_hr);
    try std.testing.expect(saw_after);
}

test "partition fence body not hr" {
    const src = "```\n---\n***\n```\n---\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| {
            if (!s.is_hr and s.text.len > 0) std.testing.allocator.free(s.text);
        }
        std.testing.allocator.free(segs);
    }
    var hr_n: usize = 0;
    for (segs) |s| {
        if (s.is_hr) hr_n += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), hr_n);
}
