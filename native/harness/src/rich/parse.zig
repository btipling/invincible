//! Markdown parse boundary for the harness (phase 1 — zmd spike).
//!
//! zmd is an HTML-oriented streamer. We run it with a custom Config that emits a
//! compact marker IR, then lower that IR into a walkable `ParsedDoc` for phase 2
//! paint. This module must not import `bridge.zig` or paint HTML into the canvas.
const std = @import("std");
const zmd = @import("zmd");
const preprocess = @import("preprocess.zig");
const bq = @import("blockquote.zig");
const table = @import("table.zig");
const thematic = @import("thematic.zig");
const footnote = @import("footnote.zig");
const deflist = @import("deflist.zig");
const link_url = @import("link_url.zig");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;

/// Ship backend for phase 1 (parent #142 / phase #143 lock).
pub const Backend = enum { zmd };
pub const backend: Backend = .zmd;

pub const BlockKind = enum {
    paragraph,
    heading,
    list_item,
    code_fence,
    blockquote,
    table,
    thematic_break,
    footnote_def,
    def_term,
    def_desc,
    plain,
};

/// Primary paint role (exclusive kinds). Strong/emph/strike are `StyleFlags`.
pub const InlineKind = enum {
    text,
    code,
    link,
    image,
    footnote_ref,
};

/// Stackable style bits on a flat run (no nested AST).
pub const StyleFlags = packed struct(u8) {
    strong: bool = false,
    emph: bool = false,
    strike: bool = false,
    _pad: u5 = 0,

    pub fn any(self: StyleFlags) bool {
        return self.strong or self.emph or self.strike;
    }
};

pub const Inline = struct {
    kind: InlineKind,
    text: []const u8,
    href: ?[]const u8 = null,
    flags: StyleFlags = .{},
};

pub const Block = struct {
    kind: BlockKind,
    /// Heading level 1–6, list nesting depth, blockquote depth (1–6), or table header flag (1=has header).
    level: u8 = 0,
    /// 0 = not in quote; 1–6 when list_item (or future) painted under quote chrome.
    quote_depth: u8 = 0,
    /// Extra lead spaces for quote-under-list paint margin (0 default).
    indent_cols: u8 = 0,
    /// GFM task list: null = ordinary list item; false/true = unchecked/checked task.
    checked: ?bool = null,
    /// Fence language / list ordered meta / table "cols,overflow,aligns[,runs]" (arena-owned).
    meta: ?[]const u8 = null,
    inlines: []const Inline = &.{},
};

pub const ParsedDoc = struct {
    arena: std.heap.ArenaAllocator,
    blocks: []const Block,

    pub fn deinit(self: *ParsedDoc) void {
        self.arena.deinit();
        self.* = undefined;
    }
};


/// Result of stripping a leading GFM task-list marker from list item text.
const TaskMarkerStrip = struct {
    checked: bool,
    rest: []const u8,
};

/// Detect GFM task marker at the start of `text`.
/// Accepted: optional single leading space, then `[ ]` / `[x]` / `[X]`, then optional single trailing space.
/// Returns null when not a task marker. ASCII only.
pub fn stripTaskMarker(text: []const u8) ?TaskMarkerStrip {
    var s = text;
    if (s.len > 0 and s[0] == ' ') s = s[1..];
    if (s.len < 3) return null;
    if (s[0] != '[' or s[2] != ']') return null;
    const mid = s[1];
    const checked: bool = switch (mid) {
        ' ' => false,
        'x', 'X' => true,
        else => return null,
    };
    var rest = s[3..];
    if (rest.len > 0 and rest[0] == ' ') rest = rest[1..];
    return .{ .checked = checked, .rest = rest };
}

/// Strip leading task marker from the first non-empty `.text` inline; mutate in place.
/// Returns checked state or null if not a task item. Empty marker-only run is dropped when siblings remain.
fn applyTaskListOnInlines(inlines: *std.ArrayList(Inline)) ?bool {
    var i: usize = 0;
    while (i < inlines.items.len) : (i += 1) {
        const inl = inlines.items[i];
        if (inl.kind != .text) return null;
        if (inl.text.len == 0) continue;
        const stripped = stripTaskMarker(inl.text) orelse return null;
        inlines.items[i].text = stripped.rest;
        if (stripped.rest.len == 0 and inlines.items.len > 1) {
            _ = inlines.orderedRemove(i);
        }
        return stripped.checked;
    }
    return null;
}

const marker_start: u8 = 0x1e;
const marker_sep: u8 = 0x1f;

/// Parse markdown into a walkable document. Caller owns `ParsedDoc` and must
/// call `deinit`. On success, `blocks` are arena-backed.
pub fn parse(parent_allocator: Allocator, src: []const u8) !ParsedDoc {
    var arena = std.heap.ArenaAllocator.init(parent_allocator);
    errdefer arena.deinit();
    const a = arena.allocator();

    // zmd has no table / `>` blockquote / footnotes @ pin — table partition first,
    // then footnote extract+ref rewrite, HR, quotes, sugar+zmd on non-table spans.
    const table_segs = try table.partition(a, src);
    var blocks: std.ArrayList(Block) = .empty;
    var all_defs: std.ArrayList(footnote.Def) = .empty;
    var defs_budget: usize = footnote.MAX_DEFS;

    for (table_segs) |tseg| {
        if (tseg.is_table) {
            const td = tseg.table orelse continue;
            if (td.cols == 0 or td.cells.len == 0) continue;
            // inlines = row-major multi-run cells; meta = "cols,overflow,aligns,runs"
            var inl_list: std.ArrayList(Inline) = .empty;
            var run_counts: std.ArrayList(usize) = .empty;
            for (td.cells) |cell| {
                const cell_inls = try lowerTableCell(a, cell);
                try run_counts.append(a, cell_inls.len);
                try inl_list.appendSlice(a, cell_inls);
            }
            var runs_buf: std.ArrayList(u8) = .empty;
            for (run_counts.items, 0..) |n, i| {
                if (i > 0) try runs_buf.append(a, '.');
                var nbuf: [20]u8 = undefined;
                const ns = try std.fmt.bufPrint(&nbuf, "{d}", .{n});
                try runs_buf.appendSlice(a, ns);
            }
            var abuf: [table.MAX_COLS]u8 = undefined;
            const acodes = table.packAligns(td.aligns, abuf[0..]);
            const meta = try std.fmt.allocPrint(a, "{d},{d},{s},{s}", .{ td.cols, td.overflow_rows, acodes, runs_buf.items });
            try blocks.append(a, .{
                .kind = .table,
                .level = if (td.has_header) 1 else 0,
                .meta = meta,
                .inlines = try inl_list.toOwnedSlice(a),
            });
            continue;
        }
        if (tseg.text.len == 0) continue;
        if (!bq.hasNonWs(tseg.text)) continue;

        // Footnotes before HR/quotes so end-of-message defs are found and refs
        // never hit zmd's `[` link tokenizer.
        const fn_res = try footnote.extractAndRewriteBudget(a, tseg.text, defs_budget, footnote.MAX_REFS);
        if (fn_res.defs.len > 0) {
            try all_defs.appendSlice(a, fn_res.defs);
            defs_budget -= fn_res.defs.len;
        }
        const span_text = fn_res.body;
        if (span_text.len == 0 or !bq.hasNonWs(span_text)) continue;

        // Thematic breaks on non-table spans (fence-aware); then quotes + zmd.
        const hr_segs = try thematic.partition(a, span_text);
        for (hr_segs) |hseg| {
            if (hseg.is_hr) {
                try blocks.append(a, .{
                    .kind = .thematic_break,
                    .level = 0,
                    .meta = null,
                    .inlines = &.{},
                });
                continue;
            }
            if (hseg.text.len == 0) continue;
            if (!bq.hasNonWs(hseg.text)) continue;

            const segments = try bq.partition(a, hseg.text);
            for (segments) |seg| {
                if (seg.text.len == 0) continue;
                if (!bq.hasNonWs(seg.text)) continue;
                if (seg.is_quote) {
                    const pre = try preprocess.preprocessInlineSugar(a, seg.text);
                    const ir = try zmd.parseAlloc(a, pre, markerConfig);
                    const lowered = try lowerIr(a, ir);
                    const depth: u8 = if (seg.depth == 0) 1 else seg.depth;
                    for (lowered) |blk| {
                        if (blk.inlines.len == 0) continue;
                        if (blk.kind == .list_item) {
                            try blocks.append(a, .{
                                .kind = .list_item,
                                .level = blk.level,
                                .quote_depth = depth,
                                .indent_cols = seg.indent_cols,
                                .checked = blk.checked,
                                .meta = blk.meta,
                                .inlines = blk.inlines,
                            });
                        } else {
                            // paragraph/plain/other → blockquote; fence/heading flatten (v1 non-goal chrome).
                            try blocks.append(a, .{
                                .kind = .blockquote,
                                .level = depth,
                                .quote_depth = 0,
                                .indent_cols = seg.indent_cols,
                                .meta = null,
                                .inlines = blk.inlines,
                            });
                        }
                    }
                } else {
                    // Definition lists on non-quote prose (fence-aware local partition).
                    const dl_segs = try deflist.partition(a, seg.text);
                    for (dl_segs) |dseg| {
                        if (dseg.is_deflist) {
                            const term_inl = try lowerInlineOnly(a, dseg.term);
                            if (term_inl.len > 0 or dseg.term.len > 0) {
                                const inl = if (term_inl.len > 0) term_inl else try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, dseg.term) }});
                                try blocks.append(a, .{
                                    .kind = .def_term,
                                    .level = 0,
                                    .meta = null,
                                    .inlines = inl,
                                });
                            }
                            for (dseg.descs) |body| {
                                const desc_inl = try lowerInlineOnly(a, body);
                                const inl = if (desc_inl.len > 0) desc_inl else try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, body) }});
                                try blocks.append(a, .{
                                    .kind = .def_desc,
                                    .level = 0,
                                    .meta = null,
                                    .inlines = inl,
                                });
                            }
                        } else {
                            if (dseg.text.len == 0 or !bq.hasNonWs(dseg.text)) continue;
                            const pre = try preprocess.preprocessInlineSugar(a, dseg.text);
                            const ir = try zmd.parseAlloc(a, pre, markerConfig);
                            const lowered = try lowerIr(a, ir);
                            try blocks.appendSlice(a, lowered);
                        }
                    }
                }
            }
        }
    }

    // Footnote definitions as a single end section (source order).
    for (all_defs.items) |d| {
        const inl = try lowerInlineOnly(a, d.body);
        try blocks.append(a, .{
            .kind = .footnote_def,
            .level = 0,
            .meta = try a.dupe(u8, d.label),
            .inlines = inl,
        });
    }

    return .{
        .arena = arena,
        .blocks = try blocks.toOwnedSlice(a),
    };
}

/// Inline-only lower: sugar + zmd paragraph (no nested blocks).
/// Shared by deflist / footnote bodies and GFM table cells.
fn lowerInlineOnly(a: Allocator, body: []const u8) ![]const Inline {
    if (body.len == 0) return &.{};
    // Synthetic single paragraph so bold/code/link still lower.
    const wrapped = try std.fmt.allocPrint(a, "{s}\n", .{body});
    const pre = try preprocess.preprocessInlineSugar(a, wrapped);
    const ir = try zmd.parseAlloc(a, pre, markerConfig);
    const lowered = try lowerIr(a, ir);
    if (lowered.len == 0) {
        return try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, body) }});
    }
    // Prefer first paragraph-like block with inlines.
    for (lowered) |blk| {
        if (blk.inlines.len > 0) return blk.inlines;
    }
    return try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, body) }});
}

/// True when cell text may contain MD inline markers (skip zmd when false).
fn cellHasMdMarkers(s: []const u8) bool {
    for (s) |c| {
        switch (c) {
            '*', '_', '`', '~', '[', '!', '\\' => return true,
            else => {},
        }
    }
    return false;
}

/// One table cell → ≥1 inline runs (fast path when no MD markers).
fn lowerTableCell(a: Allocator, cell: []const u8) ![]const Inline {
    if (cell.len == 0) {
        return try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = "" }});
    }
    if (!cellHasMdMarkers(cell)) {
        return try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, cell) }});
    }
    const inls = try lowerInlineOnly(a, cell);
    if (inls.len == 0) {
        return try a.dupe(Inline, &[_]Inline{.{ .kind = .text, .text = try a.dupe(u8, cell) }});
    }
    return inls;
}

/// Fixed-buffer smoke used from harness init so the parser is not tree-shaken
/// out of freestanding Wasm (phase 1 size budget truth).
var smoke_buf: [16 * 1024]u8 = undefined;

pub fn smokeOnce() bool {
    var fba = std.heap.FixedBufferAllocator.init(&smoke_buf);
    var doc = parse(fba.allocator(), "# Hello **x**") catch return false;
    defer doc.deinit();
    return smokeDocOk(&doc);
}

fn smokeDocOk(doc: *const ParsedDoc) bool {
    if (doc.blocks.len == 0) return false;
    const b0 = doc.blocks[0];
    if (b0.kind != .heading or b0.level != 1) return false;
    for (b0.inlines) |inl| {
        if (inl.flags.strong and std.mem.eql(u8, inl.text, "x")) return true;
    }
    return false;
}

// --- marker Config (zmd formatters) -----------------------------------------

fn openTag(writer: *Writer, comptime tag: []const u8) !void {
    try writer.writeByte(marker_start);
    try writer.writeAll(tag);
    try writer.writeByte(marker_sep);
}

fn closeTag(comptime tag: []const u8) []const u8 {
    return &[_]u8{ marker_start, '/' } ++ tag ++ &[_]u8{marker_sep};
}

fn openTagMeta(writer: *Writer, comptime tag: []const u8, meta: []const u8) !void {
    try writer.writeByte(marker_start);
    try writer.writeAll(tag);
    try writer.writeByte(marker_sep);
    try writer.writeAll(meta);
    try writer.writeByte(marker_sep);
}

const Marker = struct {
    pub fn root(_: *Writer, _: zmd.Node) anyerror![]const u8 {
        return "";
    }
    pub fn text(_: *Writer, _: zmd.Node) anyerror![]const u8 {
        return "";
    }
    pub fn paragraph(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "p");
        return closeTag("p");
    }
    pub fn h1(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h1");
        return closeTag("h1");
    }
    pub fn h2(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h2");
        return closeTag("h2");
    }
    pub fn h3(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h3");
        return closeTag("h3");
    }
    pub fn h4(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h4");
        return closeTag("h4");
    }
    pub fn h5(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h5");
        return closeTag("h5");
    }
    pub fn h6(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "h6");
        return closeTag("h6");
    }
    pub fn bold(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "b");
        return closeTag("b");
    }
    pub fn italic(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "i");
        return closeTag("i");
    }
    pub fn code(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "code");
        return closeTag("code");
    }
    pub fn block(w: *Writer, node: zmd.Node) anyerror![]const u8 {
        try openTagMeta(w, "fence", node.meta orelse "");
        return closeTag("fence");
    }
    pub fn unordered_list(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "ul");
        return closeTag("ul");
    }
    pub fn ordered_list(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "ol");
        return closeTag("ol");
    }
    pub fn list_item(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "li");
        return closeTag("li");
    }
    pub fn link(w: *Writer, node: zmd.Node) anyerror![]const u8 {
        try openTagMeta(w, "link", node.href orelse "");
        return closeTag("link");
    }
    pub fn image(w: *Writer, node: zmd.Node) anyerror![]const u8 {
        try openTagMeta(w, "img", node.href orelse "");
        return closeTag("img");
    }
    pub fn ref(w: *Writer, _: zmd.Node) anyerror![]const u8 {
        try openTag(w, "ref");
        return closeTag("ref");
    }
};

const markerConfig: zmd.Config = .{
    .root = Marker.root,
    .block = Marker.block,
    .link = Marker.link,
    .image = Marker.image,
    .h1 = Marker.h1,
    .h2 = Marker.h2,
    .h3 = Marker.h3,
    .h4 = Marker.h4,
    .h5 = Marker.h5,
    .h6 = Marker.h6,
    .bold = Marker.bold,
    .italic = Marker.italic,
    .unordered_list = Marker.unordered_list,
    .ordered_list = Marker.ordered_list,
    .list_item = Marker.list_item,
    .code = Marker.code,
    .paragraph = Marker.paragraph,
    .text = Marker.text,
    .ref = Marker.ref,
};

// --- IR → ParsedDoc ---------------------------------------------------------

const Role = enum { strong, emph, strike, code, link, image, plain };

const Builder = struct {
    a: Allocator,
    blocks: std.ArrayList(Block) = .empty,
    inlines: std.ArrayList(Inline) = .empty,
    pending: std.ArrayList(Pending) = .empty,
    list_depth: u8 = 0,
    /// Stack of open list containers (ul vs ol + ordered counter). Cap 8.
    list_stack: [8]ListFrame = undefined,
    list_stack_len: u8 = 0,
    cur_kind: ?BlockKind = null,
    cur_level: u8 = 0,
    cur_meta: ?[]const u8 = null,
    text_buf: std.ArrayList(u8) = .empty,
    fn_label_buf: std.ArrayList(u8) = .empty,
    in_fn_ref: bool = false,

    const ListKind = enum { ul, ol };
    const ListFrame = struct {
        kind: ListKind,
        /// Next 1-based index for ordered lists (0 until first li).
        counter: u16 = 0,
    };

    const Pending = struct {
        role: Role,
        href: ?[]const u8 = null,
    };

    fn deinitLists(self: *Builder) void {
        self.blocks.deinit(self.a);
        self.inlines.deinit(self.a);
        self.pending.deinit(self.a);
        self.text_buf.deinit(self.a);
        self.fn_label_buf.deinit(self.a);
    }

    fn stackFlags(self: *const Builder) StyleFlags {
        var f: StyleFlags = .{};
        for (self.pending.items) |p| {
            switch (p.role) {
                .strong => f.strong = true,
                .emph => f.emph = true,
                .strike => f.strike = true,
                else => {},
            }
        }
        return f;
    }

    fn stackKind(self: *const Builder) struct { InlineKind, ?[]const u8 } {
        // Innermost code wins; else image; else link
        var kind: InlineKind = .text;
        var href: ?[]const u8 = null;
        for (self.pending.items) |p| {
            switch (p.role) {
                .code => {
                    kind = .code;
                    href = null;
                },
                .image => {
                    if (kind != .code) {
                        kind = .image;
                        href = p.href;
                    }
                },
                .link => {
                    if (kind != .code and kind != .image) {
                        kind = .link;
                        href = p.href;
                    }
                },
                else => {},
            }
        }
        return .{ kind, href };
    }

    fn flushText(self: *Builder) !void {
        if (self.text_buf.items.len == 0) return;
        const t = try self.a.dupe(u8, self.text_buf.items);
        self.text_buf.clearRetainingCapacity();
        const kh = self.stackKind();
        var kind = kh[0];
        var href = kh[1];
        // Empty href cannot be image/link paint path — demote to text.
        if ((kind == .image or kind == .link) and (href == null or href.?.len == 0)) {
            kind = .text;
            href = null;
        }
        try self.inlines.append(self.a, .{
            .kind = kind,
            .text = t,
            .href = href,
            .flags = self.stackFlags(),
        });
    }

    fn appendText(self: *Builder, raw: []const u8) !void {
        const text = try unescapeHtml(self.a, raw);
        if (text.len == 0) return;
        if (isSkippableWs(text) and self.cur_kind == null and self.pending.items.len == 0) {
            return;
        }
        // Walk UTF-8; handle PUA strike/literals from preprocess.
        var i: usize = 0;
        while (i < text.len) {
            const need = std.unicode.utf8ByteSequenceLength(text[i]) catch {
                try self.text_buf.append(self.a, text[i]);
                i += 1;
                continue;
            };
            if (i + need > text.len) {
                try self.text_buf.appendSlice(self.a, text[i..]);
                break;
            }
            const cp = std.unicode.utf8Decode(text[i .. i + need]) catch {
                try self.text_buf.append(self.a, text[i]);
                i += 1;
                continue;
            };
            i += need;
            switch (cp) {
                preprocess.pua_strike_open => {
                    try self.flushText();
                    try self.pending.append(self.a, .{ .role = .strike });
                },
                preprocess.pua_strike_close => {
                    try self.closeInlineRole(.strike);
                },
                footnote.pua_fn_open => {
                    try self.flushText();
                    self.in_fn_ref = true;
                    self.fn_label_buf.clearRetainingCapacity();
                },
                footnote.pua_fn_close => {
                    if (self.in_fn_ref) {
                        self.in_fn_ref = false;
                        const lab = try self.a.dupe(u8, self.fn_label_buf.items);
                        self.fn_label_buf.clearRetainingCapacity();
                        try self.inlines.append(self.a, .{
                            .kind = .footnote_ref,
                            .text = lab,
                        });
                    }
                },
                preprocess.pua_lit_star => try self.text_buf.append(self.a, '*'),
                preprocess.pua_lit_under => try self.text_buf.append(self.a, '_'),
                preprocess.pua_lit_tick => try self.text_buf.append(self.a, '`'),
                preprocess.pua_lit_backslash => try self.text_buf.append(self.a, '\\'),
                preprocess.pua_lit_tilde => try self.text_buf.append(self.a, '~'),
                else => {
                    var buf: [4]u8 = undefined;
                    const n = std.unicode.utf8Encode(cp, &buf) catch {
                        continue;
                    };
                    if (self.in_fn_ref) {
                        try self.fn_label_buf.appendSlice(self.a, buf[0..n]);
                    } else {
                        try self.text_buf.appendSlice(self.a, buf[0..n]);
                    }
                },
            }
        }
    }

    fn openBlock(self: *Builder, kind: BlockKind, level: u8, meta: ?[]const u8) !void {
        try self.closeBlock();
        self.cur_kind = kind;
        self.cur_level = level;
        self.cur_meta = if (meta) |m| try self.a.dupe(u8, m) else null;
    }

    fn closeBlock(self: *Builder) !void {
        try self.flushText();
        while (self.pending.items.len > 0) {
            try self.closeInline();
        }
        const kind = self.cur_kind orelse {
            if (self.inlines.items.len == 0) return;
            const owned = try self.inlines.toOwnedSlice(self.a);
            self.inlines = .empty;
            try self.blocks.append(self.a, .{
                .kind = .plain,
                .inlines = owned,
            });
            return;
        };
        var checked: ?bool = null;
        if (kind == .list_item) {
            checked = applyTaskListOnInlines(&self.inlines);
        }
        const owned = try self.inlines.toOwnedSlice(self.a);
        self.inlines = .empty;
        try self.blocks.append(self.a, .{
            .kind = kind,
            .level = self.cur_level,
            .checked = checked,
            .meta = self.cur_meta,
            .inlines = owned,
        });
        self.cur_kind = null;
        self.cur_level = 0;
        self.cur_meta = null;
    }

    fn openInline(self: *Builder, role: Role, href: ?[]const u8) !void {
        try self.flushText();
        try self.pending.append(self.a, .{
            .role = role,
            .href = if (href) |h| try self.a.dupe(u8, h) else null,
        });
    }

    fn closeInline(self: *Builder) !void {
        try self.flushText();
        _ = self.pending.pop() orelse return;
    }

    /// Pop a specific role (zmd tag close or PUA strike). Prefer top-of-stack;
    /// otherwise remove the nearest matching frame so overlapping spans do not
    /// steal a different role's close (LIFO-only broke `**~~x** y~~`).
    fn closeInlineRole(self: *Builder, role: Role) !void {
        // Empty-alt images: flushText no-ops on empty text_buf — force IR run.
        if (role == .image and self.text_buf.items.len == 0) {
            var idx: ?usize = null;
            var href: ?[]const u8 = null;
            if (self.pending.items.len > 0 and self.pending.items[self.pending.items.len - 1].role == .image) {
                idx = self.pending.items.len - 1;
                href = self.pending.items[idx.?].href;
            } else {
                var k = self.pending.items.len;
                while (k > 0) {
                    k -= 1;
                    if (self.pending.items[k].role == .image) {
                        idx = k;
                        href = self.pending.items[k].href;
                        break;
                    }
                }
            }
            if (idx) |i| {
                if (href) |h| {
                    if (h.len > 0) {
                        try self.inlines.append(self.a, .{
                            .kind = .image,
                            .text = try self.a.dupe(u8, ""),
                            .href = h,
                            .flags = self.stackFlags(),
                        });
                    }
                }
                _ = self.pending.orderedRemove(i);
            }
            return;
        }
        try self.flushText();
        if (self.pending.items.len == 0) return;
        if (self.pending.items[self.pending.items.len - 1].role == role) {
            _ = self.pending.pop();
            return;
        }
        var k = self.pending.items.len;
        while (k > 0) {
            k -= 1;
            if (self.pending.items[k].role == role) {
                _ = self.pending.orderedRemove(k);
                return;
            }
        }
        // Orphan close: ignore
    }

    fn openMarker(self: *Builder, tag: []const u8, meta: []const u8) !void {
        if (std.mem.eql(u8, tag, "ul") or std.mem.eql(u8, tag, "ol")) {
            self.list_depth +|= 1;
            // Cap frames at list_stack.len; depth still rises for indent paint.
            // closeMarker keeps stack_len <= list_depth so over-cap opens do not
            // permanently desync markers after the deep nest closes.
            if (self.list_stack_len < self.list_stack.len) {
                const kind: ListKind = if (std.mem.eql(u8, tag, "ol")) .ol else .ul;
                self.list_stack[self.list_stack_len] = .{ .kind = kind, .counter = 0 };
                self.list_stack_len += 1;
            }
            return;
        }
        if (std.mem.eql(u8, tag, "b")) {
            try self.openInline(.strong, null);
            return;
        }
        if (std.mem.eql(u8, tag, "i")) {
            try self.openInline(.emph, null);
            return;
        }
        if (std.mem.eql(u8, tag, "code")) {
            try self.openInline(.code, null);
            return;
        }
        if (std.mem.eql(u8, tag, "link")) {
            // zmd href is full paren body (may include title) — bare URL only.
            const dest = link_url.normalizeDestination(meta);
            try self.openInline(.link, if (dest.len > 0) dest else null);
            return;
        }
        if (std.mem.eql(u8, tag, "img")) {
            const dest = link_url.normalizeDestination(meta);
            try self.openInline(.image, if (dest.len > 0) dest else null);
            return;
        }
        if (std.mem.eql(u8, tag, "ref")) {
            try self.openInline(.plain, null);
            return;
        }
        if (std.mem.eql(u8, tag, "p")) {
            try self.openBlock(.paragraph, 0, null);
            return;
        }
        if (std.mem.eql(u8, tag, "li")) {
            const list_meta = try self.listItemMeta();
            try self.openBlock(.list_item, self.list_depth, list_meta);
            return;
        }
        if (std.mem.eql(u8, tag, "fence")) {
            try self.openBlock(.code_fence, 0, if (meta.len > 0) meta else null);
            return;
        }
        if (tag.len == 2 and tag[0] == 'h' and tag[1] >= '1' and tag[1] <= '6') {
            try self.openBlock(.heading, tag[1] - '0', null);
            return;
        }
    }

    fn listItemMeta(self: *Builder) !?[]const u8 {
        if (self.list_stack_len == 0) return null;
        const frame = &self.list_stack[self.list_stack_len - 1];
        switch (frame.kind) {
            .ul => return try self.a.dupe(u8, "u"),
            .ol => {
                if (frame.counter < 65535) frame.counter += 1;
                return try std.fmt.allocPrint(self.a, "o,{d}", .{frame.counter});
            },
        }
    }

    fn closeMarker(self: *Builder, tag: []const u8) !void {
        if (std.mem.eql(u8, tag, "ul") or std.mem.eql(u8, tag, "ol")) {
            // list_depth always tracks nest; list_stack caps at 8 frames.
            // Only pop a frame when stack would exceed post-close depth (avoids
            // sticky desync after open past the cap).
            if (self.list_depth > 0) self.list_depth -= 1;
            if (self.list_stack_len > self.list_depth) {
                self.list_stack_len = self.list_depth;
            }
            return;
        }
        if (std.mem.eql(u8, tag, "b")) {
            try self.closeInlineRole(.strong);
            return;
        }
        if (std.mem.eql(u8, tag, "i")) {
            try self.closeInlineRole(.emph);
            return;
        }
        if (std.mem.eql(u8, tag, "code")) {
            try self.closeInlineRole(.code);
            return;
        }
        if (std.mem.eql(u8, tag, "link")) {
            try self.closeInlineRole(.link);
            return;
        }
        if (std.mem.eql(u8, tag, "img")) {
            try self.closeInlineRole(.image);
            return;
        }
        if (std.mem.eql(u8, tag, "ref")) {
            try self.closeInlineRole(.plain);
            return;
        }
        if (std.mem.eql(u8, tag, "p") or std.mem.eql(u8, tag, "li") or
            std.mem.eql(u8, tag, "fence") or
            (tag.len == 2 and tag[0] == 'h' and tag[1] >= '1' and tag[1] <= '6'))
        {
            try self.closeBlock();
            return;
        }
    }
};

fn lowerIr(a: Allocator, ir: []const u8) ![]const Block {
    var b: Builder = .{ .a = a };
    errdefer b.deinitLists();

    var i: usize = 0;
    while (i < ir.len) {
        if (ir[i] == marker_start) {
            const after = i + 1;
            const sep = std.mem.indexOfScalarPos(u8, ir, after, marker_sep) orelse break;
            const tag = ir[after..sep];
            i = sep + 1;

            if (tag.len > 0 and tag[0] == '/') {
                try b.closeMarker(tag[1..]);
            } else {
                var meta: []const u8 = "";
                if (std.mem.eql(u8, tag, "fence") or std.mem.eql(u8, tag, "link") or std.mem.eql(u8, tag, "img")) {
                    const msep = std.mem.indexOfScalarPos(u8, ir, i, marker_sep) orelse break;
                    meta = ir[i..msep];
                    i = msep + 1;
                }
                try b.openMarker(tag, meta);
            }
            continue;
        }

        const start = i;
        while (i < ir.len and ir[i] != marker_start) : (i += 1) {}
        try b.appendText(ir[start..i]);
    }

    try b.closeBlock();
    return try b.blocks.toOwnedSlice(a);
}

fn isSkippableWs(s: []const u8) bool {
    for (s) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return false;
    }
    return true;
}

/// zmd `writeEscaped` turns `& < >` into entities; reverse for paint text.
fn unescapeHtml(a: Allocator, raw: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    var i: usize = 0;
    while (i < raw.len) {
        if (raw[i] == '&') {
            // Match full HTML entities (zmd writeEscaped output).
            if (std.mem.startsWith(u8, raw[i..], "&amp;")) {
                try out.append(a, '&');
                i += 5;
                continue;
            }
            if (std.mem.startsWith(u8, raw[i..], "&lt;")) {
                try out.append(a, '<');
                i += 4;
                continue;
            }
            if (std.mem.startsWith(u8, raw[i..], "&gt;")) {
                try out.append(a, '>');
                i += 4;
                continue;
            }
        }
        try out.append(a, raw[i]);
        i += 1;
    }
    return try out.toOwnedSlice(a);
}

// --- tests ------------------------------------------------------------------

test "parse heading with strong" {
    var doc = try parse(std.testing.allocator, "# Hello **x**");
    defer doc.deinit();
    try std.testing.expect(smokeDocOk(&doc));
    try std.testing.expectEqual(@as(usize, 1), doc.blocks.len);
    try std.testing.expectEqual(BlockKind.heading, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 1), doc.blocks[0].level);
}

test "parse paragraph and fence" {
    const src =
        \\A **bold** word
        \\
        \\```zig
        \\const x = 1;
        \\```
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 2);
    var saw_para = false;
    var saw_fence = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .paragraph) {
            saw_para = true;
            var saw_strong = false;
            for (blk.inlines) |inl| {
                if (inl.flags.strong) saw_strong = true;
            }
            try std.testing.expect(saw_strong);
        }
        if (blk.kind == .code_fence) {
            saw_fence = true;
            try std.testing.expect(blk.meta != null);
            try std.testing.expectEqualStrings("zig", blk.meta.?);
        }
    }
    try std.testing.expect(saw_para);
    try std.testing.expect(saw_fence);
}

test "backend is zmd" {
    try std.testing.expectEqual(Backend.zmd, backend);
}

test "unescapeHtml entities and bare ampersand" {
    const bare = try unescapeHtml(std.testing.allocator, "a & b");
    defer std.testing.allocator.free(bare);
    try std.testing.expectEqualStrings("a & b", bare);

    const amp_ent = try unescapeHtml(std.testing.allocator, "a " ++ "&" ++ "amp; b");
    defer std.testing.allocator.free(amp_ent);
    try std.testing.expectEqualStrings("a & b", amp_ent);

    const lt = try unescapeHtml(std.testing.allocator, "x " ++ "&" ++ "lt; y");
    defer std.testing.allocator.free(lt);
    try std.testing.expectEqualStrings("x < y", lt);

    const gt = try unescapeHtml(std.testing.allocator, "x " ++ "&" ++ "gt; y");
    defer std.testing.allocator.free(gt);
    try std.testing.expectEqualStrings("x > y", gt);
}

test "parse preserves ampersand in paragraph" {
    var doc = try parse(std.testing.allocator, "Use A & B together");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var joined: std.ArrayList(u8) = .empty;
    defer joined.deinit(std.testing.allocator);
    for (doc.blocks[0].inlines) |inl| {
        try joined.appendSlice(std.testing.allocator, inl.text);
    }
    try std.testing.expect(std.mem.indexOf(u8, joined.items, "A & B") != null);
}

test "smokeOnce" {
    try std.testing.expect(smokeOnce());
}

fn joinBlockText(a: std.mem.Allocator, blk: Block) ![]u8 {
    var joined: std.ArrayList(u8) = .empty;
    errdefer joined.deinit(a);
    for (blk.inlines) |inl| {
        try joined.appendSlice(a, inl.text);
    }
    return try joined.toOwnedSlice(a);
}

fn expectContains(hay: []const u8, needle: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, hay, needle) != null);
}

test "parse preserves unicode paragraph" {
    // café + CJK + emoji — integrity (bytes present), not glyph coverage
    const cafe = "caf\xc3\xa9"; // café
    const cjk = "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e"; // 日本語
    const emoji = "\xf0\x9f\x98\x80"; // 😀
    const src = cafe ++ " " ++ cjk ++ " " ++ emoji;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, cafe);
    try expectContains(joined, cjk);
    try expectContains(joined, emoji);
    try std.testing.expect(std.unicode.utf8ValidateSlice(joined));
}

test "parse heading strong preserves unicode" {
    const cjk = "\xe6\x97\xa5\xe6\x9c\xac"; // 日本
    const src = "# Hello **bold " ++ cjk ++ "** end";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.heading, doc.blocks[0].kind);
    var saw_strong = false;
    var strong_has_cjk = false;
    for (doc.blocks[0].inlines) |inl| {
        if (inl.flags.strong) {
            saw_strong = true;
            if (std.mem.indexOf(u8, inl.text, cjk) != null) strong_has_cjk = true;
            try std.testing.expect(std.unicode.utf8ValidateSlice(inl.text));
        }
        try std.testing.expect(std.unicode.utf8ValidateSlice(inl.text));
    }
    try std.testing.expect(saw_strong);
    try std.testing.expect(strong_has_cjk);
}

test "parse fence preserves unicode comment body" {
    const cjk = "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e";
    // python fence with non-ASCII comment (byte-concat; avoid broken multi-line mix)
    const src = "```python\n# " ++ cjk ++ "\nprint(1)\n```\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_fence = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .code_fence) continue;
        saw_fence = true;
        const joined = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(joined);
        try expectContains(joined, cjk);
        try std.testing.expect(std.unicode.utf8ValidateSlice(joined));
    }
    try std.testing.expect(saw_fence);
}

test "parse invalid utf8 does not panic" {
    // Truncated multi-byte sequence + valid ASCII — must not panic
    const src = "ok \xe6\x97 rest"; // incomplete CJK lead + trailing text
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    // May produce blocks or empty; must not crash. Prefer non-empty or plain fallback path later.
    _ = doc.blocks;
}


test "nested bold italic composes flags" {
    // **a *b* c** → b has strong+emph
    var doc = try parse(std.testing.allocator, "**a *b* c**");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var saw_bi = false;
    var saw_strong_only = false;
    for (doc.blocks[0].inlines) |inl| {
        if (std.mem.eql(u8, inl.text, "b") and inl.flags.strong and inl.flags.emph) saw_bi = true;
        if ((std.mem.indexOf(u8, inl.text, "a") != null or std.mem.indexOf(u8, inl.text, "c") != null) and inl.flags.strong and !inl.flags.emph)
            saw_strong_only = true;
    }
    try std.testing.expect(saw_bi);
    try std.testing.expect(saw_strong_only);
}

test "triple star bold italic" {
    // zmd treats *** as italic-open then **...**; prefer **_bi_** which nests cleanly.
    // Also accept *** if it composes; require at least one of the two forms.
    var ok = false;
    {
        var doc = try parse(std.testing.allocator, "**_bi_**");
        defer doc.deinit();
        for (doc.blocks[0].inlines) |inl| {
            if (std.mem.indexOf(u8, inl.text, "bi") != null and inl.flags.strong and inl.flags.emph) ok = true;
        }
    }
    {
        var doc = try parse(std.testing.allocator, "***bi***");
        defer doc.deinit();
        // At minimum bold or italic on bi — document zmd *** quirk if both not set
        for (doc.blocks[0].inlines) |inl| {
            if (std.mem.indexOf(u8, inl.text, "bi") != null and inl.flags.strong and inl.flags.emph) ok = true;
        }
    }
    try std.testing.expect(ok);
}

test "strikethrough flags" {
    var doc = try parse(std.testing.allocator, "~~strike~~");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var saw = false;
    for (doc.blocks[0].inlines) |inl| {
        if (std.mem.indexOf(u8, inl.text, "strike") != null and inl.flags.strike) saw = true;
    }
    try std.testing.expect(saw);
}

test "strike plus strong" {
    var doc = try parse(std.testing.allocator, "~~**x**~~");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var saw = false;
    for (doc.blocks[0].inlines) |inl| {
        if (std.mem.eql(u8, inl.text, "x") and inl.flags.strike and inl.flags.strong) saw = true;
    }
    try std.testing.expect(saw);
}

test "escape star no emph" {
    var doc = try parse(std.testing.allocator, "\\*not italic\\*");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, "*not italic*");
    for (doc.blocks[0].inlines) |inl| {
        try std.testing.expect(!inl.flags.emph);
    }
}

test "bold wrapping code keeps code kind and strong" {
    var doc = try parse(std.testing.allocator, "**`code`**");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var saw = false;
    for (doc.blocks[0].inlines) |inl| {
        if (inl.kind == .code and inl.flags.strong and std.mem.indexOf(u8, inl.text, "code") != null) saw = true;
    }
    try std.testing.expect(saw);
}

test "fence body not rewritten as strike" {
    const src = "```\n~~keep~~\n```\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .code_fence) continue;
        const joined = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(joined);
        try expectContains(joined, "~~keep~~");
        for (blk.inlines) |inl| {
            try std.testing.expect(!inl.flags.strike);
        }
        saw = true;
    }
    try std.testing.expect(saw);
}


test "escape underscore no emph" {
    var doc = try parse(std.testing.allocator, "\\_not emph\\_");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, "_not emph_");
    for (doc.blocks[0].inlines) |inl| {
        try std.testing.expect(!inl.flags.emph);
    }
}

test "escape backtick does not open code" {
    var doc = try parse(std.testing.allocator, "\\`not code\\`");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, "`not code`");
    for (doc.blocks[0].inlines) |inl| {
        try std.testing.expect(inl.kind != .code);
    }
}

test "escape backslash literal" {
    var doc = try parse(std.testing.allocator, "a\\\\b");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, "a\\b");
}

test "overlapping strike and strong role-matched close" {
    // Crossed markers: strong should not stay open over trailing prose after **.
    var doc = try parse(std.testing.allocator, "**~~x** y~~");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var y_strong = false;
    var x_struck = false;
    for (doc.blocks[0].inlines) |inl| {
        if (std.mem.indexOf(u8, inl.text, "x") != null and inl.flags.strike) x_struck = true;
        if (std.mem.indexOf(u8, inl.text, "y") != null and inl.flags.strong) y_strong = true;
    }
    try std.testing.expect(x_struck);
    try std.testing.expect(!y_strong);
}


test "blockquote single line" {
    var doc = try parse(std.testing.allocator, "> hello");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.blockquote, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 1), doc.blocks[0].level);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    try expectContains(joined, "hello");
    try std.testing.expect(std.mem.indexOf(u8, joined, ">") == null);
}

test "blockquote multi-line same depth" {
    var doc = try parse(std.testing.allocator, "> a\n> b\n");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    var joined_all: std.ArrayList(u8) = .empty;
    defer joined_all.deinit(std.testing.allocator);
    for (doc.blocks) |blk| {
        try std.testing.expectEqual(BlockKind.blockquote, blk.kind);
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try joined_all.appendSlice(std.testing.allocator, j);
    }
    try expectContains(joined_all.items, "a");
    try expectContains(joined_all.items, "b");
}

test "blockquote nested depth" {
    var doc = try parse(std.testing.allocator, ">> nest");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.blockquote, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 2), doc.blocks[0].level);
}

test "blockquote depth change splits levels" {
    var doc = try parse(std.testing.allocator, "> outer\n>> inner\n");
    defer doc.deinit();
    var saw1 = false;
    var saw2 = false;
    for (doc.blocks) |blk| {
        try std.testing.expectEqual(BlockKind.blockquote, blk.kind);
        if (blk.level == 1) saw1 = true;
        if (blk.level == 2) saw2 = true;
    }
    try std.testing.expect(saw1);
    try std.testing.expect(saw2);
}

test "blockquote inline flags" {
    var doc = try parse(std.testing.allocator, "> **bold** *em*");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.blockquote, doc.blocks[0].kind);
    var saw_strong = false;
    var saw_emph = false;
    for (doc.blocks[0].inlines) |inl| {
        if (inl.flags.strong) saw_strong = true;
        if (inl.flags.emph) saw_emph = true;
    }
    try std.testing.expect(saw_strong);
    try std.testing.expect(saw_emph);
}

test "fence body not blockquote" {
    const src = "```\n> keep\n```\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    for (doc.blocks) |blk| {
        try std.testing.expect(blk.kind != .blockquote);
    }
    var saw_fence = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .code_fence) {
            saw_fence = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "> keep");
        }
    }
    try std.testing.expect(saw_fence);
}

test "blockquote empty line continuity" {
    var doc = try parse(std.testing.allocator, "> a\n>\n> b\n");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    for (doc.blocks) |blk| {
        try std.testing.expectEqual(BlockKind.blockquote, blk.kind);
    }
    var joined_all: std.ArrayList(u8) = .empty;
    defer joined_all.deinit(std.testing.allocator);
    for (doc.blocks) |blk| {
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try joined_all.appendSlice(std.testing.allocator, j);
    }
    try expectContains(joined_all.items, "a");
    try expectContains(joined_all.items, "b");
}

test "blockquote depth clamp at 6" {
    var doc = try parse(std.testing.allocator, ">>>>>>> deep");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.blockquote, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 6), doc.blocks[0].level);
}

test "blockquote between prose paragraphs" {
    const src = "before\n\n> quoted\n\nafter\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_quote = false;
    var saw_before = false;
    var saw_after = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .blockquote) {
            saw_quote = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "quoted");
        } else {
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            if (std.mem.indexOf(u8, j, "before") != null) saw_before = true;
            if (std.mem.indexOf(u8, j, "after") != null) saw_after = true;
        }
    }
    try std.testing.expect(saw_quote);
    try std.testing.expect(saw_before);
    try std.testing.expect(saw_after);
}

test "blockquote spaced nest depth" {
    var doc = try parse(std.testing.allocator, "> outer\n> > inner\n");
    defer doc.deinit();
    var saw1 = false;
    var saw2 = false;
    for (doc.blocks) |blk| {
        try std.testing.expectEqual(BlockKind.blockquote, blk.kind);
        if (blk.level == 1) {
            saw1 = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "outer");
            try std.testing.expect(std.mem.indexOf(u8, j, ">") == null);
        }
        if (blk.level == 2) {
            saw2 = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "inner");
            try std.testing.expect(std.mem.indexOf(u8, j, ">") == null);
        }
    }
    try std.testing.expect(saw1);
    try std.testing.expect(saw2);
}


test "table 2x3 parse" {
    const src =
        \\| Name | Age |
        \\| --- | --- |
        \\| Ada | 36 |
        \\| Bob | 41 |
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 1), doc.blocks[0].level);
    const j = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(j);
    try expectContains(j, "Ada");
    try expectContains(j, "Bob");
    try expectContains(j, "Name");
}

test "table missing separator not table" {
    const src = "| A | B |\n| x | y |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    for (doc.blocks) |blk| {
        try std.testing.expect(blk.kind != .table);
    }
}

test "fence body pipes not table" {
    const src = "```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    for (doc.blocks) |blk| {
        try std.testing.expect(blk.kind != .table);
    }
}

test "table header only" {
    const src = "| H1 | H2 |\n| --- | --- |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    const j = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(j);
    try expectContains(j, "H1");
}

test "table meta mixed aligns lcrd" {
    const src =
        \\| Left | Center | Right | Unaligned |
        \\|:-----|:------:|------:|-----------|
        \\| a | b | c | d |
        \\| longer left cell | mid | rightmost | default |
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    try std.testing.expectEqualStrings("4,0,lcrd,1.1.1.1.1.1.1.1.1.1.1.1", doc.blocks[0].meta.?);
    // header + 2 body rows × 4 cols
    try std.testing.expectEqual(@as(usize, 12), doc.blocks[0].inlines.len);
    try std.testing.expectEqualStrings("a", doc.blocks[0].inlines[4].text);
    try std.testing.expectEqualStrings("longer left cell", doc.blocks[0].inlines[8].text);
}

test "table body colon dash is plain text" {
    // Full-row body that is itself a separator ends the table (partition rule).
    // Cell text `:---` is plain when the row is not a separator row.
    const src =
        \\| H | X |
        \\| --- | --- |
        \\| :--- | keep |
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    try std.testing.expectEqualStrings("2,0,dd,1.1.1.1", doc.blocks[0].meta.?);
    try std.testing.expectEqualStrings(":---", doc.blocks[0].inlines[2].text);
    try std.testing.expectEqualStrings("keep", doc.blocks[0].inlines[3].text);
}

test "table header only has aligns" {
    const src =
        \\| L | C | R |
        \\|:---|:---:|---:|
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    try std.testing.expectEqualStrings("3,0,lcr,1.1.1", doc.blocks[0].meta.?);
    try std.testing.expectEqual(@as(usize, 3), doc.blocks[0].inlines.len);
}


test "table between prose" {
    const src = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_t = false;
    var saw_b = false;
    var saw_a = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .table) {
            saw_t = true;
        } else {
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            if (std.mem.indexOf(u8, j, "before") != null) saw_b = true;
            if (std.mem.indexOf(u8, j, "after") != null) saw_a = true;
        }
    }
    try std.testing.expect(saw_t);
    try std.testing.expect(saw_b);
    try std.testing.expect(saw_a);
}



test "table cell strong" {
    const src =
        \\| Feature |
        \\| --- |
        \\| **Bold** term |
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(BlockKind.table, doc.blocks[0].kind);
    const blk = doc.blocks[0];
    try std.testing.expectEqual(@as(u8, 1), blk.level);
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.flags.strong and std.mem.indexOf(u8, inl.text, "Bold") != null) saw = true;
    }
    try std.testing.expect(saw);
    try std.testing.expect(std.mem.startsWith(u8, blk.meta.?, "1,0,d,"));
}

test "table cell emph" {
    const src = "| S |\n| --- |\n| *wip* |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.flags.emph and std.mem.indexOf(u8, inl.text, "wip") != null) saw = true;
    }
    try std.testing.expect(saw);
}

test "table cell strike" {
    const src = "| S |\n| --- |\n| ~~old~~ |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.flags.strike and std.mem.indexOf(u8, inl.text, "old") != null) saw = true;
    }
    try std.testing.expect(saw);
}

test "table cell code" {
    const src = "| S |\n| --- |\n| `code` |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.kind == .code and std.mem.indexOf(u8, inl.text, "code") != null) saw = true;
    }
    try std.testing.expect(saw);
}

test "table cell link query frag" {
    const src = "| L |\n| --- |\n| [docs](https://example.com/path?q=1#frag) |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.kind == .link) {
            if (inl.href) |h| {
                if (std.mem.eql(u8, h, "https://example.com/path?q=1#frag")) saw = true;
            }
        }
    }
    try std.testing.expect(saw);
}

test "table cell mixed strong and code" {
    const src = "| M |\n| --- |\n| Mix **a** and `b` |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    try std.testing.expect(std.mem.startsWith(u8, blk.meta.?, "1,0,d,"));
    var saw_strong = false;
    var saw_code = false;
    for (blk.inlines) |inl| {
        if (inl.flags.strong and std.mem.indexOf(u8, inl.text, "a") != null) saw_strong = true;
        if (inl.kind == .code and std.mem.indexOf(u8, inl.text, "b") != null) saw_code = true;
    }
    try std.testing.expect(saw_strong);
    try std.testing.expect(saw_code);
    try std.testing.expect(blk.inlines.len >= 3);
}

test "table header cell strong" {
    const src = "| **x** |\n| --- |\n| plain |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    try std.testing.expectEqual(@as(u8, 1), blk.level);
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.flags.strong and std.mem.indexOf(u8, inl.text, "x") != null) saw = true;
    }
    try std.testing.expect(saw);
}

test "table cell image" {
    const src = "| I |\n| --- |\n| ![icon](https://example.com/i.png) |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var saw = false;
    for (blk.inlines) |inl| {
        if (inl.kind == .image) {
            if (inl.href) |h| {
                if (std.mem.eql(u8, h, "https://example.com/i.png")) saw = true;
            }
        }
    }
    try std.testing.expect(saw);
}

test "table cell plain fast path" {
    const src = "| H |\n| --- |\n| plain ok |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    try std.testing.expectEqualStrings("1,0,d,1.1", blk.meta.?);
    try std.testing.expectEqual(@as(usize, 2), blk.inlines.len);
    try std.testing.expectEqual(InlineKind.text, blk.inlines[1].kind);
    try std.testing.expectEqualStrings("plain ok", blk.inlines[1].text);
}

test "table empty cell one run" {
    const src = "| A | B |\n| --- | --- |\n|  | x |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    try std.testing.expectEqualStrings("2,0,dd,1.1.1.1", blk.meta.?);
    try std.testing.expectEqual(@as(usize, 4), blk.inlines.len);
    try std.testing.expectEqualStrings("", blk.inlines[2].text);
}

test "table meta runs sum matches inlines" {
    const src =
        \\| Feature | Status |
        \\| --- | --- |
        \\| **Bold** | *wip* |
        \\| Mix **a** and `b` | plain |
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    const meta = blk.meta.?;
    var it = std.mem.splitScalar(u8, meta, ',');
    _ = it.next();
    _ = it.next();
    _ = it.next();
    const runs_s = it.next() orelse "";
    var sum: usize = 0;
    var n_cells: usize = 0;
    var rit = std.mem.splitScalar(u8, runs_s, '.');
    while (rit.next()) |tok| {
        const n = try std.fmt.parseInt(usize, tok, 10);
        try std.testing.expect(n >= 1);
        sum += n;
        n_cells += 1;
    }
    try std.testing.expectEqual(blk.inlines.len, sum);
    try std.testing.expectEqual(@as(usize, 6), n_cells);
}

test "table cell javascript link label preserved" {
    const src = "| L |\n| --- |\n| [x](javascript:alert(1)) |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    const blk = doc.blocks[0];
    var has_x = false;
    for (blk.inlines) |inl| {
        if (std.mem.indexOf(u8, inl.text, "x") != null) has_x = true;
        // IR may still carry href (same as body); paint allowlist must refuse navigation.
        if (inl.href) |h| {
            try std.testing.expect(!link_url.isSafeLinkUrl(h));
        }
    }
    try std.testing.expect(has_x);
}

test "thematic break ---" {
    const src = "before\n\n---\n\nafter\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_hr = false;
    var saw_b = false;
    var saw_a = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .thematic_break) saw_hr = true;
        if (blk.kind != .thematic_break) {
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            if (std.mem.indexOf(u8, j, "before") != null) saw_b = true;
            if (std.mem.indexOf(u8, j, "after") != null) saw_a = true;
        }
    }
    try std.testing.expect(saw_hr);
    try std.testing.expect(saw_b);
    try std.testing.expect(saw_a);
}

test "thematic break forms and fence safe" {
    for ([_][]const u8{ "***", "___", "- - -" }) |hr| {
        var doc = try parse(std.testing.allocator, hr);
        defer doc.deinit();
        try std.testing.expect(doc.blocks.len >= 1);
        try std.testing.expectEqual(BlockKind.thematic_break, doc.blocks[0].kind);
    }
    var fenced = try parse(std.testing.allocator, "```\n---\n```\n");
    defer fenced.deinit();
    for (fenced.blocks) |blk| {
        try std.testing.expect(blk.kind != .thematic_break);
    }
}

test "table separator not thematic break" {
    const src = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_table = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .table) saw_table = true;
        try std.testing.expect(blk.kind != .thematic_break);
    }
    try std.testing.expect(saw_table);
}

test "footnote ref and def parse" {
    const src =
        \\See note[^1] please.
        \\
        \\[^1]: Hello **world**.
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_ref = false;
    var saw_def = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .footnote_ref) {
                saw_ref = true;
                try std.testing.expectEqualStrings("1", inl.text);
            }
        }
        if (blk.kind == .footnote_def) {
            saw_def = true;
            try std.testing.expectEqualStrings("1", blk.meta.?);
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try std.testing.expect(std.mem.indexOf(u8, j, "Hello") != null);
        }
    }
    try std.testing.expect(saw_ref);
    try std.testing.expect(saw_def);
}

test "footnote def without ref still present" {
    const src =
        \\Intro.
        \\
        \\[^solo]: Only def.
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_def = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .footnote_def) {
            saw_def = true;
            try std.testing.expectEqualStrings("solo", blk.meta.?);
        }
    }
    try std.testing.expect(saw_def);
}

test "footnote does not destroy surrounding paragraph" {
    const src =
        \\Alpha[^x] beta.
        \\
        \\[^x]: note
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_alpha = false;
    var saw_beta = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .footnote_def) continue;
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        if (std.mem.indexOf(u8, j, "Alpha") != null) saw_alpha = true;
        if (std.mem.indexOf(u8, j, "beta") != null) saw_beta = true;
    }
    try std.testing.expect(saw_alpha);
    try std.testing.expect(saw_beta);
}


test "deflist multi-term multi-def parse" {
    const src =
        \\Term one
        \\: First definition
        \\: Second definition for the same term
        \\
        \\Term two
        \\: Definition of term two
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var terms: usize = 0;
    var descs: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind == .def_term) terms += 1;
        if (blk.kind == .def_desc) descs += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), terms);
    try std.testing.expectEqual(@as(usize, 3), descs);
    // Order: term, desc, desc, term, desc
    try std.testing.expectEqual(BlockKind.def_term, doc.blocks[0].kind);
    const j0 = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(j0);
    try expectContains(j0, "Term one");
    try std.testing.expectEqual(BlockKind.def_desc, doc.blocks[1].kind);
    const j1 = try joinBlockText(std.testing.allocator, doc.blocks[1]);
    defer std.testing.allocator.free(j1);
    try expectContains(j1, "First definition");
}

test "deflist inline marks in term and def" {
    const src =
        \\Nested **marks** and `code` in defs
        \\: Should still compose **inlines**
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_term = false;
    var saw_desc = false;
    var term_strong = false;
    var term_code = false;
    var desc_strong = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .def_term) {
            saw_term = true;
            for (blk.inlines) |inl| {
                if (inl.flags.strong and std.mem.eql(u8, inl.text, "marks")) term_strong = true;
                if (inl.kind == .code and std.mem.eql(u8, inl.text, "code")) term_code = true;
            }
        }
        if (blk.kind == .def_desc) {
            saw_desc = true;
            for (blk.inlines) |inl| {
                if (inl.flags.strong and std.mem.eql(u8, inl.text, "inlines")) desc_strong = true;
            }
        }
    }
    try std.testing.expect(saw_term);
    try std.testing.expect(saw_desc);
    try std.testing.expect(term_strong);
    try std.testing.expect(term_code);
    try std.testing.expect(desc_strong);
}

test "deflist fence safe" {
    const src =
        \\```
        \\Term
        \\: not
        \\```
        \\
        \\Outside
        \\: yes
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var terms: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind == .def_term) {
            terms += 1;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "Outside");
        }
    }
    try std.testing.expectEqual(@as(usize, 1), terms);
}

test "deflist orphan colon stays prose" {
    const src = ": orphan only\n\n";
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    for (doc.blocks) |blk| {
        try std.testing.expect(blk.kind != .def_term);
        try std.testing.expect(blk.kind != .def_desc);
    }
}

test "deflist does not steal footnote def" {
    const src =
        \\See note[^1] please.
        \\
        \\[^1]: Hello footnote.
        \\
        \\API key
        \\: Secret used by the gateway
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_fn = false;
    var saw_term = false;
    var saw_desc = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .footnote_def) {
            saw_fn = true;
            try std.testing.expectEqualStrings("1", blk.meta.?);
        }
        if (blk.kind == .def_term) {
            saw_term = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "API key");
        }
        if (blk.kind == .def_desc) {
            saw_desc = true;
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            try expectContains(j, "Secret");
        }
    }
    try std.testing.expect(saw_fn);
    try std.testing.expect(saw_term);
    try std.testing.expect(saw_desc);
}


test "ordered list meta outside quote" {
    var doc = try parse(std.testing.allocator, "1. alpha\n2. beta\n");
    defer doc.deinit();
    var ordered: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        ordered += 1;
        try std.testing.expect(blk.meta != null);
        try std.testing.expect(blk.meta.?[0] == 'o');
        try std.testing.expectEqual(@as(u8, 0), blk.quote_depth);
        if (ordered == 1) try std.testing.expectEqualStrings("o,1", blk.meta.?);
        if (ordered == 2) try std.testing.expectEqualStrings("o,2", blk.meta.?);
    }
    try std.testing.expect(ordered >= 2);
}

test "unordered list meta is u" {
    var doc = try parse(std.testing.allocator, "- one\n- two\n");
    defer doc.deinit();
    var n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        n += 1;
        try std.testing.expectEqualStrings("u", blk.meta.?);
    }
    try std.testing.expect(n >= 2);
}

test "quote under nested list has indent_cols" {
    const src =
        \\- outer
        \\  - nested
        \\    > should be a quote under the nested item
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_list = false;
    var saw_quote = false;
    for (doc.blocks) |blk| {
        if (blk.kind == .list_item) saw_list = true;
        if (blk.kind == .blockquote) {
            saw_quote = true;
            try std.testing.expect(blk.indent_cols >= 4);
            // body should mention quote text
            var joined: std.ArrayList(u8) = .empty;
            defer joined.deinit(std.testing.allocator);
            for (blk.inlines) |inl| try joined.appendSlice(std.testing.allocator, inl.text);
            try std.testing.expect(std.mem.indexOf(u8, joined.items, "should be a quote") != null);
        }
    }
    try std.testing.expect(saw_list);
    try std.testing.expect(saw_quote);
}

test "ordered list inside quote preserves list_item and quote_depth" {
    const src =
        \\> intro
        \\> 1. first
        \\> 2. second
        \\> 3. third
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var saw_intro = false;
    var ordered: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind == .blockquote) {
            var joined: std.ArrayList(u8) = .empty;
            defer joined.deinit(std.testing.allocator);
            for (blk.inlines) |inl| try joined.appendSlice(std.testing.allocator, inl.text);
            if (std.mem.indexOf(u8, joined.items, "intro") != null) saw_intro = true;
        }
        if (blk.kind == .list_item) {
            ordered += 1;
            try std.testing.expect(blk.quote_depth >= 1);
            try std.testing.expect(blk.meta != null);
            try std.testing.expect(blk.meta.?[0] == 'o');
            if (ordered == 1) try std.testing.expectEqualStrings("o,1", blk.meta.?);
            if (ordered == 2) try std.testing.expectEqualStrings("o,2", blk.meta.?);
            if (ordered == 3) try std.testing.expectEqualStrings("o,3", blk.meta.?);
        }
    }
    try std.testing.expect(saw_intro);
    try std.testing.expectEqual(@as(usize, 3), ordered);
}

test "unordered list inside quote" {
    const src =
        \\> - unordered in quote
        \\> - second bullet
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var ul: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        try std.testing.expect(blk.quote_depth >= 1);
        try std.testing.expectEqualStrings("u", blk.meta.?);
        ul += 1;
    }
    try std.testing.expect(ul >= 2);
}

test "mixed lists inside quote with blank sep" {
    // zmd keeps adjacent `-` then `1.` as one ul without a blank line between;
    // blank `>` line lets a new ol open (same as outside quotes).
    const src =
        \\> - unordered in quote
        \\>
        \\> 1. ordered in quote
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var ul: usize = 0;
    var ol: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        try std.testing.expect(blk.quote_depth >= 1);
        if (blk.meta) |m| {
            if (m[0] == 'u') ul += 1;
            if (m[0] == 'o') ol += 1;
        }
    }
    try std.testing.expect(ul >= 1);
    try std.testing.expect(ol >= 1);
}

test "ordered list counter resumes after nested ul" {
    // Outer ol, inner ul under first item, then second outer item should be o,2.
    const src =
        \\1. alpha
        \\   - nested bullet
        \\2. beta
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var ordered: usize = 0;
    var saw_ul = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        if (blk.meta) |m| {
            if (m[0] == 'u') {
                saw_ul = true;
                continue;
            }
            if (m[0] == 'o') {
                ordered += 1;
                if (ordered == 1) try std.testing.expectEqualStrings("o,1", m);
                if (ordered == 2) try std.testing.expectEqualStrings("o,2", m);
            }
        }
    }
    try std.testing.expect(saw_ul);
    try std.testing.expectEqual(@as(usize, 2), ordered);
}

test "plain quote no list non-regression" {
    var doc = try parse(std.testing.allocator, "> only quote\n> second line\n");
    defer doc.deinit();
    try std.testing.expect(doc.blocks.len >= 1);
    for (doc.blocks) |blk| {
        try std.testing.expect(blk.kind == .blockquote);
        try std.testing.expectEqual(@as(u8, 0), blk.quote_depth);
    }
}


test "stripTaskMarker pure helper" {
    const u = stripTaskMarker("[ ] foo").?;
    try std.testing.expect(!u.checked);
    try std.testing.expectEqualStrings("foo", u.rest);

    const c = stripTaskMarker("[x] bar").?;
    try std.testing.expect(c.checked);
    try std.testing.expectEqualStrings("bar", c.rest);

    const C = stripTaskMarker("[X] Baz").?;
    try std.testing.expect(C.checked);
    try std.testing.expectEqualStrings("Baz", C.rest);

    const lead = stripTaskMarker(" [ ] spaced").?;
    try std.testing.expect(!lead.checked);
    try std.testing.expectEqualStrings("spaced", lead.rest);

    const nospace = stripTaskMarker("[x]extra").?;
    try std.testing.expect(nospace.checked);
    try std.testing.expectEqualStrings("extra", nospace.rest);

    try std.testing.expect(stripTaskMarker("[]") == null);
    try std.testing.expect(stripTaskMarker("[y] no") == null);
    try std.testing.expect(stripTaskMarker("not a task") == null);
    try std.testing.expect(stripTaskMarker("foo [ ]") == null);
}

test "task list unchecked strips marker" {
    var doc = try parse(std.testing.allocator, "- [ ] write plan\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        found = true;
        try std.testing.expect(blk.checked != null);
        try std.testing.expect(!blk.checked.?);
        try std.testing.expectEqualStrings("u", blk.meta.?);
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try std.testing.expect(std.mem.indexOf(u8, j, "[ ]") == null);
        try expectContains(j, "write plan");
    }
    try std.testing.expect(found);
}

test "task list checked and X case" {
    var doc = try parse(std.testing.allocator, "- [x] done\n- [X] also\n");
    defer doc.deinit();
    var n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        n += 1;
        try std.testing.expect(blk.checked != null);
        try std.testing.expect(blk.checked.?);
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try std.testing.expect(std.mem.indexOf(u8, j, "[x]") == null);
        try std.testing.expect(std.mem.indexOf(u8, j, "[X]") == null);
    }
    try std.testing.expect(n >= 2);
}

test "ordinary list item not a task" {
    var doc = try parse(std.testing.allocator, "- ordinary\n- also plain\n");
    defer doc.deinit();
    var n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        n += 1;
        try std.testing.expect(blk.checked == null);
        try std.testing.expectEqualStrings("u", blk.meta.?);
    }
    try std.testing.expect(n >= 2);
}

test "ordered task list preserves meta and checked" {
    var doc = try parse(std.testing.allocator, "1. [ ] first\n2. [x] second\n");
    defer doc.deinit();
    var ordered: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        if (blk.meta == null or blk.meta.?[0] != 'o') continue;
        ordered += 1;
        try std.testing.expect(blk.checked != null);
        if (ordered == 1) {
            try std.testing.expectEqualStrings("o,1", blk.meta.?);
            try std.testing.expect(!blk.checked.?);
        }
        if (ordered == 2) {
            try std.testing.expectEqualStrings("o,2", blk.meta.?);
            try std.testing.expect(blk.checked.?);
        }
    }
    try std.testing.expectEqual(@as(usize, 2), ordered);
}

test "nested task under unordered list" {
    const src =
        \\- outer
        \\  - [ ] write plan
        \\  - [x] handoff-ready
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var tasks: usize = 0;
    var outer_plain = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        if (blk.checked == null) {
            const j = try joinBlockText(std.testing.allocator, blk);
            defer std.testing.allocator.free(j);
            if (std.mem.indexOf(u8, j, "outer") != null) outer_plain = true;
            continue;
        }
        tasks += 1;
    }
    try std.testing.expect(outer_plain);
    try std.testing.expect(tasks >= 2);
}

test "mixed task and non-task siblings" {
    const src =
        \\- [x] done
        \\- plain sibling
        \\- [ ] todo
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var task_n: usize = 0;
    var plain_n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        if (blk.checked == null) plain_n += 1 else task_n += 1;
    }
    try std.testing.expect(task_n >= 2);
    try std.testing.expect(plain_n >= 1);
}

test "task list preserves strong and code inlines" {
    var doc = try parse(std.testing.allocator, "- [ ] **bold** and `code`\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        found = true;
        try std.testing.expect(blk.checked != null);
        try std.testing.expect(!blk.checked.?);
        var saw_strong = false;
        var saw_code = false;
        for (blk.inlines) |inl| {
            if (inl.flags.strong) saw_strong = true;
            if (inl.kind == .code) saw_code = true;
            try std.testing.expect(std.mem.indexOf(u8, inl.text, "[ ]") == null);
        }
        try std.testing.expect(saw_strong);
        try std.testing.expect(saw_code);
    }
    try std.testing.expect(found);
}

test "task list inside quote keeps checked and quote_depth" {
    const src =
        \\> - [ ] quoted task
        \\> - [x] quoted done
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        n += 1;
        try std.testing.expect(blk.quote_depth >= 1);
        try std.testing.expect(blk.checked != null);
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try std.testing.expect(std.mem.indexOf(u8, j, "[ ]") == null);
        try std.testing.expect(std.mem.indexOf(u8, j, "[x]") == null);
    }
    try std.testing.expect(n >= 2);
}

test "task list marker alone empty body" {
    var doc = try parse(std.testing.allocator, "- [ ]\n- [x]\n");
    defer doc.deinit();
    var unchecked: usize = 0;
    var checked_n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        const c = blk.checked orelse continue;
        if (c) checked_n += 1 else unchecked += 1;
    }
    try std.testing.expect(unchecked >= 1);
    try std.testing.expect(checked_n >= 1);
}

test "star and plus list markers are tasks" {
    const src =
        \\* [ ] star task
        \\+ [x] plus done
        \\
    ;
    var doc = try parse(std.testing.allocator, src);
    defer doc.deinit();
    var unchecked: usize = 0;
    var checked_n: usize = 0;
    for (doc.blocks) |blk| {
        if (blk.kind != .list_item) continue;
        const c = blk.checked orelse continue;
        const j = try joinBlockText(std.testing.allocator, blk);
        defer std.testing.allocator.free(j);
        try std.testing.expect(std.mem.indexOf(u8, j, "[ ]") == null);
        try std.testing.expect(std.mem.indexOf(u8, j, "[x]") == null);
        if (c) {
            checked_n += 1;
            try expectContains(j, "plus done");
        } else {
            unchecked += 1;
            try expectContains(j, "star task");
        }
    }
    try std.testing.expectEqual(@as(usize, 1), unchecked);
    try std.testing.expectEqual(@as(usize, 1), checked_n);
}


test "image inline https alt and href" {
    var doc = try parse(std.testing.allocator, "![Architecture](https://example.com/arch.png)\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .image) {
                found = true;
                try std.testing.expectEqualStrings("Architecture", inl.text);
                try std.testing.expect(inl.href != null);
                try std.testing.expectEqualStrings("https://example.com/arch.png", inl.href.?);
            }
        }
    }
    try std.testing.expect(found);
}

test "image empty alt still yields image kind" {
    var doc = try parse(std.testing.allocator, "![](https://example.com/x.png)\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .image) {
                found = true;
                try std.testing.expectEqual(@as(usize, 0), inl.text.len);
                try std.testing.expect(inl.href != null);
                try std.testing.expectEqualStrings("https://example.com/x.png", inl.href.?);
            }
        }
    }
    try std.testing.expect(found);
}

test "image unsafe scheme still stored as image kind" {
    // Paint/host refuse fetch; IR may still carry href for alt fallback.
    var doc = try parse(std.testing.allocator, "![x](javascript:alert(1))\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .image) {
                found = true;
                try std.testing.expectEqualStrings("x", inl.text);
                try std.testing.expect(inl.href != null);
            }
        }
    }
    try std.testing.expect(found);
}

test "image mid-paragraph among text" {
    var doc = try parse(std.testing.allocator, "see ![icon](https://example.com/i.png) for status\n");
    defer doc.deinit();
    var kinds: [8]InlineKind = undefined;
    var n: usize = 0;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (n < kinds.len) {
                kinds[n] = inl.kind;
                n += 1;
            }
        }
    }
    try std.testing.expect(n >= 2);
    var has_image = false;
    var has_text = false;
    for (kinds[0..n]) |k| {
        if (k == .image) has_image = true;
        if (k == .text) has_text = true;
    }
    try std.testing.expect(has_image);
    try std.testing.expect(has_text);
}


test "image with double-quoted title strips to bare url" {
    var doc = try parse(std.testing.allocator, "![Random test image](https://example.com/a.png \"title\")\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .image) {
                found = true;
                try std.testing.expectEqualStrings("Random test image", inl.text);
                try std.testing.expect(inl.href != null);
                try std.testing.expectEqualStrings("https://example.com/a.png", inl.href.?);
            }
        }
    }
    try std.testing.expect(found);
}

test "image with single-quoted title strips to bare url" {
    var doc = try parse(std.testing.allocator, "![alt](https://example.com/b.png 'cap')\n");
    defer doc.deinit();
    var found = false;
    for (doc.blocks) |blk| {
        for (blk.inlines) |inl| {
            if (inl.kind == .image) {
                found = true;
                try std.testing.expect(inl.href != null);
                try std.testing.expectEqualStrings("https://example.com/b.png", inl.href.?);
            }
        }
    }
    try std.testing.expect(found);
}
