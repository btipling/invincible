//! Pure session-rail catalog (protocol v17).
//! No dvui — host-testable in `test-rich`. Paint lives in `transcript_split.zig`.
const std = @import("std");

pub const MAX_SESSION_CATALOG: u32 = 256;
pub const MAX_SESSION_ID_LEN: usize = 512;
pub const MAX_SESSION_LABEL_LEN: usize = 128;

const Entry = struct {
    id_len: u32 = 0,
    label_len: u32 = 0,
    id: [MAX_SESSION_ID_LEN]u8 = undefined,
    label: [MAX_SESSION_LABEL_LEN]u8 = undefined,
};

var entries: [MAX_SESSION_CATALOG]Entry = [_]Entry{.{}} ** MAX_SESSION_CATALOG;
var count: u32 = 0;
var current: ?u32 = null;
var busy: bool = false;
var has_pending: bool = false;
var pending_id: [MAX_SESSION_ID_LEN]u8 = undefined;
var pending_len: u32 = 0;

pub fn reset() void {
    clear();
    busy = false;
    // reset (harness onInit) drops pending; catalog rewrite via clear() must not.
    has_pending = false;
    pending_len = 0;
}

pub fn clear() void {
    count = 0;
    current = null;
    // Session pending is navigation state (user wants to leave this session),
    // NOT a durable setting like the model pick. Drop it on clear so a catalog
    // rewrite (host setSessionCatalog = clear + repush) does not replay a stale
    // click after the user already navigated away via New/Clear.
    has_pending = false;
    pending_len = 0;
}

pub fn setBusy(v: bool) void {
    busy = v;
}

pub fn isBusy() bool {
    return busy;
}

pub fn catalogCount() u32 {
    return count;
}

pub fn currentIndex() ?u32 {
    return current;
}

pub fn isRedisSafeId(id: []const u8) bool {
    if (id.len == 0 or id.len > MAX_SESSION_ID_LEN) return false;
    for (id) |c| {
        const ok = (c >= 'A' and c <= 'Z') or
            (c >= 'a' and c <= 'z') or
            (c >= '0' and c <= '9') or
            c == '_' or
            c == '-';
        if (!ok) return false;
    }
    return true;
}

fn copyInto(dest: []u8, src: []const u8) u32 {
    const n = @min(dest.len, src.len);
    if (n > 0) @memcpy(dest[0..n], src[0..n]);
    return @intCast(n);
}

/// Accept one id+label. Returns false on reject (does not mutate).
pub fn push(id: []const u8, label: []const u8) bool {
    if (count >= MAX_SESSION_CATALOG) return false;
    if (!isRedisSafeId(id)) return false;
    if (label.len == 0 or label.len > MAX_SESSION_LABEL_LEN) return false;
    if (!std.unicode.utf8ValidateSlice(label)) return false;
    const slot = &entries[count];
    slot.id_len = copyInto(&slot.id, id);
    slot.label_len = copyInto(&slot.label, label);
    count += 1;
    return true;
}

pub fn idAt(i: u32) []const u8 {
    if (i >= count) return &.{};
    return entries[i].id[0..entries[i].id_len];
}

pub fn labelAt(i: u32) []const u8 {
    if (i >= count) return &.{};
    return entries[i].label[0..entries[i].label_len];
}

/// Empty id clears highlight. Unknown id → false, highlight unchanged.
pub fn setCurrent(id: []const u8) bool {
    if (id.len == 0) {
        current = null;
        return true;
    }
    if (!isRedisSafeId(id)) return false;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        if (std.mem.eql(u8, idAt(i), id)) {
            current = i;
            return true;
        }
    }
    return false;
}

/// Click a row. Busy / current / oob → no pending.
pub fn requestSwitch(i: u32) bool {
    if (busy) return false;
    if (i >= count) return false;
    if (current != null and current.? == i) return false;
    const id = idAt(i);
    pending_len = copyInto(&pending_id, id);
    has_pending = true;
    return true;
}

pub fn hasPending() bool {
    return has_pending;
}

pub fn pendingId() []const u8 {
    if (!has_pending) return &.{};
    return pending_id[0..pending_len];
}

pub fn ackPending() void {
    has_pending = false;
    pending_len = 0;
}

test "push + count + reject empty / bad id / oversize label" {
    reset();
    try std.testing.expect(push("sess-aaa", "Hello"));
    try std.testing.expectEqual(@as(u32, 1), catalogCount());
    try std.testing.expect(!push("", "x"));
    try std.testing.expect(!push("has space", "x"));
    try std.testing.expect(!push("sess-bbb", ""));
    const long = "x" ** (MAX_SESSION_LABEL_LEN + 1);
    try std.testing.expect(!push("sess-bbb", long));
    try std.testing.expectEqual(@as(u32, 1), catalogCount());
}

test "invalid utf8 label rejected" {
    reset();
    const bad = [_]u8{ 0xff, 0xfe };
    try std.testing.expect(!push("sess-ccc", &bad));
    try std.testing.expectEqual(@as(u32, 0), catalogCount());
}

test "257th rejected; earlier kept" {
    reset();
    var i: u32 = 0;
    while (i < MAX_SESSION_CATALOG) : (i += 1) {
        var buf: [16]u8 = undefined;
        const id = std.fmt.bufPrint(&buf, "id-{d:0>8}", .{i}) catch unreachable;
        try std.testing.expect(push(id, "L"));
    }
    try std.testing.expectEqual(MAX_SESSION_CATALOG, catalogCount());
    try std.testing.expect(!push("id-overflow1", "L"));
    try std.testing.expectEqual(MAX_SESSION_CATALOG, catalogCount());
}

test "setCurrent highlight; unknown rejected; empty clears" {
    reset();
    try std.testing.expect(push("sess-a", "A"));
    try std.testing.expect(push("sess-b", "B"));
    try std.testing.expect(setCurrent("sess-b"));
    try std.testing.expectEqual(@as(u32, 1), currentIndex().?);
    try std.testing.expect(!setCurrent("sess-missing"));
    try std.testing.expectEqual(@as(u32, 1), currentIndex().?);
    try std.testing.expect(setCurrent(""));
    try std.testing.expect(currentIndex() == null);
}

test "requestSwitch: non-current sets pending; current / busy do not" {
    reset();
    try std.testing.expect(push("sess-a", "A"));
    try std.testing.expect(push("sess-b", "B"));
    try std.testing.expect(setCurrent("sess-a"));
    try std.testing.expect(!requestSwitch(0));
    try std.testing.expect(!hasPending());
    try std.testing.expect(requestSwitch(1));
    try std.testing.expect(hasPending());
    try std.testing.expectEqualStrings("sess-b", pendingId());
    ackPending();
    try std.testing.expect(!hasPending());
    setBusy(true);
    try std.testing.expect(!requestSwitch(1));
    try std.testing.expect(!hasPending());
}

test "last click wins pending" {
    reset();
    try std.testing.expect(push("sess-a", "A"));
    try std.testing.expect(push("sess-b", "B"));
    try std.testing.expect(push("sess-c", "C"));
    try std.testing.expect(requestSwitch(1));
    try std.testing.expect(requestSwitch(2));
    try std.testing.expectEqualStrings("sess-c", pendingId());
}

test "clear drops pending; reset also drops it" {
    reset();
    try std.testing.expect(push("sess-a", "A"));
    try std.testing.expect(push("sess-b", "B"));
    try std.testing.expect(requestSwitch(1));
    try std.testing.expect(hasPending());
    clear();
    // Session pending is navigation state — clear() must drop it so a catalog
    // rewrite (host setSessionCatalog) does not replay a stale click.
    try std.testing.expect(!hasPending());
    try std.testing.expectEqual(@as(usize, 0), pendingId().len);
    try std.testing.expectEqual(@as(u32, 0), catalogCount());
    try std.testing.expect(currentIndex() == null);
    // reset() also works (harness onInit path).
    try std.testing.expect(push("sess-c", "C"));
    try std.testing.expect(requestSwitch(0));
    try std.testing.expect(hasPending());
    reset();
    try std.testing.expect(!hasPending());
    try std.testing.expectEqual(@as(usize, 0), pendingId().len);
}
