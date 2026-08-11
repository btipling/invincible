//! Fingerprint cache for ParsedDoc — FNV-1a over full message body.
//! Cap ≤ 48 entries; generation bump on clear. No bridge import.
const std = @import("std");
const parse = @import("parse.zig");
const Allocator = std.mem.Allocator;

pub const MAX_ENTRIES: usize = 48;

const Entry = struct {
    fingerprint: u64 = 0,
    generation: u32 = 0,
    /// Owned; deinit on overwrite/clear.
    doc: ?parse.ParsedDoc = null,
};

var entries: [MAX_ENTRIES]Entry = [_]Entry{.{}} ** MAX_ENTRIES;
var generation: u32 = 1;
var clock: u32 = 1;
var used: usize = 0;
var parent_allocator: ?Allocator = null;

// ── #404 slot-keyed markdown parse cache ────────────────────────────────────
// The frame loop paints every in-ring message each frame. The flat 48-entry
// fingerprint cache re-parses ~N−48 messages per frame once the ring grows past
// 48. This growable cache is keyed on (physical ring slot, write-revision):
// an unchanged revision returns the stored `ParsedDoc` with zero body access
// and zero re-scan, so steady-state per-frame parse work is O(dirty) instead of
// O(N). Starts near zero (no static floor; composes with #350). Grows to the
// max physical slot actually painted and holds only real parsed content.

const SlotEntry = struct {
    revision: u32 = 0,
    /// Owned; deinit on overwrite/clear.
    doc: ?parse.ParsedDoc = null,
};

var slot_entries: std.ArrayList(SlotEntry) = .empty;

pub const SlotResult = struct {
    /// True when the returned doc came from the cache (unchanged revision) —
    /// the painter uses this to enable DVUI `cache_layout` on committed rows.
    hit: bool = false,
    /// The parsed doc (null on alloc failure / null allocator → paint plain).
    doc: ?*const parse.ParsedDoc = null,
};

/// Parse `src` for slot (physical ring index) with current `revision`, returning
/// the cached doc on an unchanged revision (no re-parse) or a freshly parsed doc.
/// `hit` distinguishes a cache hit (committed, immutable, safe to `cache_layout`)
/// from a fresh parse (dirty/live row that just changed). Never touches the flat
/// 48-entry fingerprint cache (kept for non-ring paints). Fail-open: null doc on
/// alloc failure / null allocator — caller paints plain.
pub fn parseSlot(slot: usize, revision: u32, src: []const u8) SlotResult {
    const a = parent_allocator orelse return .{};
    while (slot_entries.items.len <= slot) {
        slot_entries.append(a, .{}) catch return .{};
    }
    const e = &slot_entries.items[slot];
    if (e.doc != null and e.revision == revision) {
        return .{ .hit = true, .doc = &e.doc.? };
    }
    const doc = parse.parse(a, src) catch return .{};
    if (e.doc) |*d| d.deinit();
    e.doc = null;
    e.revision = revision;
    e.doc = doc;
    return .{ .doc = &e.doc.? };
}

/// Test helper: count live slot docs (revision matches nothing required).
pub fn slotLiveCount() usize {
    var n: usize = 0;
    for (slot_entries.items) |*e| {
        if (e.doc != null) n += 1;
    }
    return n;
}

/// Test helper: clear AND free the slot ArrayList backing buffer under the
/// allocator that owns it (host tests only — production uses a long-lived gpa
/// and never needs this; clear() intentionally retains capacity).
pub fn releaseForTest() void {
    clear();
    if (parent_allocator) |a| slot_entries.deinit(a);
    slot_entries = .empty;
    parent_allocator = null;
}

/// Set allocator used for parse arenas (call once from init, e.g. WebBackend.gpa).
pub fn setAllocator(a: Allocator) void {
    parent_allocator = a;
}

pub fn clear() void {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].doc) |*d| {
            d.deinit();
            entries[i].doc = null;
        }
        entries[i] = .{};
    }
    // #404 slot cache: deinit every cached doc and drop capacity references.
    for (slot_entries.items) |*e| {
        if (e.doc) |*d| d.deinit();
        e.doc = null;
    }
    slot_entries.clearRetainingCapacity();
    used = 0;
    generation +%= 1;
    if (generation == 0) generation = 1;
}

pub fn fingerprint(src: []const u8) u64 {
    return std.hash.Fnv1a_64.hash(src);
}

/// Parse+cache or return cached. On fail returns null (caller paints plain).
pub fn parseCached(src: []const u8) ?*const parse.ParsedDoc {
    const a = parent_allocator orelse return null;
    const fp = fingerprint(src);

    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].doc != null and entries[i].fingerprint == fp and entries[i].generation == generation) {
            return &entries[i].doc.?;
        }
    }

    const doc = parse.parse(a, src) catch return null;

    // Find free or victim slot
    var slot: usize = 0;
    var found_free = false;
    i = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].doc == null) {
            slot = i;
            found_free = true;
            break;
        }
    }
    if (!found_free) {
        // Clock victim; replace in place (live count stays MAX_ENTRIES).
        slot = clock % MAX_ENTRIES;
        clock +%= 1;
        if (entries[slot].doc) |*d| d.deinit();
        entries[slot] = .{};
        // used stays the same: one out, one in below
    }

    entries[slot] = .{
        .fingerprint = fp,
        .generation = generation,
        .doc = doc,
    };
    if (found_free) used += 1;
    return &entries[slot].doc.?;
}

/// Test helper: entry count with live docs this generation.
pub fn liveCount() usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].doc != null and entries[i].generation == generation) n += 1;
    }
    return n;
}

test "fingerprint stable and sensitive" {
    const a = "hello";
    const b = "hello";
    const c = "hellp";
    try std.testing.expectEqual(fingerprint(a), fingerprint(b));
    try std.testing.expect(fingerprint(a) != fingerprint(c));
}

test "parseCached hit and clear" {
    setAllocator(std.testing.allocator);
    defer {
        clear();
        parent_allocator = null;
    }
    clear();

    const src = "# Hello **x**";
    const d1 = parseCached(src);
    try std.testing.expect(d1 != null);
    try std.testing.expect(d1.?.blocks.len >= 1);
    const n1 = liveCount();
    try std.testing.expectEqual(@as(usize, 1), n1);

    const d2 = parseCached(src);
    try std.testing.expect(d2 != null);
    // Same storage
    try std.testing.expect(d1 == d2);
    try std.testing.expectEqual(@as(usize, 1), liveCount());

    clear();
    try std.testing.expectEqual(@as(usize, 0), liveCount());
    const d3 = parseCached(src);
    try std.testing.expect(d3 != null);
    try std.testing.expect(d3.?.blocks.len >= 1);
    try std.testing.expectEqual(@as(usize, 1), liveCount());
}

test "parseCached OOM returns null" {
    // Tiny fixed buffer forces arena OOM for non-trivial MD.
    var buf: [32]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    setAllocator(fba.allocator());
    defer {
        clear();
        parent_allocator = null;
    }
    clear();
    const big =
        \\# Title
        \\
        \\Paragraph with **bold** and more text to overflow tiny arena.
        \\
        \\```zig
        \\const x = 1;
        \\const y = 2;
        \\const z = 3;
        \\```
    ;
    const d = parseCached(big);
    try std.testing.expect(d == null);
    try std.testing.expectEqual(@as(usize, 0), liveCount());
}

test "parseCached null allocator returns null" {
    parent_allocator = null;
    clear();
    try std.testing.expect(parseCached("hello") == null);
}

// ── #404 slot-keyed cache tests ─────────────────────────────────────────────

test "parseSlot hit/reparse on revision, clear drops storage" {
    setAllocator(std.testing.allocator);
    defer releaseForTest();
    clear();
    try std.testing.expectEqual(@as(usize, 0), slotLiveCount());

    const src = "# Slot **doc**";
    // Revision 1 → fresh parse (miss), doc present, not a cache hit.
    const r1 = parseSlot(0, 1, src);
    try std.testing.expect(r1.doc != null);
    try std.testing.expect(!r1.hit);
    try std.testing.expectEqual(@as(usize, 1), slotLiveCount());

    // Unchanged revision 1 → cache hit, identical storage (deterministic: the
    // cached entry is returned directly, no re-parse), still one live.
    const r2 = parseSlot(0, 1, src);
    try std.testing.expect(r2.doc != null);
    try std.testing.expect(r2.hit);
    try std.testing.expect(r2.doc == r1.doc);
    try std.testing.expectEqual(@as(usize, 1), slotLiveCount());

    // Bumped revision 2 (same slot, e.g. stream growth) → re-parse, miss.
    const src2 = "# Slot **grew** doc";
    const r3 = parseSlot(0, 2, src2);
    try std.testing.expect(r3.doc != null);
    try std.testing.expect(!r3.hit);
    try std.testing.expectEqual(@as(usize, 1), slotLiveCount());

    // Distinct physical slots are isolated (ring wrap can't alias).
    const r4 = parseSlot(5, 1, src);
    try std.testing.expect(r4.doc != null);
    try std.testing.expect(!r4.hit);
    try std.testing.expectEqual(@as(usize, 2), slotLiveCount());

    // clear() deinits every cached doc and drops references.
    clear();
    try std.testing.expectEqual(@as(usize, 0), slotLiveCount());
}

test "parseSlot null allocator returns empty (fail-open)" {
    parent_allocator = null;
    clear();
    const r = parseSlot(0, 1, "# hi");
    try std.testing.expect(r.doc == null);
    try std.testing.expect(!r.hit);
}
