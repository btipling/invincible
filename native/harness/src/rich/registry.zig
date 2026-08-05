//! BlockKind → paint dispatch (live parse.zig kinds only).
const std = @import("std");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");
const paint_code = @import("paint_code.zig");

pub fn paintBlock(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
    switch (block.kind) {
        .heading => paint_text.paintHeading(src, block, ctx),
        .paragraph => paint_text.paintParagraph(src, block, ctx),
        .list_item => paint_text.paintListItem(src, block, ctx),
        .code_fence => paint_code.paintCodeFence(src, block, ctx),
        .plain => paint_text.paintPlain(src, block, ctx),
    }
}
