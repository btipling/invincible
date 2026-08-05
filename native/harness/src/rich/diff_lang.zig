//! Diff fence lang gate + unified-diff line classification (no dvui).
const std = @import("std");

/// True when fence info string is `diff` or `patch` (ASCII, case-insensitive, trimmed).
pub fn isDiffLang(meta: ?[]const u8) bool {
    const raw = meta orelse return false;
    const t = std.mem.trim(u8, raw, " \t\r\n");
    if (t.len == 0) return false;
    if (eqlIgnoreCase(t, "diff")) return true;
    if (eqlIgnoreCase(t, "patch")) return true;
    return false;
}

pub const LineKind = enum {
    add,
    del,
    meta,
    context,
};

/// Classify a single unified-diff line (without trailing newline).
///
/// `in_hunk`: true after a `@@` hunk header has been seen in this fence.
/// Before the first hunk, `---` / `+++` (and common git headers) are meta.
/// Inside a hunk, only the first character decides add/del so body lines like
/// `---verbose` (delete of `--verbose`) stay `.del`, not false meta.
pub fn classifyLine(line: []const u8, in_hunk: bool) LineKind {
    if (line.len == 0) return .context;
    // Hunk header (also transitions caller into in_hunk).
    if (std.mem.startsWith(u8, line, "@@")) return .meta;
    if (!in_hunk) {
        // File headers / git prelude only valid outside hunks.
        if (std.mem.startsWith(u8, line, "+++") or std.mem.startsWith(u8, line, "---")) return .meta;
        if (std.mem.startsWith(u8, line, "diff ")) return .meta;
        if (std.mem.startsWith(u8, line, "index ")) return .meta;
    }
    if (line[0] == '+') return .add;
    if (line[0] == '-') return .del;
    if (line[0] == '@') return .meta;
    return .context;
}

fn eqlIgnoreCase(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |ac, bc| {
        const al: u8 = if (ac >= 'A' and ac <= 'Z') ac + 32 else ac;
        const bl: u8 = if (bc >= 'A' and bc <= 'Z') bc + 32 else bc;
        if (al != bl) return false;
    }
    return true;
}

test "isDiffLang" {
    try std.testing.expect(isDiffLang("diff"));
    try std.testing.expect(isDiffLang("DIFF"));
    try std.testing.expect(isDiffLang(" patch "));
    try std.testing.expect(isDiffLang("Patch"));
    try std.testing.expect(!isDiffLang(null));
    try std.testing.expect(!isDiffLang(""));
    try std.testing.expect(!isDiffLang("zig"));
    try std.testing.expect(!isDiffLang("diffx"));
}

test "classifyLine outside hunk" {
    try std.testing.expectEqual(LineKind.meta, classifyLine("--- a/x", false));
    try std.testing.expectEqual(LineKind.meta, classifyLine("+++ b/x", false));
    try std.testing.expectEqual(LineKind.meta, classifyLine("+++", false));
    try std.testing.expectEqual(LineKind.meta, classifyLine("---", false));
    try std.testing.expectEqual(LineKind.meta, classifyLine("diff --git a/x b/x", false));
    try std.testing.expectEqual(LineKind.meta, classifyLine("index abc..def 100644", false));
    try std.testing.expectEqual(LineKind.add, classifyLine("+foo", false));
    try std.testing.expectEqual(LineKind.del, classifyLine("-bar", false));
    try std.testing.expectEqual(LineKind.context, classifyLine(" context", false));
    try std.testing.expectEqual(LineKind.context, classifyLine("", false));
}

test "classifyLine inside hunk" {
    try std.testing.expectEqual(LineKind.meta, classifyLine("@@ -1,2 +3,4 @@", true));
    try std.testing.expectEqual(LineKind.add, classifyLine("+foo", true));
    try std.testing.expectEqual(LineKind.del, classifyLine("-bar", true));
    // Delete of `--verbose` / add of `++x` must not become meta
    try std.testing.expectEqual(LineKind.del, classifyLine("---verbose", true));
    try std.testing.expectEqual(LineKind.add, classifyLine("++++", true));
    try std.testing.expectEqual(LineKind.del, classifyLine("----", true));
    try std.testing.expectEqual(LineKind.context, classifyLine(" context", true));
}

test "classifyLine hunk transition sample" {
    // Simulate prelude → hunk → body with flag-shaped lines
    const lines = [_][]const u8{
        "diff --git a/cli b/cli",
        "--- a/cli",
        "+++ b/cli",
        "@@ -1 +1 @@",
        "---verbose",
        "+-v",
    };
    var in_hunk = false;
    const expect = [_]LineKind{ .meta, .meta, .meta, .meta, .del, .add };
    for (lines, expect) |line, want| {
        const kind = classifyLine(line, in_hunk);
        try std.testing.expectEqual(want, kind);
        if (std.mem.startsWith(u8, line, "@@")) in_hunk = true;
    }
}
