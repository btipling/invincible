//! Fence-aware GFM-ish footnote extract + ref rewrite (zmd has no footnotes @ pin).
//! Refs become PUA-wrapped labels so zmd's `[` link tokenizer cannot scramble them.
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const MAX_DEFS: usize = 32;
pub const MAX_REFS: usize = 32;
pub const MAX_LABEL: usize = 32;

/// Private-use sentinels around a label (ASCII) — consumed by parse lowerer.
pub const pua_fn_open: u21 = 0xE030;
pub const pua_fn_close: u21 = 0xE031;

pub const Def = struct {
    label: []const u8,
    body: []const u8,
};

pub const Result = struct {
    body: []const u8,
    defs: []Def,
};

fn appendCp(out: *std.ArrayList(u8), a: Allocator, cp: u21) !void {
    var buf: [4]u8 = undefined;
    const n = try std.unicode.utf8Encode(cp, &buf);
    try out.appendSlice(a, buf[0..n]);
}

pub fn isLabelChar(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '_' or c == '-';
}

/// Validate label bytes (1..MAX_LABEL, charset).
pub fn isValidLabel(label: []const u8) bool {
    if (label.len == 0 or label.len > MAX_LABEL) return false;
    for (label) |c| {
        if (!isLabelChar(c)) return false;
    }
    return true;
}

/// Parse a single physical line (no trailing `\n`) as a footnote definition.
/// Optional ≤3 leading spaces, then `[^label]:` + optional space + body.
pub fn parseDefLine(line: []const u8) ?struct { label: []const u8, body: []const u8 } {
    var i: usize = 0;
    var lead: usize = 0;
    while (i < line.len and lead < 3 and line[i] == ' ') : (i += 1) lead += 1;
    if (i + 3 > line.len) return null;
    if (line[i] != '[' or line[i + 1] != '^') return null;
    i += 2;
    const lab_start = i;
    while (i < line.len and isLabelChar(line[i])) : (i += 1) {}
    const label = line[lab_start..i];
    if (!isValidLabel(label)) return null;
    if (i + 2 > line.len) return null;
    if (line[i] != ']' or line[i + 1] != ':') return null;
    i += 2;
    if (i < line.len and line[i] == ' ') i += 1;
    return .{ .label = label, .body = line[i..] };
}

/// Extract footnote defs from `src` and rewrite `[^label]` refs to PUA markers.
/// Excess defs/refs beyond caps remain as ordinary prose in `body` (fail open).
pub fn extractAndRewrite(allocator: Allocator, src: []const u8) !Result {
    return extractAndRewriteBudget(allocator, src, MAX_DEFS, MAX_REFS);
}

pub fn extractAndRewriteBudget(allocator: Allocator, src: []const u8, max_defs: usize, max_refs: usize) !Result {
    var defs_list: std.ArrayList(Def) = .empty;
    errdefer {
        for (defs_list.items) |d| {
            allocator.free(d.label);
            allocator.free(d.body);
        }
        defs_list.deinit(allocator);
    }

    var body1: std.ArrayList(u8) = .empty;
    errdefer body1.deinit(allocator);

    var in_fence = false;
    var i: usize = 0;
    while (i < src.len) {
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line = src[line_start..i];
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;

        if (preprocess.isFenceLine(line)) {
            in_fence = !in_fence;
            try body1.appendSlice(allocator, line);
            if (has_nl) try body1.append(allocator, '\n');
            continue;
        }
        if (in_fence) {
            try body1.appendSlice(allocator, line);
            if (has_nl) try body1.append(allocator, '\n');
            continue;
        }

        if (defs_list.items.len < max_defs) {
            if (parseDefLine(line)) |d| {
                const lab = try allocator.dupe(u8, d.label);
                errdefer allocator.free(lab);
                const bod = try allocator.dupe(u8, d.body);
                errdefer allocator.free(bod);
                try defs_list.append(allocator, .{ .label = lab, .body = bod });
                // Drop def line from body (no blank forced — adjacent blanks OK).
                continue;
            }
        }

        try body1.appendSlice(allocator, line);
        if (has_nl) try body1.append(allocator, '\n');
    }

    const rewritten = try rewriteRefs(allocator, body1.items, max_refs);
    body1.deinit(allocator);

    return .{
        .body = rewritten,
        .defs = try defs_list.toOwnedSlice(allocator),
    };
}

fn rewriteRefs(allocator: Allocator, src: []const u8, max_refs: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var refs_done: usize = 0;
    var in_fence = false;
    var i: usize = 0;
    while (i < src.len) {
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line = src[line_start..i];
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;

        if (preprocess.isFenceLine(line)) {
            in_fence = !in_fence;
            try out.appendSlice(allocator, line);
            if (has_nl) try out.append(allocator, '\n');
            continue;
        }
        if (in_fence) {
            try out.appendSlice(allocator, line);
            if (has_nl) try out.append(allocator, '\n');
            continue;
        }

        try rewriteProseLine(allocator, &out, line, &refs_done, max_refs);
        if (has_nl) try out.append(allocator, '\n');
    }
    return try out.toOwnedSlice(allocator);
}

fn rewriteProseLine(a: Allocator, out: *std.ArrayList(u8), line: []const u8, refs_done: *usize, max_refs: usize) !void {
    // Inline code mask (same spirit as preprocess — simple non-nested `...`)
    var code_mask = try a.alloc(bool, line.len);
    defer a.free(code_mask);
    @memset(code_mask, false);
    {
        var j: usize = 0;
        while (j < line.len) {
            if (line[j] == '`' and (j == 0 or line[j - 1] != '\\')) {
                const open = j;
                j += 1;
                while (j < line.len and line[j] != '`') : (j += 1) {}
                if (j < line.len and line[j] == '`') {
                    var k = open;
                    while (k <= j) : (k += 1) code_mask[k] = true;
                    j += 1;
                }
            } else j += 1;
        }
    }

    var j: usize = 0;
    while (j < line.len) {
        if (code_mask[j]) {
            try out.append(a, line[j]);
            j += 1;
            continue;
        }
        // `[^label]`
        if (refs_done.* < max_refs and j + 3 < line.len and line[j] == '[' and line[j + 1] == '^') {
            var k = j + 2;
            const lab_start = k;
            while (k < line.len and isLabelChar(line[k])) : (k += 1) {}
            const label = line[lab_start..k];
            // Footnote *ref* is [^label] not followed by ':' (def line syntax).
            if (isValidLabel(label) and k < line.len and line[k] == ']' and (k + 1 >= line.len or line[k + 1] != ':')) {
                try appendCp(out, a, pua_fn_open);
                try out.appendSlice(a, label);
                try appendCp(out, a, pua_fn_close);
                refs_done.* += 1;
                j = k + 1;
                continue;
            }
        }
        try out.append(a, line[j]);
        j += 1;
    }
}

// --- tests ------------------------------------------------------------------

test "parseDefLine basic" {
    const d = parseDefLine("[^1]: hello **x**").?;
    try std.testing.expectEqualStrings("1", d.label);
    try std.testing.expectEqualStrings("hello **x**", d.body);
}

test "parseDefLine lead spaces and named" {
    const d = parseDefLine("  [^note]: body").?;
    try std.testing.expectEqualStrings("note", d.label);
    try std.testing.expectEqualStrings("body", d.body);
}

test "parseDefLine rejects quote-ish and bad" {
    try std.testing.expect(parseDefLine("> [^1]: no") == null);
    try std.testing.expect(parseDefLine("[^]: empty") == null);
    try std.testing.expect(parseDefLine("[^bad label]: x") == null);
    try std.testing.expect(parseDefLine("not a def") == null);
}

test "extract drops defs and rewrites refs" {
    const src =
        \\See note[^1] and `[^1]` code.
        \\
        \\[^1]: The definition.
        \\
    ;
    const r = try extractAndRewrite(std.testing.allocator, src);
    defer {
        std.testing.allocator.free(r.body);
        for (r.defs) |d| {
            std.testing.allocator.free(d.label);
            std.testing.allocator.free(d.body);
        }
        std.testing.allocator.free(r.defs);
    }
    try std.testing.expectEqual(@as(usize, 1), r.defs.len);
    try std.testing.expectEqualStrings("1", r.defs[0].label);
    try std.testing.expectEqualStrings("The definition.", r.defs[0].body);
    // Def line gone from body
    try std.testing.expect(std.mem.indexOf(u8, r.body, "The definition.") == null);
    // Code span keeps literal [^1]
    try std.testing.expect(std.mem.indexOf(u8, r.body, "`[^1]`") != null);
    // Prose ref rewritten (PUA present, raw [^1] only inside code)
    var buf: [4]u8 = undefined;
    const n = try std.unicode.utf8Encode(pua_fn_open, &buf);
    try std.testing.expect(std.mem.indexOf(u8, r.body, buf[0..n]) != null);
}

test "fence safe no extract inside" {
    const src =
        \\```
        \\[^1]: not a def
        \\```
        \\
        \\ok[^1]
        \\
        \\[^1]: real
        \\
    ;
    const r = try extractAndRewrite(std.testing.allocator, src);
    defer {
        std.testing.allocator.free(r.body);
        for (r.defs) |d| {
            std.testing.allocator.free(d.label);
            std.testing.allocator.free(d.body);
        }
        std.testing.allocator.free(r.defs);
    }
    try std.testing.expectEqual(@as(usize, 1), r.defs.len);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "[^1]: not a def") != null);
}

test "cap excess def stays in body" {
    const src =
        \\[^a]: A
        \\[^b]: B
        \\[^c]: C
        \\[^d]: D
        \\
    ;
    const r = try extractAndRewriteBudget(std.testing.allocator, src, 3, MAX_REFS);
    defer {
        std.testing.allocator.free(r.body);
        for (r.defs) |d| {
            std.testing.allocator.free(d.label);
            std.testing.allocator.free(d.body);
        }
        std.testing.allocator.free(r.defs);
    }
    try std.testing.expectEqual(@as(usize, 3), r.defs.len);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "[^d]:") != null);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "[^a]:") == null);
}
