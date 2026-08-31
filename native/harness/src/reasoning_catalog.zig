//! Pure helpers for the status-bar reasoning-effort picker (plan #898).
//! No dvui, no wasm refresh — host-testable in `test-rich`.
const std = @import("std");

/// Chevron only when there is more than one effort to pick.
pub fn showChevron(count: u32) bool {
    return count > 1;
}

/// Picks are ignored while a turn is Busy (same lock as the model picker).
pub fn canCommit(busy: bool) bool {
    return !busy;
}

/// `null` if the list is empty or `requested` is out of range.
pub fn chooseIndex(count: u32, requested: u32) ?u32 {
    if (count == 0 or requested >= count) return null;
    return requested;
}

/// Gateway effort tokens: `^[a-z0-9_-]{1,max_len}$`.
pub fn isEffortToken(src: []const u8, max_len: usize) bool {
    if (src.len == 0 or src.len > max_len) return false;
    for (src) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '_' or c == '-';
        if (!ok) return false;
    }
    return true;
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

test "chooseIndex: empty / oob / ok" {
    try std.testing.expect(chooseIndex(0, 0) == null);
    try std.testing.expect(chooseIndex(3, 3) == null);
    try std.testing.expectEqual(@as(u32, 2), chooseIndex(3, 2).?);
}

test "isEffortToken: charset + length" {
    try std.testing.expect(isEffortToken("low", 32));
    try std.testing.expect(isEffortToken("xhigh", 32));
    try std.testing.expect(isEffortToken("provider-default", 32));
    try std.testing.expect(isEffortToken("max", 32));
    try std.testing.expect(!isEffortToken("", 32));
    try std.testing.expect(!isEffortToken("LOW", 32));
    try std.testing.expect(!isEffortToken("has space", 32));
    try std.testing.expect(!isEffortToken("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 32));
    try std.testing.expect(!isEffortToken("x", 0));
}
