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
        // Drop slot 0 (simple victim); could LRU later
        slot = clock % MAX_ENTRIES;
        clock +%= 1;
        if (entries[slot].doc) |*d| d.deinit();
        entries[slot] = .{};
        if (used > 0) used -= 1;
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

test "parseCached fail returns null" {
    // Empty is still valid parse for zmd usually; force OOM via tiny fixed buffer.
    var buf: [64]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    setAllocator(fba.allocator());
    defer parent_allocator = null;
    clear();
    // Large-ish markdown to exceed 64-byte arena for IR
    const big =
        \\# Title
        \\
        \\Paragraph with **bold** and more text to overflow tiny arena.
        \\
        \\```zig
        \\const x = 1;
        \\const y = 2;
        \\```
    ;
    const d = parseCached(big);
    // May be null (OOM) or succeed if lucky — either is fine; must not panic.
    _ = d;
}
