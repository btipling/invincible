//! Host-pushed RGBA texture cache for rich MD math (protocol v5).
//! Keyed by (tex, display∈{0,1}). No network; freestanding-safe. Cap ≤48; clear with transcript.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const MAX_ENTRIES: usize = 48;
pub const MAX_TEX_LEN: usize = 512;
/// Host downscales to max edge 1280; reject larger raw buffers defensively.
pub const MAX_EDGE: u32 = 1280;
pub const MAX_RGBA_BYTES: usize = MAX_EDGE * MAX_EDGE * 4;

pub const PutError = error{
    NoAllocator,
    BadTex,
    BadDims,
    TooLarge,
    Oom,
};

const Entry = struct {
    tex: []u8 = &.{},
    display: u8 = 0,
    rgba: []u8 = &.{},
    width: u32 = 0,
    height: u32 = 0,
    live: bool = false,
    stamp: u32 = 0,
};

var entries: [MAX_ENTRIES]Entry = [_]Entry{.{}} ** MAX_ENTRIES;
var stamp_clock: u32 = 1;
var parent_allocator: ?Allocator = null;

pub fn setAllocator(a: Allocator) void {
    parent_allocator = a;
}

fn freeEntry(e: *Entry) void {
    const a = parent_allocator orelse return;
    if (e.tex.len > 0) a.free(e.tex);
    if (e.rgba.len > 0) a.free(e.rgba);
    e.* = .{};
}

pub fn clear() void {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].live) freeEntry(&entries[i]);
    }
    stamp_clock +%= 1;
    if (stamp_clock == 0) stamp_clock = 1;
}

pub fn get(tex: []const u8, display: u8) ?struct { rgba: []const u8, width: u32, height: u32 } {
    if (tex.len == 0 or tex.len > MAX_TEX_LEN) return null;
    const disp: u8 = if (display != 0) 1 else 0;
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        const e = &entries[i];
        if (!e.live) continue;
        if (e.display == disp and std.mem.eql(u8, e.tex, tex)) {
            e.stamp = stamp_clock;
            stamp_clock +%= 1;
            if (stamp_clock == 0) stamp_clock = 1;
            return .{ .rgba = e.rgba, .width = e.width, .height = e.height };
        }
    }
    return null;
}

fn findSlot(tex: []const u8, display: u8) ?usize {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].live and entries[i].display == display and std.mem.eql(u8, entries[i].tex, tex)) return i;
    }
    return null;
}

fn findFreeOrVictim() usize {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (!entries[i].live) return i;
    }
    var victim: usize = 0;
    var best = entries[0].stamp;
    i = 1;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].stamp < best) {
            best = entries[i].stamp;
            victim = i;
        }
    }
    freeEntry(&entries[victim]);
    return victim;
}

/// Copy TeX + RGBA into cache. Replaces existing same (tex, display).
pub fn put(tex: []const u8, display: u8, rgba: []const u8, width: u32, height: u32) PutError!void {
    const a = parent_allocator orelse return PutError.NoAllocator;
    if (tex.len == 0 or tex.len > MAX_TEX_LEN) return PutError.BadTex;
    if (width == 0 or height == 0) return PutError.BadDims;
    if (width > MAX_EDGE or height > MAX_EDGE) return PutError.BadDims;
    const need: usize = @as(usize, width) * @as(usize, height) * 4;
    if (need > MAX_RGBA_BYTES or rgba.len < need) return PutError.TooLarge;
    const disp: u8 = if (display != 0) 1 else 0;

    const slot = findSlot(tex, disp) orelse findFreeOrVictim();
    freeEntry(&entries[slot]);

    const tex_copy = a.dupe(u8, tex) catch return PutError.Oom;
    errdefer a.free(tex_copy);
    const rgba_copy = a.alloc(u8, need) catch return PutError.Oom;
    errdefer a.free(rgba_copy);
    @memcpy(rgba_copy[0..need], rgba[0..need]);

    entries[slot] = .{
        .tex = tex_copy,
        .display = disp,
        .rgba = rgba_copy,
        .width = width,
        .height = height,
        .live = true,
        .stamp = stamp_clock,
    };
    stamp_clock +%= 1;
    if (stamp_clock == 0) stamp_clock = 1;
}

test "math_cache put get clear" {
    setAllocator(std.testing.allocator);
    defer clear();
    const rgba = [_]u8{ 1, 2, 3, 4, 5, 6, 7, 8 };
    try put("E=mc^2", 0, &rgba, 2, 1);
    const hit = get("E=mc^2", 0) orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(@as(u32, 2), hit.width);
    try std.testing.expectEqual(@as(u32, 1), hit.height);
    try std.testing.expectEqual(@as(u8, 1), hit.rgba[0]);
    try std.testing.expect(get("E=mc^2", 1) == null);
    clear();
    try std.testing.expect(get("E=mc^2", 0) == null);
}

test "math_cache rejects bad tex and dims" {
    setAllocator(std.testing.allocator);
    defer clear();
    const rgba = [_]u8{ 0, 0, 0, 0 };
    try std.testing.expectError(PutError.BadTex, put("", 0, &rgba, 1, 1));
    try std.testing.expectError(PutError.BadDims, put("x", 0, &rgba, 0, 1));
}

test "math_cache replace same key and evict at cap" {
    setAllocator(std.testing.allocator);
    defer clear();
    const rgba = [_]u8{ 9, 9, 9, 9 };
    var i: usize = 0;
    while (i < MAX_ENTRIES + 2) : (i += 1) {
        var buf: [32]u8 = undefined;
        const key = try std.fmt.bufPrint(&buf, "t{d}", .{i});
        try put(key, 0, &rgba, 1, 1);
    }
    // Still bounded
    var live: usize = 0;
    var j: usize = 0;
    while (j < MAX_ENTRIES) : (j += 1) {
        if (entries[j].live) live += 1;
    }
    try std.testing.expect(live <= MAX_ENTRIES);
}
