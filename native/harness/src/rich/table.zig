//! Fence-aware GFM pipe-table partition (zmd has no table nodes @ pin).
const std = @import("std");
const preprocess = @import("preprocess.zig");
const Allocator = std.mem.Allocator;

pub const MAX_COLS: usize = 12;
pub const MAX_ROWS: usize = 40; // header + body rows after sep consumed
pub const SEP_BETWEEN = " │ ";

pub const Segment = struct {
    is_table: bool,
    /// Non-table: raw source span. Table: pre-padded mono grid (may include footer).
    text: []const u8,
    /// Table only: 1 if header line present in grid.
    has_header: bool = false,
};

fn leadSkip(line: []const u8) usize {
    var i: usize = 0;
    var n: usize = 0;
    while (i < line.len and n < 3 and line[i] == ' ') : (i += 1) n += 1;
    return i;
}

/// True if line looks like a pipe table row (outside fence).
pub fn isPipeRow(line: []const u8) bool {
    const i = leadSkip(line);
    if (i >= line.len) return false;
    // Must contain '|' and not be pure whitespace
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

/// Split a pipe row into trimmed cells (no allocator — writes into out slice capacity).
pub fn splitCells(line: []const u8, out: [][]const u8) usize {
    const start = leadSkip(line);
    var body = line[start..];
    // Trim trailing whitespace
    body = trimWs(body);
    // Drop one leading/trailing pipe if present
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
        i += 1; // skip |
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

pub fn runeLen(s: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const need = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            n += 1;
            i += 1;
            continue;
        };
        if (i + need > s.len) {
            n += 1;
            break;
        }
        n += 1;
        i += need;
    }
    return n;
}

fn padRight(allocator: Allocator, cell: []const u8, width: usize) ![]u8 {
    const w = runeLen(cell);
    const pad = if (width > w) width - w else 0;
    var out = try allocator.alloc(u8, cell.len + pad);
    @memcpy(out[0..cell.len], cell);
    @memset(out[cell.len..], ' ');
    return out;
}

/// Build mono grid from header + body rows (sep already excluded). Caps cols/rows.
pub fn formatGrid(allocator: Allocator, header: []const []const u8, body: []const []const []const u8) !struct { []u8, bool } {
    const cols_raw = header.len;
    if (cols_raw == 0) return error.EmptyTable;
    const cols = @min(cols_raw, MAX_COLS);

    // widths
    var widths: [MAX_COLS]usize = [_]usize{0} ** MAX_COLS;
    var c: usize = 0;
    while (c < cols) : (c += 1) {
        widths[c] = runeLen(header[c]);
    }
    const body_n = @min(body.len, if (MAX_ROWS > 1) MAX_ROWS - 1 else 0);
    var r: usize = 0;
    while (r < body_n) : (r += 1) {
        c = 0;
        while (c < cols) : (c += 1) {
            const cell = if (c < body[r].len) body[r][c] else "";
            widths[c] = @max(widths[c], runeLen(cell));
        }
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    // header
    c = 0;
    while (c < cols) : (c += 1) {
        if (c > 0) try out.appendSlice(allocator, SEP_BETWEEN);
        const padded = try padRight(allocator, header[c], widths[c]);
        defer allocator.free(padded);
        try out.appendSlice(allocator, padded);
    }

    // body
    r = 0;
    while (r < body_n) : (r += 1) {
        try out.append(allocator, '\n');
        c = 0;
        while (c < cols) : (c += 1) {
            if (c > 0) try out.appendSlice(allocator, SEP_BETWEEN);
            const cell = if (c < body[r].len) body[r][c] else "";
            const padded = try padRight(allocator, cell, widths[c]);
            defer allocator.free(padded);
            try out.appendSlice(allocator, padded);
        }
    }

    const overflow_rows = if (body.len > body_n) body.len - body_n else 0;
    if (overflow_rows > 0) {
        try out.append(allocator, '\n');
        var buf: [48]u8 = undefined;
        const msg = try std.fmt.bufPrint(&buf, "… {d} more rows", .{overflow_rows});
        try out.appendSlice(allocator, msg);
    }

    return .{ try out.toOwnedSlice(allocator), true };
}

const CellRow = struct {
    cells: [][]const u8,
};

/// Partition `src` into prose and table segments (fence-aware).
pub fn partition(allocator: Allocator, src: []const u8) ![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    errdefer {
        for (out.items) |s| allocator.free(s.text);
        out.deinit(allocator);
    }

    // Collect lines with offsets
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

        // Try table: pipe row + next separator
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
            // Own header cell strings (point into src — OK while src lives; segment text is owned grid)
            var header: [MAX_COLS][]const u8 = undefined;
            var hc: usize = 0;
            while (hc < hcols) : (hc += 1) header[hc] = header_cells_buf[hc];

            // Collect body rows
            var body_rows: std.ArrayList(CellRow) = .empty;
            defer {
                for (body_rows.items) |row| allocator.free(row.cells);
                body_rows.deinit(allocator);
            }

            var bi = li + 2;
            while (bi < lines.items.len) : (bi += 1) {
                const bl = lines.items[bi];
                if (!hasNonWs(bl)) break; // blank ends
                if (preprocess.isFenceLine(bl)) break;
                if (!isPipeRow(bl)) break;
                if (isSeparatorRow(bl)) break; // don't treat extra sep as body
                var cbuf: [MAX_COLS + 4][]const u8 = undefined;
                const cn = splitCells(bl, cbuf[0..]);
                const use = @min(cn, MAX_COLS);
                const owned = try allocator.alloc([]const u8, use);
                var ci: usize = 0;
                while (ci < use) : (ci += 1) owned[ci] = cbuf[ci];
                try body_rows.append(allocator, .{ .cells = owned });
            }

            // Build body slice of slices
            var body_ptrs: std.ArrayList([]const []const u8) = .empty;
            defer body_ptrs.deinit(allocator);
            for (body_rows.items) |row| {
                try body_ptrs.append(allocator, row.cells);
            }

            const grid_pair = formatGrid(allocator, header[0..hcols], body_ptrs.items) catch {
                // fall through as prose
                try prose.appendSlice(allocator, line);
                try prose.append(allocator, '\n');
                li += 1;
                continue;
            };
            const grid = grid_pair[0];

            try flushProse(allocator, &out, &prose);
            try out.append(allocator, .{ .is_table = true, .text = grid, .has_header = true });
            li = bi;
            continue;
        }

        // Prose line
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

test "formatGrid pads columns" {
    const header = [_][]const u8{ "h", "long" };
    const row1 = [_][]const u8{ "a", "b" };
    const body = [_][]const []const u8{row1[0..]};
    const pair = try formatGrid(std.testing.allocator, header[0..], body[0..]);
    defer std.testing.allocator.free(pair[0]);
    const grid = pair[0];
    // "h   │ long" / "a   │ b   " roughly
    try std.testing.expect(std.mem.indexOf(u8, grid, "h") != null);
    try std.testing.expect(std.mem.indexOf(u8, grid, "long") != null);
    try std.testing.expect(std.mem.indexOf(u8, grid, "a") != null);
    // both rows present
    try std.testing.expect(std.mem.indexOf(u8, grid, "\n") != null);
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
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(segs[0].is_table);
    try std.testing.expect(segs[0].has_header);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "Ada") != null);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "Bob") != null);
    try std.testing.expect(std.mem.indexOf(u8, segs[0].text, "Name") != null);
}

test "partition missing separator is prose" {
    const src = "| A | B |\n| x | y |\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    try std.testing.expectEqual(@as(usize, 1), segs.len);
    try std.testing.expect(!segs[0].is_table);
}

test "partition skips fence body pipes" {
    const src = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n| H | I |\n| --- | --- |\n| 3 | 4 |\n";
    const segs = try partition(std.testing.allocator, src);
    defer {
        for (segs) |s| std.testing.allocator.free(s.text);
        std.testing.allocator.free(segs);
    }
    var saw_table = false;
    var saw_fence_pipes = false;
    for (segs) |s| {
        if (s.is_table) {
            saw_table = true;
            try std.testing.expect(std.mem.indexOf(u8, s.text, "3") != null);
            try std.testing.expect(std.mem.indexOf(u8, s.text, "1") == null);
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
        for (segs) |s| std.testing.allocator.free(s.text);
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

test "runeLen utf8" {
    try std.testing.expectEqual(@as(usize, 4), runeLen("café")); // c a f é
}
