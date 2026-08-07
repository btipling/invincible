//! Fence/code-aware math delimiter extract for rich MD.
//! Display `$$...$$` → partition segments; inline `$...$` → PUA index markers
//! (TeX stays out of zmd). Currency-like `$5` rejected.
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const MAX_TEX_LEN: usize = 512;
pub const MAX_INLINE_MATH: usize = 64;

/// PUA open/close around a decimal index into the extract side-table.
pub const pua_math_open: u21 = 0xE040;
pub const pua_math_close: u21 = 0xE041;

pub const DisplaySegment = struct {
    is_math: bool,
    /// Prose when !is_math; TeX source (no delimiters) when is_math.
    text: []const u8 = "",
};

pub const InlineExtract = struct {
    /// Source with `$...$` replaced by PUA+index+PUA markers.
    body: []u8,
    /// Arena/allocator-owned TeX strings (no delimiters), indexed by marker.
    texs: [][]const u8,
};

fn appendCp(out: *std.ArrayList(u8), a: Allocator, cp: u21) !void {
    var buf: [4]u8 = undefined;
    const n = try std.unicode.utf8Encode(cp, &buf);
    try out.appendSlice(a, buf[0..n]);
}

fn isFenceLine(line: []const u8) bool {
    return preprocess.isFenceLine(line);
}

/// True when interior is empty/ws or simple money without TeX tokens.
pub fn isCurrencyLike(tex: []const u8) bool {
    if (tex.len == 0) return true;
    var only_ws = true;
    for (tex) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') {
            only_ws = false;
            break;
        }
    }
    if (only_ws) return true;
    // Only digits / comma / dot (and optional leading spaces already rejected via tokens).
    var i: usize = 0;
    while (i < tex.len and (tex[i] == ' ' or tex[i] == '\t')) : (i += 1) {}
    if (i >= tex.len) return true;
    if (tex[i] < '0' or tex[i] > '9') return false;
    while (i < tex.len) : (i += 1) {
        const c = tex[i];
        if (c >= '0' and c <= '9') continue;
        if (c == ',' or c == '.') continue;
        if (c == ' ' or c == '\t') continue;
        return false;
    }
    return true;
}

/// Require at least one letter OR backslash OR ^ _ = { for inline math.
pub fn looksLikeMath(tex: []const u8) bool {
    for (tex) |c| {
        if (c == '\\' or c == '^' or c == '_' or c == '=' or c == '{') return true;
        if ((c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z')) return true;
    }
    return false;
}

fn hasTexSpecial(tex: []const u8) bool {
    for (tex) |c| {
        if (c == '\\' or c == '^' or c == '_' or c == '=' or c == '{') return true;
    }
    return false;
}

pub fn acceptInlineTex(tex: []const u8) bool {
    if (tex.len == 0 or tex.len > MAX_TEX_LEN) return false;
    if (isCurrencyLike(tex)) return false;
    if (!looksLikeMath(tex)) return false;
    // `$5 and $10` pairs as `$5 and $` — leading digit + whitespace without TeX specials → prose.
    if (tex[0] >= '0' and tex[0] <= '9') {
        var has_ws = false;
        for (tex) |c| {
            if (c == ' ' or c == '\t') has_ws = true;
        }
        if (has_ws and !hasTexSpecial(tex)) return false;
    }
    return true;
}

pub fn acceptDisplayTex(tex: []const u8) bool {
    // Display: allow non-empty after trim; still cap length. No currency gate
    // ($$5$$ is rare; agents use display for real formulas).
    if (tex.len == 0 or tex.len > MAX_TEX_LEN) return false;
    var has = false;
    for (tex) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') has = true;
    }
    return has;
}

fn trimWs(s: []const u8) []const u8 {
    var start: usize = 0;
    while (start < s.len and (s[start] == ' ' or s[start] == '\t' or s[start] == '\n' or s[start] == '\r')) : (start += 1) {}
    var end = s.len;
    while (end > start and (s[end - 1] == ' ' or s[end - 1] == '\t' or s[end - 1] == '\n' or s[end - 1] == '\r')) : (end -= 1) {}
    return s[start..end];
}

/// Fence-aware partition: display `$$...$$` (same-line or multi-line) vs prose.
pub fn partitionDisplay(allocator: Allocator, src: []const u8) ![]DisplaySegment {
    var out: std.ArrayList(DisplaySegment) = .empty;
    errdefer {
        for (out.items) |s| {
            if (s.text.len > 0) allocator.free(s.text);
        }
        out.deinit(allocator);
    }

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);

    var in_fence = false;
    var i: usize = 0;

    const flush_prose = struct {
        fn go(a: Allocator, p: *std.ArrayList(u8), o: *std.ArrayList(DisplaySegment)) !void {
            if (p.items.len == 0) return;
            const t = try p.toOwnedSlice(a);
            p.* = .empty;
            try o.append(a, .{ .is_math = false, .text = t });
        }
    }.go;

    while (i < src.len) {
        // Physical line
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line_end = i;
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;
        const line = src[line_start..line_end];

        if (isFenceLine(line)) {
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

        // Same-line $$...$$ (non-empty interior)
        if (findSameLineDisplay(line)) |pair| {
            if (pair.start > 0) {
                try prose.appendSlice(allocator, line[0..pair.start]);
            }
            try flush_prose(allocator, &prose, &out);
            const tex = trimWs(line[pair.tex_start..pair.tex_end]);
            if (acceptDisplayTex(tex)) {
                try out.append(allocator, .{ .is_math = true, .text = try allocator.dupe(u8, tex) });
            } else {
                // Reject → keep original slice as prose
                try prose.appendSlice(allocator, line[pair.start..pair.end]);
            }
            if (pair.end < line.len) {
                try prose.appendSlice(allocator, line[pair.end..]);
            }
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }

        // Multi-line opener: line is exactly $$ (optional ws) OR starts a block
        if (isDisplayOpenLine(line)) {
            // Collect until closing $$ line
            const body_start = i; // after opener line
            var j = i;
            var found_close = false;
            var close_line_start: usize = 0;
            var close_after: usize = 0;
            while (j < src.len) {
                const ls = j;
                while (j < src.len and src[j] != '\n') : (j += 1) {}
                const le = j;
                const hnl = j < src.len and src[j] == '\n';
                if (hnl) j += 1;
                const ln = src[ls..le];
                if (isFenceLine(ln)) break; // abort multi-line into fence
                if (isDisplayCloseLine(ln)) {
                    found_close = true;
                    close_line_start = ls;
                    close_after = j;
                    break;
                }
            }
            if (found_close) {
                const raw_body = src[body_start..close_line_start];
                const tex = trimWs(raw_body);
                try flush_prose(allocator, &prose, &out);
                if (acceptDisplayTex(tex)) {
                    try out.append(allocator, .{ .is_math = true, .text = try allocator.dupe(u8, tex) });
                } else {
                    // Keep original including delimiters as prose
                    try prose.appendSlice(allocator, src[line_start..close_after]);
                }
                i = close_after;
                continue;
            }
            // Unclosed: leave as prose
            try prose.appendSlice(allocator, line);
            if (has_nl) try prose.append(allocator, '\n');
            continue;
        }

        try prose.appendSlice(allocator, line);
        if (has_nl) try prose.append(allocator, '\n');
    }

    try flush_prose(allocator, &prose, &out);
    return try out.toOwnedSlice(allocator);
}

fn isDisplayOpenLine(line: []const u8) bool {
    var i: usize = 0;
    while (i < line.len and (line[i] == ' ' or line[i] == '\t')) : (i += 1) {}
    if (i + 2 > line.len) return false;
    if (line[i] != '$' or line[i + 1] != '$') return false;
    i += 2;
    while (i < line.len and (line[i] == ' ' or line[i] == '\t')) : (i += 1) {}
    return i == line.len;
}

fn isDisplayCloseLine(line: []const u8) bool {
    return isDisplayOpenLine(line);
}

const SameLineDisp = struct { start: usize, end: usize, tex_start: usize, tex_end: usize };

fn findSameLineDisplay(line: []const u8) ?SameLineDisp {
    // Find first $$ ... $$ on same line with non-empty-ish interior.
    var i: usize = 0;
    while (i + 1 < line.len) : (i += 1) {
        if (line[i] == '\\' and i + 1 < line.len) {
            i += 1; // skip escaped
            continue;
        }
        if (line[i] == '$' and line[i + 1] == '$') {
            const open = i;
            const tex_start = i + 2;
            var j = tex_start;
            while (j + 1 < line.len) : (j += 1) {
                if (line[j] == '\\' and j + 1 < line.len) {
                    j += 1;
                    continue;
                }
                if (line[j] == '$' and line[j + 1] == '$') {
                    const tex_end = j;
                    if (tex_end > tex_start) {
                        return .{ .start = open, .end = j + 2, .tex_start = tex_start, .tex_end = tex_end };
                    }
                    return null;
                }
            }
            return null; // unclosed
        }
    }
    return null;
}

/// Rewrite inline `$...$` to PUA+index markers. Skips fences, inline code, `\$`, `$$`.
pub fn extractInline(allocator: Allocator, src: []const u8) !InlineExtract {
    var texs: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (texs.items) |t| allocator.free(t);
        texs.deinit(allocator);
    }
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var in_fence = false;
    var i: usize = 0;

    while (i < src.len) {
        // Line-oriented fence tracking + scan
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line_end = i;
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;
        const line = src[line_start..line_end];

        if (isFenceLine(line)) {
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

        try rewriteProseLine(allocator, &out, &texs, line);
        if (has_nl) try out.append(allocator, '\n');
    }

    return .{
        .body = try out.toOwnedSlice(allocator),
        .texs = try texs.toOwnedSlice(allocator),
    };
}

fn rewriteProseLine(
    a: Allocator,
    out: *std.ArrayList(u8),
    texs: *std.ArrayList([]const u8),
    line: []const u8,
) !void {
    // Code mask for `...`
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
        // Escaped dollar
        if (line[j] == '\\' and j + 1 < line.len and line[j + 1] == '$' and !code_mask[j + 1]) {
            try out.append(a, '\\');
            try out.append(a, '$');
            j += 2;
            continue;
        }
        // Skip $$ (display handled elsewhere; leave as text if still present)
        if (line[j] == '$' and j + 1 < line.len and line[j + 1] == '$') {
            try out.append(a, '$');
            try out.append(a, '$');
            j += 2;
            continue;
        }
        // Inline $...$
        if (line[j] == '$') {
            const open = j;
            j += 1;
            const tex_start = j;
            var closed = false;
            var tex_end: usize = tex_start;
            while (j < line.len) {
                if (code_mask[j]) break;
                if (line[j] == '\\' and j + 1 < line.len) {
                    j += 2;
                    continue;
                }
                if (line[j] == '$') {
                    // Don't close on $$
                    if (j + 1 < line.len and line[j + 1] == '$') break;
                    tex_end = j;
                    closed = true;
                    j += 1;
                    break;
                }
                j += 1;
            }
            if (closed) {
                // Trim so cache keys match host `extractCandidateMath` (trims).
                const tex = trimWs(line[tex_start..tex_end]);
                if (acceptInlineTex(tex) and texs.items.len < MAX_INLINE_MATH) {
                    const idx = texs.items.len;
                    try texs.append(a, try a.dupe(u8, tex));
                    try appendCp(out, a, pua_math_open);
                    var ibuf: [16]u8 = undefined;
                    const is = try std.fmt.bufPrint(&ibuf, "{d}", .{idx});
                    try out.appendSlice(a, is);
                    try appendCp(out, a, pua_math_close);
                    continue;
                }
            }
            // Unclosed / rejected → emit from open as plain
            try out.append(a, '$');
            j = open + 1;
            continue;
        }
        try out.append(a, line[j]);
        j += 1;
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test "currency gate" {
    try std.testing.expect(isCurrencyLike("5"));
    try std.testing.expect(isCurrencyLike("10"));
    try std.testing.expect(isCurrencyLike("1,234.56"));
    try std.testing.expect(isCurrencyLike(""));
    try std.testing.expect(isCurrencyLike("  "));
    try std.testing.expect(!isCurrencyLike("E=mc^2"));
    try std.testing.expect(!isCurrencyLike("\\frac{a}{b}"));
    try std.testing.expect(!isCurrencyLike("x"));
    try std.testing.expect(!isCurrencyLike("1+1=2"));
}

test "looksLikeMath" {
    try std.testing.expect(looksLikeMath("E=mc^2"));
    try std.testing.expect(looksLikeMath("\\alpha"));
    try std.testing.expect(looksLikeMath("x_i"));
    try std.testing.expect(!looksLikeMath("5+5"));
    try std.testing.expect(!looksLikeMath("..."));
}

test "extract inline E=mc^2" {
    const r = try extractInline(std.testing.allocator, "energy $E=mc^2$ free");
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 1), r.texs.len);
    try std.testing.expectEqualStrings("E=mc^2", r.texs[0]);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "$E=mc^2$") == null);
}

test "extract inline trims interior whitespace for cache key" {
    const r = try extractInline(std.testing.allocator, "see $ E=mc^2 $ here");
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 1), r.texs.len);
    try std.testing.expectEqualStrings("E=mc^2", r.texs[0]);
}

test "extract rejects currency" {
    const r = try extractInline(std.testing.allocator, "costs $5 and $10 today");
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 0), r.texs.len);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "$5") != null);
}

test "extract skips inline code and fences" {
    const src = "code `$E=mc^2$`\n```\n$x$\n```\n";
    const r = try extractInline(std.testing.allocator, src);
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 0), r.texs.len);
}

test "extract escaped dollar left" {
    const r = try extractInline(std.testing.allocator, "use \\$ for dollar");
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 0), r.texs.len);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "\\$") != null);
}

test "extract unclosed left as text" {
    const r = try extractInline(std.testing.allocator, "oops $E=mc^2");
    defer {
        std.testing.allocator.free(r.body);
        for (r.texs) |t| std.testing.allocator.free(t);
        std.testing.allocator.free(r.texs);
    }
    try std.testing.expectEqual(@as(usize, 0), r.texs.len);
    try std.testing.expect(std.mem.indexOf(u8, r.body, "$E=mc^2") != null);
}

test "partition same-line display" {
    const segs = try partitionDisplay(std.testing.allocator, "before $$\\sum n$$ after\n");
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    var saw_math = false;
    for (segs) |s| {
        if (s.is_math) {
            saw_math = true;
            try std.testing.expectEqualStrings("\\sum n", s.text);
        }
    }
    try std.testing.expect(saw_math);
}

test "partition multiline display" {
    const src =
        \\intro
        \\$$
        \\\int_0^1 x
        \\$$
        \\outro
    ;
    const segs = try partitionDisplay(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    var saw = false;
    for (segs) |s| {
        if (s.is_math) {
            saw = true;
            try std.testing.expect(std.mem.indexOf(u8, s.text, "\\int") != null);
        }
    }
    try std.testing.expect(saw);
}

test "partition skips fence body" {
    const src = "```\n$$\nx\n$$\n```\n";
    const segs = try partitionDisplay(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    for (segs) |s| {
        try std.testing.expect(!s.is_math);
    }
}
