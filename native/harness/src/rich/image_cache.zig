//! Host-pushed RGBA texture cache for rich MD images (protocol v4).
//! No network; freestanding-safe. Cap ≤24 entries; clear with transcript.
const std = @import("std");
const link_url = @import("link_url.zig");
const Allocator = std.mem.Allocator;

pub const MAX_ENTRIES: usize = 24;
pub const MAX_URL_LEN: usize = 2048;
/// Host downscales to max edge 1280; reject larger raw buffers defensively.
pub const MAX_EDGE: u32 = 1280;
pub const MAX_RGBA_BYTES: usize = MAX_EDGE * MAX_EDGE * 4;

pub const PutError = error{
    NoAllocator,
    BadUrl,
    BadDims,
    TooLarge,
    Oom,
};

const Entry = struct {
    url: []u8 = &.{},
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
    if (e.url.len > 0) a.free(e.url);
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

pub fn get(url: []const u8) ?struct { rgba: []const u8, width: u32, height: u32 } {
    if (url.len == 0 or url.len > MAX_URL_LEN) return null;
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        const e = &entries[i];
        if (!e.live) continue;
        if (std.mem.eql(u8, e.url, url)) {
            e.stamp = stamp_clock;
            stamp_clock +%= 1;
            if (stamp_clock == 0) stamp_clock = 1;
            return .{ .rgba = e.rgba, .width = e.width, .height = e.height };
        }
    }
    return null;
}

fn findUrlSlot(url: []const u8) ?usize {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].live and std.mem.eql(u8, entries[i].url, url)) return i;
    }
    return null;
}

fn findFreeOrVictim() usize {
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (!entries[i].live) return i;
    }
    // LRU: lowest stamp
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

/// Copy URL + RGBA into cache. Replaces existing same URL.
pub fn put(url: []const u8, rgba: []const u8, width: u32, height: u32) PutError!void {
    const a = parent_allocator orelse return PutError.NoAllocator;
    if (url.len == 0 or url.len > MAX_URL_LEN) return PutError.BadUrl;
    if (!link_url.isSafeLinkUrl(url)) return PutError.BadUrl;
    if (width == 0 or height == 0) return PutError.BadDims;
    if (width > MAX_EDGE or height > MAX_EDGE) return PutError.TooLarge;
    const need: usize = @as(usize, width) * @as(usize, height) * 4;
    if (rgba.len < need or need > MAX_RGBA_BYTES) return PutError.TooLarge;

    const slot = findUrlSlot(url) orelse findFreeOrVictim();
    if (entries[slot].live) freeEntry(&entries[slot]);

    const url_owned = a.dupe(u8, url) catch return PutError.Oom;
    errdefer a.free(url_owned);
    const rgba_owned = a.dupe(u8, rgba[0..need]) catch return PutError.Oom;

    entries[slot] = .{
        .url = url_owned,
        .rgba = rgba_owned,
        .width = width,
        .height = height,
        .live = true,
        .stamp = stamp_clock,
    };
    stamp_clock +%= 1;
    if (stamp_clock == 0) stamp_clock = 1;
}

pub fn countLive() usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < MAX_ENTRIES) : (i += 1) {
        if (entries[i].live) n += 1;
    }
    return n;
}

test "image_cache put get clear" {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const a = gpa.allocator();
    setAllocator(a);
    defer clear();

    const url = "https://example.com/a.png";
    var px = [_]u8{ 255, 0, 0, 255 } ** 4; // 2x2
    try put(url, px[0..], 2, 2);
    try std.testing.expectEqual(@as(usize, 1), countLive());
    const hit = get(url) orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(@as(u32, 2), hit.width);
    try std.testing.expectEqual(@as(u32, 2), hit.height);
    try std.testing.expectEqual(@as(usize, 16), hit.rgba.len);

    clear();
    try std.testing.expectEqual(@as(usize, 0), countLive());
    try std.testing.expect(get(url) == null);
}

test "image_cache rejects bad url and dims" {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    setAllocator(gpa.allocator());
    defer clear();

    var px = [_]u8{0} ** 16;
    try std.testing.expectError(PutError.BadUrl, put("javascript:alert(1)", px[0..], 2, 2));
    try std.testing.expectError(PutError.BadUrl, put("data:image/png;base64,xx", px[0..], 2, 2));
    try std.testing.expectError(PutError.BadDims, put("https://example.com/x.png", px[0..], 0, 2));
    try std.testing.expectError(PutError.BadUrl, put("", px[0..], 2, 2));
}

test "image_cache replace same url and evict at cap" {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    setAllocator(gpa.allocator());
    defer clear();

    var px = [_]u8{1} ** 16;
    var i: usize = 0;
    while (i < MAX_ENTRIES + 2) : (i += 1) {
        var buf: [64]u8 = undefined;
        const url = try std.fmt.bufPrint(&buf, "https://example.com/{d}.png", .{i});
        try put(url, px[0..], 2, 2);
    }
    try std.testing.expectEqual(MAX_ENTRIES, countLive());
    // Replace existing
    try put("https://example.com/5.png", px[0..], 2, 2);
    try std.testing.expectEqual(MAX_ENTRIES, countLive());
}
