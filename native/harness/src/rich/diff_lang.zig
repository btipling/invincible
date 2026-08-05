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
pub fn classifyLine(line: []const u8) LineKind {
    if (line.len == 0) return .context;
    // File headers / hunk headers before single +/- rules
    if (std.mem.startsWith(u8, line, "+++") or std.mem.startsWith(u8, line, "---")) return .meta;
    if (line[0] == '@') return .meta;
    if (line[0] == '+') return .add;
    if (line[0] == '-') return .del;
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

test "classifyLine" {
    try std.testing.expectEqual(LineKind.add, classifyLine("+foo"));
    try std.testing.expectEqual(LineKind.del, classifyLine("-bar"));
    try std.testing.expectEqual(LineKind.meta, classifyLine("@@ -1,2 +3,4 @@"));
    try std.testing.expectEqual(LineKind.meta, classifyLine("--- a/x"));
    try std.testing.expectEqual(LineKind.meta, classifyLine("+++ b/x"));
    try std.testing.expectEqual(LineKind.context, classifyLine(" context"));
    try std.testing.expectEqual(LineKind.context, classifyLine(""));
    // +++ / --- take precedence over single +/-
    try std.testing.expectEqual(LineKind.meta, classifyLine("+++"));
    try std.testing.expectEqual(LineKind.meta, classifyLine("---"));
}
