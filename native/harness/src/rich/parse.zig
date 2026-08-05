//! Markdown parse boundary for the harness (phase 1 — zmd spike).
//!
//! zmd is an HTML-oriented streamer. We run it with a custom Config that emits a
//! compact marker IR, then lower that IR into a walkable `ParsedDoc` for phase 2
//! paint. This module must not import `bridge.zig` or paint HTML into the canvas.
const std = @import("std");
const zmd = @import("zmd");
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
    plain,
};

pub const InlineKind = enum {
    text,
    strong,
    emph,
    code,
    link,
};

pub const Inline = struct {
    kind: InlineKind,
    text: []const u8,
    href: ?[]const u8 = null,
};

pub const Block = struct {
    kind: BlockKind,
    /// Heading level 1–6, or list nesting depth for list_item.
    level: u8 = 0,
    /// Fence language info string (arena-owned).
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

const marker_start: u8 = 0x1e;
const marker_sep: u8 = 0x1f;

/// Parse markdown into a walkable document. Caller owns `ParsedDoc` and must
/// call `deinit`. On success, `blocks` are arena-backed.
pub fn parse(parent_allocator: Allocator, src: []const u8) !ParsedDoc {
    var arena = std.heap.ArenaAllocator.init(parent_allocator);
    errdefer arena.deinit();
    const a = arena.allocator();

    const ir = try zmd.parseAlloc(a, src, markerConfig);
    const blocks = try lowerIr(a, ir);

    return .{
        .arena = arena,
        .blocks = blocks,
    };
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
        if (inl.kind == .strong and std.mem.eql(u8, inl.text, "x")) return true;
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

const Builder = struct {
    a: Allocator,
    blocks: std.ArrayList(Block) = .empty,
    inlines: std.ArrayList(Inline) = .empty,
    /// Stack of open inline kinds; on close we fold collected text into one Inline.
    pending_inline: std.ArrayList(PendingInline) = .empty,
    list_depth: u8 = 0,
    cur_kind: ?BlockKind = null,
    cur_level: u8 = 0,
    cur_meta: ?[]const u8 = null,
    /// Text buffer for the current open inline frame (or block-level text).
    text_buf: std.ArrayList(u8) = .empty,

    const PendingInline = struct {
        kind: InlineKind,
        href: ?[]const u8 = null,
    };

    fn deinitLists(self: *Builder) void {
        self.blocks.deinit(self.a);
        self.inlines.deinit(self.a);
        self.pending_inline.deinit(self.a);
        self.text_buf.deinit(self.a);
    }

    fn flushText(self: *Builder) !void {
        if (self.text_buf.items.len == 0) return;
        const t = try self.a.dupe(u8, self.text_buf.items);
        self.text_buf.clearRetainingCapacity();
        try self.inlines.append(self.a, .{ .kind = .text, .text = t });
    }

    fn appendText(self: *Builder, raw: []const u8) !void {
        const text = try unescapeHtml(self.a, raw);
        if (text.len == 0) return;
        // Skip pure indent noise when not inside a content block/inline.
        if (isSkippableWs(text) and self.cur_kind == null and self.pending_inline.items.len == 0) {
            return;
        }
        try self.text_buf.appendSlice(self.a, text);
    }

    fn openBlock(self: *Builder, kind: BlockKind, level: u8, meta: ?[]const u8) !void {
        try self.closeBlock();
        self.cur_kind = kind;
        self.cur_level = level;
        self.cur_meta = if (meta) |m| try self.a.dupe(u8, m) else null;
    }

    fn closeBlock(self: *Builder) !void {
        try self.flushText();
        // Close any dangling inlines by promoting buffered text.
        while (self.pending_inline.items.len > 0) {
            try self.closeInline();
        }
        const kind = self.cur_kind orelse {
            if (self.inlines.items.len == 0) return;
            // Orphan inlines → plain block.
            const owned = try self.inlines.toOwnedSlice(self.a);
            self.inlines = .empty;
            try self.blocks.append(self.a, .{
                .kind = .plain,
                .inlines = owned,
            });
            return;
        };
        const owned = try self.inlines.toOwnedSlice(self.a);
        self.inlines = .empty;
        try self.blocks.append(self.a, .{
            .kind = kind,
            .level = self.cur_level,
            .meta = self.cur_meta,
            .inlines = owned,
        });
        self.cur_kind = null;
        self.cur_level = 0;
        self.cur_meta = null;
    }

    fn openInline(self: *Builder, kind: InlineKind, href: ?[]const u8) !void {
        try self.flushText();
        try self.pending_inline.append(self.a, .{
            .kind = kind,
            .href = if (href) |h| try self.a.dupe(u8, h) else null,
        });
    }

    fn closeInline(self: *Builder) !void {
        const frame = self.pending_inline.pop() orelse return;
        // Text collected while this frame was top-of-stack lives in text_buf.
        const t = try self.a.dupe(u8, self.text_buf.items);
        self.text_buf.clearRetainingCapacity();
        try self.inlines.append(self.a, .{
            .kind = frame.kind,
            .text = t,
            .href = frame.href,
        });
    }

    fn openMarker(self: *Builder, tag: []const u8, meta: []const u8) !void {
        if (std.mem.eql(u8, tag, "ul") or std.mem.eql(u8, tag, "ol")) {
            self.list_depth +|= 1;
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
            try self.openInline(.link, meta);
            return;
        }
        if (std.mem.eql(u8, tag, "img") or std.mem.eql(u8, tag, "ref")) {
            // Spike: fold image/ref content as plain text inline.
            try self.openInline(.text, null);
            return;
        }
        if (std.mem.eql(u8, tag, "p")) {
            try self.openBlock(.paragraph, 0, null);
            return;
        }
        if (std.mem.eql(u8, tag, "li")) {
            try self.openBlock(.list_item, self.list_depth, null);
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

    fn closeMarker(self: *Builder, tag: []const u8) !void {
        if (std.mem.eql(u8, tag, "ul") or std.mem.eql(u8, tag, "ol")) {
            if (self.list_depth > 0) self.list_depth -= 1;
            return;
        }
        if (std.mem.eql(u8, tag, "b") or std.mem.eql(u8, tag, "i") or
            std.mem.eql(u8, tag, "code") or std.mem.eql(u8, tag, "link") or
            std.mem.eql(u8, tag, "img") or std.mem.eql(u8, tag, "ref"))
        {
            try self.closeInline();
            return;
        }
        // Block closes
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
                if (inl.kind == .strong) saw_strong = true;
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
