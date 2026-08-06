//! Fence-aware GFM pipe-table partition (zmd has no table nodes @ pin).
//! Emits structured cells for dvui Grid paint (no box-drawing glyphs).
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const MAX_COLS: usize = 12;
pub const MAX_ROWS: usize = 40; // header + body after sep consumed

/// GFM separator-derived column alignment (separator row only).
pub const Align = enum(u8) {
    default,
    left,
    center,
    right,

    pub fn toCode(self: Align) u8 {
        return switch (self) {
            .default => 'd',
            .left => 'l',
            .center => 'c',
            .right => 'r',
        };
    }

    pub fn fromCode(c: u8) Align {
        return switch (c) {
            'l' => .left,
            'c' => .center,
            'r' => .right,
            'd' => .default,
            else => .default,
        };
    }

    /// Paint gravity / label align_x (left and default are identical).
    pub fn paintX(self: Align) f32 {
        return switch (self) {
            .center => 0.5,
            .right => 1.0,
            .left, .default => 0.0,
        };
    }
};

pub const TableData = struct {
    cols: usize,
    /// Row-major cell texts (allocator-owned slices). Header is first row when has_header.
    cells: []const []const u8,
    has_header: bool,
    overflow_rows: usize = 0,
    /// Length == cols; allocator-owned. Separator-derived GFM align codes.
    aligns: []const Align,

    pub fn deinit(self: TableData, a: Allocator) void {
        for (self.cells) |c| a.free(c);
        a.free(self.cells);
        a.free(self.aligns);
    }

    pub fn rowCount(self: TableData) usize {
        if (self.cols == 0) return 0;
        return self.cells.len / self.cols;
    }
};

/// Pack aligns into `lcrd…` codes (exactly `aligns.len` bytes into `buf`).
pub fn packAligns(aligns: []const Align, buf: []u8) []const u8 {
    const n = @min(aligns.len, buf.len);
    var i: usize = 0;
    while (i < n) : (i += 1) buf[i] = aligns[i].toCode();
    return buf[0..n];
}

/// Soft-fail decode: missing/invalid → default; extra ignored. Fills `out[0..cols]`.
pub fn unpackAligns(codes: []const u8, cols: usize, out: []Align) void {
    var i: usize = 0;
    while (i < cols and i < out.len) : (i += 1) {
        out[i] = if (i < codes.len) Align.fromCode(codes[i]) else .default;
    }
}

pub const Segment = struct {
    is_table: bool,
    /// Non-table: raw source span (allocator-owned).
    text: []const u8 = "",
    /// Table payload (owned cells); only when is_table.
    table: ?TableData = null,
};

fn leadSkip(line: []const u8) usize {
    var i: usize = 0;
    var n: usize = 0;
    while (i < line.len and n < 3 and line[i] == ' ') : (i += 1) n += 1;
    return i;
}

pub fn isPipeRow(line: []const u8) bool {
    const i = leadSkip(line);
    if (i >= line.len) return false;
    if (std.mem.indexOfScalar(u8, line[i..], '|') == null) return false;
    return hasNonWs(line[i..]);
}

pub fn hasNonWs(s: []const u8) bool {
    for (s) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return true;
    }
    return false;
}

fn trimWs(s: []const u8) []const u8 {
    var a: usize = 0;
    var b: usize = s.len;
    while (a < b and (s[a] == ' ' or s[a] == '\t')) : (a += 1) {}
    while (b > a and (s[b - 1] == ' ' or s[b - 1] == '\t')) : (b -= 1) {}
    return s[a..b];
}

pub fn splitCells(line: []const u8, out: [][]const u8) usize {
    const start = leadSkip(line);
    var body = line[start..];
    body = trimWs(body);
    if (body.len > 0 and body[0] == '|') body = body[1..];
    body = trimWs(body);
    if (body.len > 0 and body[body.len - 1] == '|') body = body[0 .. body.len - 1];

    var n: usize = 0;
    var i: usize = 0;
    while (i <= body.len and n < out.len) {
        const cell_start = i;
        while (i < body.len and body[i] != '|') : (i += 1) {}
        out[n] = trimWs(body[cell_start..i]);
        n += 1;
        if (i >= body.len) break;
        i += 1;
    }
    return n;
}

fn isSepCell(cell: []const u8) bool {
    const t = trimWs(cell);
    if (t.len < 3) return false;
    var i: usize = 0;
    if (t[i] == ':') i += 1;
    var dashes: usize = 0;
    while (i < t.len and t[i] == '-') : (i += 1) dashes += 1;
    if (dashes < 3) return false;
    if (i < t.len and t[i] == ':') i += 1;
    return i == t.len;
}

/// Classify a separator cell that already passes `isSepCell` into Align.
/// Leading+trailing `:` → center; leading only → left; trailing only → right; none → default.
pub fn sepCellAlign(cell: []const u8) Align {
    const t = trimWs(cell);
    if (t.len == 0) return .default;
    var i: usize = 0;
    const lead = t[i] == ':';
    if (lead) i += 1;
    var dashes: usize = 0;
    while (i < t.len and t[i] == '-') : (i += 1) dashes += 1;
    if (dashes < 3) return .default;
    const trail = i < t.len and t[i] == ':';
    if (lead and trail) return .center;
    if (lead) return .left;
    if (trail) return .right;
    return .default;
}

pub fn isSeparatorRow(line: []const u8) bool {
    if (!isPipeRow(line)) return false;
    var cells: [MAX_COLS + 4][]const u8 = undefined;
    const n = splitCells(line, cells[0..]);
    if (n == 0) return false;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (!isSepCell(cells[i])) return false;
    }
    return true;
}

/// Build owned TableData from header + body row slices (cell content points into src OK; we dupe).
/// `col_aligns` is pad/truncated to `cols` (missing → default); never panics on length mismatch.
pub fn buildTable(
    allocator: Allocator,
    header: []const []const u8,
    body: []const []const []const u8,
    col_aligns: []const Align,
) !TableData {
    const cols_raw = header.len;
    if (cols_raw == 0) return error.EmptyTable;
    const cols = @min(cols_raw, MAX_COLS);

    const max_body = if (MAX_ROWS > 1) MAX_ROWS - 1 else 0;
    const body_n = @min(body.len, max_body);
    const overflow = if (body.len > body_n) body.len - body_n else 0;

    const total_rows = 1 + body_n; // header + body
    const total_cells = total_rows * cols;
    var cells = try allocator.alloc([]const u8, total_cells);
    errdefer allocator.free(cells);

    var written: usize = 0;
    errdefer {
        var i: usize = 0;
        while (i < written) : (i += 1) allocator.free(cells[i]);
    }

    // header
    var c: usize = 0;
    while (c < cols) : (c += 1) {
        cells[written] = try allocator.dupe(u8, if (c < header.len) header[c] else "");
        written += 1;
    }

    // body
    var r: usize = 0;
    while (r < body_n) : (r += 1) {
        c = 0;
        while (c < cols) : (c += 1) {
            const cell = if (c < body[r].len) body[r][c] else "";
            cells[written] = try allocator.dupe(u8, cell);
            written += 1;
        }
    }

    var aligns = try allocator.alloc(Align, cols);
    errdefer allocator.free(aligns);
    var ai: usize = 0;
    while (ai < cols) : (ai += 1) {
        aligns[ai] = if (ai < col_aligns.len) col_aligns[ai] else .default;
    }

    return .{
        .cols = cols,
        .cells = cells,
        .has_header = true,
        .overflow_rows = overflow,
        .aligns = aligns,
    };
}

const CellRow = struct {
    cells: [][]const u8,
};

fn freeSegment(a: Allocator, s: Segment) void {
    if (s.is_table) {
        if (s.table) |t| t.deinit(a);
    } else if (s.text.len > 0) {
        a.free(s.text);
    }
}

/// Partition `src` into prose and table segments (fence-aware).
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer {
        for (out.items) |s| freeSegment(allocator, s);
        out.deinit(allocator);
    }

    var lines: std.ArrayList([]const u8) = .empty;
    defer lines.deinit(allocator);
    var i: usize = 0;
    while (i < src.len) {
        const line_start = i;
        while (i < src.len and src[i] != '\n') : (i += 1) {}
        try lines.append(allocator, src[line_start..i]);
        if (i < src.len and src[i] == '\n') i += 1;
    }

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(allocator);
    var in_fence = false;
    var li: usize = 0;

    const flushProse = struct {
        fn go(a: Allocator, o: *std.ArrayList(Segment), p: *std.ArrayList(u8)) !void {
            if (p.items.len == 0) return;
            if (!hasNonWs(p.items)) {
                p.clearRetainingCapacity();
                return;
            }
            const t = try a.dupe(u8, p.items);
            p.clearRetainingCapacity();
            try o.append(a, .{ .is_table = false, .text = t });
        }
    }.go;

    while (li < lines.items.len) {
        const line = lines.items[li];

        if (preprocess.isFenceLine(line)) {
            in_fence = !in_fence;
            try prose.appendSlice(allocator, line);
            try prose.append(allocator, '\n');
            li += 1;
            continue;
        }
        if (in_fence) {
            try prose.appendSlice(allocator, line);
            try prose.append(allocator, '\n');
            li += 1;
            continue;
        }

        if (isPipeRow(line) and li + 1 < lines.items.len and isSeparatorRow(lines.items[li + 1])) {
            var header_cells_buf: [MAX_COLS + 4][]const u8 = undefined;
            const hn = splitCells(line, header_cells_buf[0..]);
            if (hn == 0) {
                try prose.appendSlice(allocator, line);
                try prose.append(allocator, '\n');
                li += 1;
                continue;
            }
            const hcols = @min(hn, MAX_COLS);
            var header: [MAX_COLS][]const u8 = undefined;
            var hc: usize = 0;
            while (hc < hcols) : (hc += 1) header[hc] = header_cells_buf[hc];

            // Separator-derived column aligns (pad/truncate to header cols).
            var sep_cells_buf: [MAX_COLS + 4][]const u8 = undefined;
            const sn = splitCells(lines.items[li + 1], sep_cells_buf[0..]);
            var col_aligns: [MAX_COLS]Align = undefined;
            var ac: usize = 0;
            while (ac < hcols) : (ac += 1) {
                if (ac < sn and isSepCell(sep_cells_buf[ac])) {
                    col_aligns[ac] = sepCellAlign(sep_cells_buf[ac]);
                } else {
                    col_aligns[ac] = .default;
                }
            }

            var body_rows: std.ArrayList(CellRow) = .empty;
            defer {
                for (body_rows.items) |row| allocator.free(row.cells);
                body_rows.deinit(allocator);
            }

            var bi = li + 2;
            while (bi < lines.items.len) : (bi += 1) {
                const bl = lines.items[bi];
                if (!hasNonWs(bl)) break;
                if (preprocess.isFenceLine(bl)) break;
                if (!isPipeRow(bl)) break;
                if (isSeparatorRow(bl)) break;
                var cbuf: [MAX_COLS + 4][]const u8 = undefined;
                const cn = splitCells(bl, cbuf[0..]);
                const use = @min(cn, MAX_COLS);
                const owned = try allocator.alloc([]const u8, use);
                var ci: usize = 0;
                while (ci < use) : (ci += 1) owned[ci] = cbuf[ci];
                try body_rows.append(allocator, .{ .cells = owned });
            }

            var body_ptrs: std.ArrayList([]const []const u8) = .empty;
            defer body_ptrs.deinit(allocator);
            for (body_rows.items) |row| {
                try body_ptrs.append(allocator, row.cells);
            }

            const td = buildTable(allocator, header[0..hcols], body_ptrs.items, col_aligns[0..hcols]) catch {
                try prose.appendSlice(allocator, line);
                try prose.append(allocator, '\n');
                li += 1;
                continue;
            };

            try flushProse(allocator, &out, &prose);
            try out.append(allocator, .{ .is_table = true, .table = td });
            li = bi;
            continue;
        }

        try prose.appendSlice(allocator, line);
        try prose.append(allocator, '\n');
        li += 1;
    }

    try flushProse(allocator, &out, &prose);
    return try out.toOwnedSlice(allocator);
}

// --- tests ------------------------------------------------------------------

test "isSeparatorRow basic" {
    try std.testing.expect(isSeparatorRow("| --- | --- |"));
    try std.testing.expect(isSeparatorRow("|:---|---:|"));
    try std.testing.expect(!isSeparatorRow("| a | b |"));
}

test "splitCells trims" {
    var cells: [8][]const u8 = undefined;
    const n = splitCells("| A | B |", cells[0..]);
    try std.testing.expectEqual(@as(usize, 2), n);
    try std.testing.expectEqualStrings("A", cells[0]);
    try std.testing.expectEqualStrings("B", cells[1]);
}

test "buildTable structure" {
    const header = [_][]const u8{ "h", "long" };
    const row1 = [_][]const u8{ "a", "b" };
    const body = [_][]const []const u8{row1[0..]};
    const defaults = [_]Align{ .default, .default };
    const td = try buildTable(std.testing.allocator, header[0..], body[0..], defaults[0..]);
    defer td.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), td.cols);
    try std.testing.expectEqual(@as(usize, 2), td.aligns.len);
    try std.testing.expectEqual(Align.default, td.aligns[0]);
    try std.testing.expectEqual(@as(usize, 4), td.cells.len);
    try std.testing.expectEqualStrings("h", td.cells[0]);
    try std.testing.expectEqualStrings("long", td.cells[1]);
    try std.testing.expectEqualStrings("a", td.cells[2]);
    try std.testing.expectEqualStrings("b", td.cells[3]);
    // no box-drawing
    for (td.cells) |c| {
        try std.testing.expect(std.mem.indexOf(u8, c, "│") == null);
    }
}

test "partition 2x3 table" {
    const src =
        \\| Name | Age |
        \\| --- | --- |
        \\| Ada | 36 |
        \\| Bob | 41 |
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| freeSegment(std.testing.allocator, s);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(segs[0].is_table);
    const td = segs[0].table.?;
    try std.testing.expect(td.has_header);
    try std.testing.expectEqual(@as(usize, 2), td.cols);
    try std.testing.expectEqualStrings("Ada", td.cells[2]);
    try std.testing.expectEqualStrings("Bob", td.cells[4]);
}

test "partition missing separator is prose" {
    const src = "| A | B |\n| x | y |\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| freeSegment(std.testing.allocator, s);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(!segs[0].is_table);
}

test "partition skips fence body pipes" {
    const src = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n| H | I |\n| --- | --- |\n| 3 | 4 |\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| freeSegment(std.testing.allocator, s);
        std.testing.allocator.free(segs);
    }
    var saw_table = false;
    var saw_fence_pipes = false;
    for (segs) |s| {
        if (s.is_table) {
            saw_table = true;
            const td = s.table.?;
            try std.testing.expectEqualStrings("3", td.cells[2]);
        } else if (std.mem.indexOf(u8, s.text, "| a |") != null) {
            saw_fence_pipes = true;
        }
    }
    try std.testing.expect(saw_table);
    try std.testing.expect(saw_fence_pipes);
}

test "partition prose then table" {
    const src = "Hello\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBye\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| freeSegment(std.testing.allocator, s);
        std.testing.allocator.free(segs);
    }
    try std.testing.expect(segs.len >= 2);
    try std.testing.expect(!segs[0].is_table);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "Hello") != null);
    var saw_t = false;
    var saw_bye = false;
    for (segs) |s| {
        if (s.is_table) saw_t = true;
        if (!s.is_table and std.mem.indexOf(u8, s.text, "Bye") != null) saw_bye = true;
    }
    try std.testing.expect(saw_t);
    try std.testing.expect(saw_bye);
}

test "sepCellAlign matrix" {
    try std.testing.expectEqual(Align.left, sepCellAlign(":---"));
    try std.testing.expectEqual(Align.left, sepCellAlign(":----"));
    try std.testing.expectEqual(Align.left, sepCellAlign(" :--- "));
    try std.testing.expectEqual(Align.center, sepCellAlign(":---:"));
    try std.testing.expectEqual(Align.center, sepCellAlign(":-----:"));
    try std.testing.expectEqual(Align.right, sepCellAlign("---:"));
    try std.testing.expectEqual(Align.right, sepCellAlign("----:"));
    try std.testing.expectEqual(Align.default, sepCellAlign("---"));
    try std.testing.expectEqual(Align.default, sepCellAlign("-----"));
    // whitespace around dashes/colons (trim outer; inner spaces not GFM)
    try std.testing.expectEqual(Align.center, sepCellAlign("  :---:  "));
}

test "isSepCell rejects short GFM forms" {
    try std.testing.expect(!isSepCell(":-:"));
    try std.testing.expect(!isSepCell(":--"));
    try std.testing.expect(!isSepCell("--:"));
    try std.testing.expect(!isSepCell("=="));
    try std.testing.expect(isSepCell(":---"));
    try std.testing.expect(isSepCell(":---:"));
    try std.testing.expect(isSepCell("---:"));
}

test "partition mixed aligns lcrd" {
    const src =
        \\| Left | Center | Right | Unaligned |
        \\|:-----|:------:|------:|-----------|
        \\| a | b | c | d |
        \\
    ;
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| freeSegment(std.testing.allocator, s);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    const td = segs[0].table.?;
    try std.testing.expectEqual(@as(usize, 4), td.cols);
    try std.testing.expectEqual(Align.left, td.aligns[0]);
    try std.testing.expectEqual(Align.center, td.aligns[1]);
    try std.testing.expectEqual(Align.right, td.aligns[2]);
    try std.testing.expectEqual(Align.default, td.aligns[3]);
    // body text that looks like a sep is plain content
    try std.testing.expectEqualStrings("a", td.cells[4]);
}

test "unpackAligns soft fail" {
    var out: [4]Align = undefined;
    unpackAligns("lc", 4, out[0..]);
    try std.testing.expectEqual(Align.left, out[0]);
    try std.testing.expectEqual(Align.center, out[1]);
    try std.testing.expectEqual(Align.default, out[2]);
    try std.testing.expectEqual(Align.default, out[3]);

    unpackAligns("lcrdx", 3, out[0..3]);
    try std.testing.expectEqual(Align.left, out[0]);
    try std.testing.expectEqual(Align.center, out[1]);
    try std.testing.expectEqual(Align.right, out[2]);

    unpackAligns("l?r", 3, out[0..3]);
    try std.testing.expectEqual(Align.left, out[0]);
    try std.testing.expectEqual(Align.default, out[1]);
    try std.testing.expectEqual(Align.right, out[2]);
}

test "packAligns codes" {
    const als = [_]Align{ .left, .center, .right, .default };
    var buf: [8]u8 = undefined;
    const codes = packAligns(als[0..], buf[0..]);
    try std.testing.expectEqualStrings("lcrd", codes);
}

test "buildTable pad truncate aligns" {
    const header = [_][]const u8{ "a", "b", "c" };
    const row1 = [_][]const u8{ "1", "2", "3" };
    const body = [_][]const []const u8{row1[0..]};
    // short aligns → pad with default
    const short = [_]Align{.right};
    const td = try buildTable(std.testing.allocator, header[0..], body[0..], short[0..]);
    defer td.deinit(std.testing.allocator);
    try std.testing.expectEqual(Align.right, td.aligns[0]);
    try std.testing.expectEqual(Align.default, td.aligns[1]);
    try std.testing.expectEqual(Align.default, td.aligns[2]);

    // long aligns → truncate
    const long = [_]Align{ .left, .center, .right, .left, .center };
    const td2 = try buildTable(std.testing.allocator, header[0..], body[0..], long[0..]);
    defer td2.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 3), td2.aligns.len);
    try std.testing.expectEqual(Align.right, td2.aligns[2]);
}

test "12-col all-right cap" {
    var header: [12][]const u8 = undefined;
    var i: usize = 0;
    while (i < 12) : (i += 1) header[i] = "h";
    var aligns: [12]Align = .{.right} ** 12;
    const td = try buildTable(std.testing.allocator, header[0..], &[_][]const []const u8{}, aligns[0..]);
    defer td.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 12), td.cols);
    try std.testing.expectEqual(Align.right, td.aligns[11]);
}
