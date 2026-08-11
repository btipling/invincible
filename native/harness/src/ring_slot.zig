//! Pure transcript ring-slot write semantics backing `bridge.zig` (#404).
//!
//! Host-unit-tested (no dvui / wasm frame). The invariant pinned here:
//!
//!   EVERY write of a message body MUST bump the per-slot `revision`.
//!
//! `bridge.zig`'s slot-keyed parse + tool-run caches
//! (`rich/cache.zig` / `rich/toolrun_cache.zig`) key on (physical slot,
//! revision) as O(1) dirty detection — an unchanged revision costs zero
//! re-parse / re-decode / body scan, while a **forgotten** bump would show
//! STALE markdown / stale decode on a committed row until the ring is cleared
//! or the app restarts.
//!
//! Rather than rely on every producer remembering to `slot.revision +%= 1`,
//! the bump lives inside the single write seam (`write`) that all three
//! producers (user-send, `push`, `update_last`) are required to route through,
//! so forgetting the bump is structurally impossible — the model only exposes
//! a write that already bumps.
const std = @import("std");

/// Cap per transcript line (UTF-8 bytes). Host truncates to this before
/// push/update. Mirrors `bridge.MAX_MSG_LEN`. 256 KiB — long thinking /
/// assistant monologues (caution-theater 4–64 KiB removed).
pub const MAX_MSG_LEN: usize = 262144;

/// Transcript ring slot. `revision` is the per-slot monotonic dirty-revision
/// for #404 (last write generation). Internal (read in-Wasm, never exported —
/// no `build.zig` export_symbol_names change).
pub const Slot = struct {
    kind: u8 = 0,
    len: u32 = 0,
    data: [MAX_MSG_LEN]u8 = undefined,
    /// Monotonic write-revision. Bumped by `write` on every body write. The
    /// painter's slot-keyed parse + tool-run caches compare against it as O(1)
    /// dirty detection — an unchanged revision costs zero re-parse / re-decode /
    /// body scan.
    revision: u32 = 0,
};

/// Set `kind`, copy `src` into `slot.data` (capacity-clamped to MAX_MSG_LEN),
/// and bump `slot.revision`. This is THE single body-write seam for a ring
/// slot; every producer must route through here so the #404 dirty-bump can
/// never be skipped. `u32 +%=` wrapping is fine — a slot needs ~4e9 writes to a
/// single physical slot to alias (it would also need the same cache entry to
/// survive that long), and matches the old explicit `+%=` semantics.
pub fn write(slot: *Slot, kind: u8, src: []const u8) void {
    slot.kind = kind;
    const n = @min(slot.data.len, src.len);
    if (n > 0) @memcpy(slot.data[0..n], src[0..n]);
    slot.len = @intCast(n);
    slot.revision +%= 1; // #404 dirty bump — never optional on a body write.
}

test "write stores kind and body and bumps revision once" {
    var slot: Slot = .{};
    try std.testing.expectEqual(@as(u32, 0), slot.revision);

    write(&slot, 2, "hello");

    try std.testing.expectEqual(@as(u8, 2), slot.kind);
    try std.testing.expectEqual(@as(u32, 5), slot.len);
    try std.testing.expectEqualSlices(u8, "hello", slot.data[0..5]);
    try std.testing.expectEqual(@as(u32, 1), slot.revision);
}

test "every write bumps revision (repeated / overwrite)" {
    var slot: Slot = .{};
    write(&slot, 1, "a");
    write(&slot, 1, "ab");
    write(&slot, 2, "abc");
    try std.testing.expectEqual(@as(u32, 3), slot.revision);
    try std.testing.expectEqual(@as(u32, 3), slot.len);
    try std.testing.expectEqualSlices(u8, "abc", slot.data[0..3]);
}

test "kind is mutable and revision advances independently of kind" {
    var slot: Slot = .{};
    write(&slot, 1, "x");
    write(&slot, 5, "y");
    try std.testing.expectEqual(@as(u8, 5), slot.kind);
    try std.testing.expectEqual(@as(u32, 2), slot.revision);
}

test "empty body still bumps revision (streaming live row starts empty)" {
    var slot: Slot = .{};
    write(&slot, 2, "");
    try std.testing.expectEqual(@as(u32, 0), slot.len);
    // A live `update_last` row becomes coherent only if even its first (empty)
    // write bumps — otherwise the very first stream frame would be seen as
    // "unchanged" and never re-parse as bytes arrive.
    try std.testing.expectEqual(@as(u32, 1), slot.revision);
}

test "write clamps to MAX_MSG_LEN" {
    var slot: Slot = .{};
    var big: [MAX_MSG_LEN + 64]u8 = undefined;
    @memset(&big, 0x41); // 'A'
    write(&slot, 2, &big);
    try std.testing.expectEqual(@as(u32, MAX_MSG_LEN), slot.len);
    // Never writes past the slot's own data buffer.
    try std.testing.expectEqual(@as(u8, 'A'), slot.data[MAX_MSG_LEN - 1]);
}

test "revision does not alias after many writes (u32 +%= semantics)" {
    var slot: Slot = .{};
    // Exercising the wrap path at the extremes: force-revision near the top of
    // the u32 range, confirm a following write advances (not stays).
    slot.revision = std.math.maxInt(u32) - 1;
    write(&slot, 2, "z");
    try std.testing.expectEqual(@as(u32, std.math.maxInt(u32)), slot.revision);
    write(&slot, 2, "zz");
    try std.testing.expectEqual(@as(u32, 0), slot.revision);
    write(&slot, 2, "zzz");
    try std.testing.expectEqual(@as(u32, 1), slot.revision);
}
