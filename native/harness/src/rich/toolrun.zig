//! Tool-run payload decoder (protocol v10, kind 6) — pure, host-testable.
//!
//! Mirror of `lib/toolRun.ts` (TS encoder). The host aggregates each
//! uninterrupted tool streak into one `tool_run` session message and encodes it
//! as versioned, tab/newline-delimited text:
//!
//!   toolrun\t1\t{ok}/{fail}/{pending}
//!   {id}\t{status}\t{name}\t{brief}\t{detail}
//!   ...
//!
//! `status ∈ running | ok | fail`. Fields `name`/`brief`/`detail` escape
//! `\t`, `\n`, `\\`. A malformed header or unknown `version` **fails open**
//! (returns null) so the caller renders the raw body as plain text and never
//! crashes. Malformed item lines are tolerated (skipped).
const std = @import("std");

pub const TOOL_RUN_VERSION: u8 = 1;
pub const MAX_ITEMS: u32 = 200;

pub const Status = enum(u8) {
    running = 0,
    ok = 1,
    fail = 2,
};

pub const Item = struct {
    id: u32,
    status: Status,
    name: []const u8,
    brief: []const u8,
    detail: []const u8,
};

pub const ToolRun = struct {
    ok: u32 = 0,
    fail: u32 = 0,
    pending: u32 = 0,
    items: []Item,
};

/// Owns the allocations backing a decoded `ToolRun` (string + item slices).
pub const Decoded = struct {
    run: ToolRun,
    alloc: std.mem.Allocator,

    pub fn deinit(self: *Decoded) void {
        for (self.run.items) |it| {
            self.alloc.free(it.name);
            self.alloc.free(it.brief);
            self.alloc.free(it.detail);
        }
        self.alloc.free(self.run.items);
    }
};

fn parseStatus(s: []const u8) ?Status {
    if (std.mem.eql(u8, s, "running")) return .running;
    if (std.mem.eql(u8, s, "ok")) return .ok;
    if (std.mem.eql(u8, s, "fail")) return .fail;
    return null;
}

fn parseIntOrZero(s: ?[]const u8) u32 {
    const v = s orelse return 0;
    return std.fmt.parseInt(u32, v, 10) catch 0;
}

/// Unescape `\t`→TAB, `\n`→LF, `\\`→backslash into a fresh buffer.
fn unescape(alloc: std.mem.Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '\\' and i + 1 < s.len) {
            const n = s[i + 1];
            if (n == 't') {
                try out.append(alloc, '\t');
                i += 1;
                continue;
            }
            if (n == 'n') {
                try out.append(alloc, '\n');
                i += 1;
                continue;
            }
            if (n == '\\') {
                try out.append(alloc, '\\');
                i += 1;
                continue;
            }
        }
        try out.append(alloc, c);
    }
    return try out.toOwnedSlice(alloc);
}

/// Decode a protocol v1 tool-run payload, allocating from `alloc` (use a
/// frame arena; call `Decoded.deinit` when the caller owns the lifetime).
/// Returns null (fail-open) on a malformed header or unknown version.
pub fn decode(alloc: std.mem.Allocator, text: []const u8) ?Decoded {
    var lines = std.mem.splitScalar(u8, text, '\n');
    const head = lines.next() orelse return null;
    var hf = std.mem.splitScalar(u8, head, '\t');
    const tag = hf.next() orelse return null;
    if (!std.mem.eql(u8, tag, "toolrun")) return null;
    const ver_s = hf.next() orelse return null;
    const ver = std.fmt.parseInt(u8, ver_s, 10) catch return null;
    if (ver != TOOL_RUN_VERSION) return null;
    const counts_s = hf.next() orelse return null;
    var cc = std.mem.splitScalar(u8, counts_s, '/');
    // Parsed for header validity only — we recount from the kept items below so
    // a hostile/dense blob's header can never disagree with what actually paints
    // (e.g. header "205/0/0" while the MAX_ITEMS cap keeps only 200 rows).
    _ = parseIntOrZero(cc.next());
    _ = parseIntOrZero(cc.next());
    _ = parseIntOrZero(cc.next());

    var items: std.ArrayList(Item) = .empty;
    errdefer items.deinit(alloc);
    // Defensive cap mirroring the host grouping bound (a restored/cloud/local
    // blob can carry more than MAX_ITEMS; stop so a hostile/dense payload can't
    // force unbounded per-item decode+unescape every frame).
    while (lines.next()) |lin| {
        if (items.items.len >= MAX_ITEMS) break;
        if (lin.len == 0) continue;
        var f = std.mem.splitScalar(u8, lin, '\t');
        const id_s = f.next() orelse continue;
        const status_s = f.next() orelse continue;
        const name_s = f.next() orelse continue;
        const brief_s = f.next() orelse continue;
        const detail_s = f.next() orelse continue;
        const id = std.fmt.parseInt(u32, id_s, 10) catch continue;
        const status = parseStatus(status_s) orelse continue;
        const name = unescape(alloc, name_s) catch continue;
        const brief = unescape(alloc, brief_s) catch continue;
        const detail = unescape(alloc, detail_s) catch continue;
        items.append(alloc, .{
            .id = id,
            .status = status,
            .name = name,
            .brief = brief,
            .detail = detail,
        }) catch return null;
    }
    // Recount statuses from the kept items so the UI header can never disagree
    // with the painted list after the MAX_ITEMS cap (review Minor).
    var ok: u32 = 0;
    var fail: u32 = 0;
    var pending: u32 = 0;
    for (items.items) |it| {
        switch (it.status) {
            .ok => ok += 1,
            .fail => fail += 1,
            .running => pending += 1,
        }
    }
    const run = ToolRun{
        .ok = ok,
        .fail = fail,
        .pending = pending,
        .items = items.toOwnedSlice(alloc) catch return null,
    };
    return .{ .run = run, .alloc = alloc };
}

test "decode round-trip with escaping" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Header counts are recounted from the kept items (review Minor), so even a
    // lying wire header `9/9/9` can never disagree with the painted items.
    const text =
        "toolrun\t1\t9/9/9\n" ++
        "1\tok\tread_file\tread_file lib/x.ts ok\tread_file · ✓ ok · lib/x.ts · 3 lines\n" ++
        "2\tfail\texec\t\texec · ✗ failed · exit=1\n" ++
        "3\trunning\tcat\tcat · running…\t";
    var d = decode(a, text) orelse return error.ExpectedDecode;
    defer d.deinit();

    try std.testing.expectEqual(@as(u32, 1), d.run.ok);
    try std.testing.expectEqual(@as(u32, 1), d.run.fail);
    try std.testing.expectEqual(@as(u32, 1), d.run.pending);
    try std.testing.expectEqual(@as(usize, 3), d.run.items.len);

    try std.testing.expectEqual(@as(u32, 1), d.run.items[0].id);
    try std.testing.expectEqual(Status.ok, d.run.items[0].status);
    try std.testing.expectEqualStrings("read_file", d.run.items[0].name);
    try std.testing.expectEqualStrings("read_file · ✓ ok · lib/x.ts · 3 lines", d.run.items[0].detail);

    try std.testing.expectEqual(Status.fail, d.run.items[1].status);
    try std.testing.expectEqual(Status.running, d.run.items[2].status);
    try std.testing.expectEqualStrings("cat · running…", d.run.items[2].brief);
}

test "decode escapes tab/newline/backslash" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const text = "toolrun\t1\t0/0/1\n" ++
        "1\tok\twith\\ttab\tline one\\nline two\tback\\\\slash\\tend";
    var d = decode(a, text) orelse return error.ExpectedDecode;
    defer d.deinit();
    try std.testing.expectEqualStrings("with\ttab", d.run.items[0].name);
    try std.testing.expectEqualStrings("line one\nline two", d.run.items[0].brief);
    try std.testing.expectEqualStrings("back\\slash\tend", d.run.items[0].detail);
}

test "decode fails open on bad header / unknown version" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try std.testing.expect(decode(a, "") == null);
    try std.testing.expect(decode(a, "garbage") == null);
    try std.testing.expect(decode(a, "toolrun\t99\t1/0/0") == null);
    try std.testing.expect(decode(a, "toolrun\tjunk\t1/0/0") == null);
    try std.testing.expect(decode(a, "notatoolrun\t1\t1/0/0") == null);
}

test "decode tolerates malformed item lines" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const text = "toolrun\t1\t1/0/0\n" ++
        "1\tok\tread_file\tbrief\tdetail\n" ++
        "bad.line" ++
        "\n2\twat\tbad\n";
    var d = decode(a, text) orelse return error.ExpectedDecode;
    defer d.deinit();
    try std.testing.expectEqual(@as(usize, 1), d.run.items.len);
    try std.testing.expectEqualStrings("read_file", d.run.items[0].name);
}

test "ui id packing is unique for a full group and across rows" {
    // Mirrors the IMGUI id scheme in `ui/toolrun.zig` paintToolRun: each item owns a
    // `item_stride`-wide namespace (`it_id * item_stride + slot`) under a row
    // that advances by `row_step` = msg_index *% 1000003. Serves as the
    // reviewer-requested cheap guard that MAX_ITEMS items never alias.
    const item_stride: usize = 1024;
    const row_step: usize = 1000003;
    const slot_max: usize = 4;

    // Within one row: every (item, slot) pair maps to a distinct widget id.
    var seen = std.AutoHashMap(u64, void).init(std.testing.allocator);
    defer seen.deinit();
    var it_id: usize = 1;
    while (it_id <= MAX_ITEMS) : (it_id += 1) {
        var slot: usize = 0;
        while (slot <= slot_max) : (slot += 1) {
            const id: u64 = @as(u64, it_id) * item_stride + slot;
            // fetchPut returns null when the key is new — a non-null result
            // means two (item, slot) pairs aliased.
            try std.testing.expect(try seen.fetchPut(id, {}) == null);
        }
    }
    // A full 200-item group's highest widget id stays below the next row step,
    // so two tool-run rows (distinct msg_index) never overlap widget id space.
    const group_span: u64 = @as(u64, MAX_ITEMS) * item_stride + slot_max;
    try std.testing.expect(group_span < row_step);
}

test "decode caps items at MAX_ITEMS (defense against dense/restored blobs)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const ta = a;
    var text = std.ArrayList(u8).empty;
    var line_buf: [128]u8 = undefined;
    const head = std.fmt.bufPrint(
        &line_buf,
        "toolrun\t{d}\t{d}/0/0\n",
        .{ TOOL_RUN_VERSION, MAX_ITEMS + 5 },
    ) catch unreachable;
    try text.appendSlice(ta, head);
    var i: u32 = 0;
    while (i < MAX_ITEMS + 5) : (i += 1) {
        const line = std.fmt.bufPrint(
            &line_buf,
            "{d}\tok\tt{d}\tbrief\tdetail\n",
            .{ i + 1, i },
        ) catch unreachable;
        try text.appendSlice(ta, line);
    }

    var d = decode(a, text.items) orelse return error.ExpectedDecode;
    defer d.deinit();
    try std.testing.expectEqual(@as(usize, MAX_ITEMS), d.run.items.len);
}
