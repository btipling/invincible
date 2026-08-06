//! BlockKind → paint dispatch (live parse.zig kinds only).
const std = @import("std");
const parse = @import("parse.zig");
const paint_text = @import("paint_text.zig");
const paint_code = @import("paint_code.zig");
const paint_diff = @import("paint_diff.zig");
const paint_table = @import("paint_table.zig");

pub fn paintBlock(src: std.builtin.SourceLocation, block: parse.Block, ctx: *paint_text.PaintCtx) void {
    switch (block.kind) {
        .heading => paint_text.paintHeading(src, block, ctx),
        .paragraph => paint_text.paintParagraph(src, block, ctx),
        .list_item => paint_text.paintListItem(src, block, ctx),
        .blockquote => paint_text.paintBlockquote(src, block, ctx),
        .table => paint_table.paintTable(src, block, ctx),
        .code_fence => {
            if (paint_diff.isDiffLang(block.meta)) {
                paint_diff.paintDiffFence(src, block, ctx);
            } else {
                paint_code.paintCodeFence(src, block, ctx);
            }
        },
        .plain => paint_text.paintPlain(src, block, ctx),
    }
}
