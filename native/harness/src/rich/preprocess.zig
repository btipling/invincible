//! Pre-pass before zmd: backslash escapes + same-line GFM `~~strike~~` + the
//! GFM no-intra-word `_` rule (word-internal `_` in `foo_bar` / `SANDBOX_TOKEN`
//! stays literal, #336). zmd has none of these (verified @ pin). Output may
//! contain PUA sentinels for lowerer.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// Private-use sentinels (UTF-8) consumed by parse lowerer — not user-facing.
pub const pua_strike_open: u21 = 0xE010;
pub const pua_strike_close: u21 = 0xE011;
pub const pua_lit_star: u21 = 0xE020;
pub const pua_lit_under: u21 = 0xE021;
pub const pua_lit_tick: u21 = 0xE022;
pub const pua_lit_backslash: u21 = 0xE023;
pub const pua_lit_tilde: u21 = 0xE024;
pub const pua_lit_dollar: u21 = 0xE025;

fn appendCp(out: *std.ArrayList(u8), a: Allocator, cp: u21) !void {
    var buf: [4]u8 = undefined;
    const n = try std.unicode.utf8Encode(cp, &buf);
    try out.appendSlice(a, buf[0..n]);
}

/// True for ASCII alphanumerics — the word-forming set used to decide whether an
/// underscore run is *intra-word* under the GFM no-intra-word `_` rule (#336).
/// `_` itself is deliberately excluded so a run is inspected atomically and
/// boundary `__bold__` / `_em_` still emphasize.
fn isAsciiAlnum(c: u8) bool {
    return (c >= '0' and c <= '9') or
        (c >= 'a' and c <= 'z') or
        (c >= 'A' and c <= 'Z');
}

/// Emit the underscore run that starts at `j` in `line`, returning how many
/// bytes were consumed (the run length) so the caller advances past the whole
/// run. When the run is **intra-word** — the char immediately before the run
/// *and* immediately after the run are both ASCII alphanumeric — each `_` is
/// emitted as a literal `pua_lit_under` sentinel, so zmd never parses it as an
/// emphasis delimiter (`foo_bar`, `SANDBOX_TOKEN`, `max_tokens` stay literal).
/// Otherwise the raw run is emitted unchanged (boundary `_em_` / `__bold__`
/// still emphasize). The caller invokes this only at a `_` that was not
/// consumed by a backslash escape and is not inside inline code — both of those
/// branches run first and already advanced past their bytes.
fn emitUnderscoreRun(a: Allocator, out: *std.ArrayList(u8), line: []const u8, j: usize) !usize {
    var run_end = j;
    while (run_end < line.len and line[run_end] == '_') : (run_end += 1) {}
    const prev: u8 = if (j > 0) line[j - 1] else 0;
    const next: u8 = if (run_end < line.len) line[run_end] else 0;
    if (isAsciiAlnum(prev) and isAsciiAlnum(next)) {
        var k = j;
        while (k < run_end) : (k += 1) {
            try appendCp(out, a, pua_lit_under);
        }
    } else {
        try out.appendSlice(a, line[j..run_end]);
    }
    return run_end - j;
}

pub fn isFenceLine(line: []const u8) bool {
    var i: usize = 0;
    while (i < line.len and (line[i] == ' ' or line[i] == '\t')) : (i += 1) {}
    return std.mem.startsWith(u8, line[i..], "```");
}

/// Rewrite `src` for zmd: escapes + same-line strike outside fences / inline code.
/// Caller owns returned slice (`allocator`).
pub fn preprocessInlineSugar(allocator: Allocator, src: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var in_fence = false;
    var i: usize = 0;
    while (i < src.len) {
        // Line including optional trailing \n
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        const line_end = i; // exclusive of \n
        const line = src[line_start..line_end];
        const has_nl = i < src.len and src[i] == '\n';
        if (has_nl) i += 1;

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

        try rewriteProseLine(allocator, &out, line);
        if (has_nl) try out.append(allocator, '\n');
    }
    return try out.toOwnedSlice(allocator);
}

fn rewriteProseLine(a: Allocator, out: *std.ArrayList(u8), line: []const u8) !void {
    // Find same-line inline code spans (simple non-nested `...`)
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
        // backslash escape
        if (line[j] == '\\' and j + 1 < line.len and !code_mask[j + 1]) {
            const n = line[j + 1];
            const lit: ?u21 = switch (n) {
                '*' => pua_lit_star,
                '_' => pua_lit_under,
                '`' => pua_lit_tick,
                '\\' => pua_lit_backslash,
                '~' => pua_lit_tilde,
                '$' => pua_lit_dollar,
                else => null,
            };
            if (lit) |cp| {
                try appendCp(out, a, cp);
                j += 2;
                continue;
            }
        }
        // ~~strike~~ same-line non-greedy
        if (line[j] == '~' and j + 1 < line.len and line[j + 1] == '~' and !code_mask[j + 1]) {
            const inner_start = j + 2;
            if (std.mem.indexOfPos(u8, line, inner_start, "~~")) |close| {
                // ensure close not inside code
                var ok = true;
                var t = close;
                while (t < close + 2) : (t += 1) {
                    if (t < line.len and code_mask[t]) ok = false;
                }
                if (ok) {
                    try appendCp(out, a, pua_strike_open);
                    // rewrite inner (escapes only, no nested strike for v1 simplicity — still allow **)
                    try rewriteProseLineNoStrike(a, out, line[inner_start..close], code_mask[inner_start..close]);
                    try appendCp(out, a, pua_strike_close);
                    j = close + 2;
                    continue;
                }
            }
        }
        // intra-word underscore run → literal (GFM no-intra-word `_`, #336).
        // Feedback-dependent handlers above (code mask / escape / strike) have
        // already consumed their `_`, so any `_` reaching here is untouched.
        if (line[j] == '_') {
            j += try emitUnderscoreRun(a, out, line, j);
            continue;
        }
        try out.append(a, line[j]);
        j += 1;
    }
}

fn rewriteProseLineNoStrike(a: Allocator, out: *std.ArrayList(u8), line: []const u8, code_mask: []const bool) !void {
    var j: usize = 0;
    while (j < line.len) {
        if (code_mask[j]) {
            try out.append(a, line[j]);
            j += 1;
            continue;
        }
        if (line[j] == '\\' and j + 1 < line.len and !code_mask[j + 1]) {
            const n = line[j + 1];
            const lit: ?u21 = switch (n) {
                '*' => pua_lit_star,
                '_' => pua_lit_under,
                '`' => pua_lit_tick,
                '\\' => pua_lit_backslash,
                '~' => pua_lit_tilde,
                '$' => pua_lit_dollar,
                else => null,
            };
            if (lit) |cp| {
                try appendCp(out, a, cp);
                j += 2;
                continue;
            }
        }
        // intra-word underscore run → literal (GFM no-intra-word `_`, #336).
        // Feedback-dependent handlers above (code mask / escape / strike) have
        // already consumed their `_`, so any `_` reaching here is untouched.
        if (line[j] == '_') {
            j += try emitUnderscoreRun(a, out, line, j);
            continue;
        }
        try out.append(a, line[j]);
        j += 1;
    }
}

test "preprocess escapes star" {
    const out = try preprocessInlineSugar(std.testing.allocator, "\\*not\\*");
    defer std.testing.allocator.free(out);
    // should not contain raw \*
    try std.testing.expect(std.mem.indexOf(u8, out, "\\*") == null);
    var buf: [4]u8 = undefined;
    const n = try std.unicode.utf8Encode(pua_lit_star, &buf);
    try std.testing.expect(std.mem.indexOf(u8, out, buf[0..n]) != null);
}

test "preprocess strike" {
    const out = try preprocessInlineSugar(std.testing.allocator, "~~x~~");
    defer std.testing.allocator.free(out);
    var o: [4]u8 = undefined;
    var c: [4]u8 = undefined;
    const no = try std.unicode.utf8Encode(pua_strike_open, &o);
    const nc = try std.unicode.utf8Encode(pua_strike_close, &c);
    try std.testing.expect(std.mem.indexOf(u8, out, o[0..no]) != null);
    try std.testing.expect(std.mem.indexOf(u8, out, c[0..nc]) != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "x") != null);
}

test "preprocess skips fence body" {
    const src = "```\n~~not~~\n```\n";
    const out = try preprocessInlineSugar(std.testing.allocator, src);
    defer std.testing.allocator.free(out);
    try std.testing.expect(std.mem.indexOf(u8, out, "~~not~~") != null);
}
