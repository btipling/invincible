//! Pure catalog helpers for the status-bar model picker.
//! No dvui, no wasm refresh — host-testable in `test-rich`.
const std = @import("std");

/// Short label: after the last `/`, else the full id.
pub fn shortLabel(id: []const u8) []const u8 {
    if (id.len == 0) return id;
    var last_slash: ?usize = null;
    for (id, 0..) |c, i| {
        if (c == '/') last_slash = i;
    }
    if (last_slash) |s| {
        if (s + 1 < id.len) return id[s + 1 ..];
    }
    return id;
}

/// `null` if the catalog is empty or `requested` is out of range.
pub fn chooseIndex(count: u32, requested: u32) ?u32 {
    if (count == 0 or requested >= count) return null;
    return requested;
}

/// Chevron only when there is more than one model to pick.
pub fn showChevron(count: u32) bool {
    return count > 1;
}

/// Picks are ignored while a turn is Busy (same lock as the old Next button).
pub fn canCommit(busy: bool) bool {
    return !busy;
}

test "shortLabel: last slash segment" {
    try std.testing.expectEqualStrings("claude-sonnet-4", shortLabel("anthropic/claude-sonnet-4"));
}

test "shortLabel: no slash is unchanged" {
    try std.testing.expectEqualStrings("local-model", shortLabel("local-model"));
}

test "shortLabel: empty" {
    try std.testing.expectEqualStrings("", shortLabel(""));
}

test "shortLabel: trailing slash keeps full id" {
    try std.testing.expectEqualStrings("anthropic/", shortLabel("anthropic/"));
}

test "chooseIndex: empty / oob / ok" {
    try std.testing.expect(chooseIndex(0, 0) == null);
    try std.testing.expect(chooseIndex(3, 3) == null);
    try std.testing.expectEqual(@as(u32, 2), chooseIndex(3, 2).?);
}

test "showChevron: only when count > 1" {
    try std.testing.expect(!showChevron(0));
    try std.testing.expect(!showChevron(1));
    try std.testing.expect(showChevron(2));
}

test "canCommit: blocked while busy" {
    try std.testing.expect(canCommit(false));
    try std.testing.expect(!canCommit(true));
}
