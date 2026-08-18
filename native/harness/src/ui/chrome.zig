//! L0 chrome: shared icon fonts + paintStatusChip + toolRunClipboard.
//! Used by tool-run + thinking Copy + composer icons.
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const metrics = @import("metrics.zig");
const rich_toolrun = @import("../rich/toolrun.zig");

/// L0 chrome mark size — DejaVu symbols at default body size read as dust next to
/// the "N tools called" heading; bump so ✓/✗/… match the count digits.
pub fn chromeMarkFont(base: dvui.Font) dvui.Font {
    return base.withSize(base.size + 5).withLineHeight(1.0);
}

/// L0 count digit size — keep with the mark, slightly larger than default heading.
pub fn chromeCountFont() dvui.Font {
    const h = dvui.Font.theme(.heading);
    return h.withSize(h.size + 2).withLineHeight(1.0);
}

/// Clipboard emoji on the copy control — OpenMoji outlines need ~2× body px.
pub fn chromeCopyFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return palette.fontEmoji()
        .withSize(body.size * 1.9)
        .withLineHeight(1.0);
}

/// Trailing composer icon glyphs (plan #457) — DejaVu Sans Symbols covers both
/// `▶` (launch/send, U+25B6) and `■` (stop, U+25A0); bump size so they read at
/// the fixed TOUCH_H square instead of tofu/dust.
pub fn composerIconFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return palette.fontSymbols()
        .withSize(body.size + 4)
        .withLineHeight(1.0);
}

pub fn paintStatusChip(
    src: std.builtin.SourceLocation,
    box_id: usize,
    glyph_id: usize,
    count_id: usize,
    color: dvui.Color,
    mark: []const u8,
    count: u32,
    mark_font: dvui.Font,
) void {
    var chip = dvui.box(src, .{ .dir = .horizontal }, .{
        .gravity_y = 0.5,
        .id_extra = box_id,
        // No extra pad — chips sit in the trailing chrome row with the copy btn.
        .margin = .{ .x = 0, .y = 0, .w = 2, .h = 0 },
    });
    defer chip.deinit();
    {
        var tl = dvui.textLayout(src, .{}, .{
            .id_extra = glyph_id,
            .color_text = color,
            .font = chromeMarkFont(mark_font),
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 3, .h = 0 },
        });
        tl.addText(mark, .{});
        tl.deinit();
    }
    {
        var tl = dvui.textLayout(src, .{}, .{
            .id_extra = count_id,
            .color_text = color,
            .font = chromeCountFont(),
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 4, .h = 0 },
        });
        tl.format("{d}", .{count}, .{});
        tl.deinit();
    }
}

/// Build a human-readable multi-line summary of a tool-run payload for the Copy
/// button — never the dense `toolrun\t…` wire text. Falls back to the raw body
/// when the payload doesn't decode so we never lose data.
pub fn toolRunClipboard(text: []const u8) []const u8 {
    const alloc = dvui.currentWindow().arena();
    var decoded = rich_toolrun.decode(alloc, text) orelse return text;
    defer decoded.deinit();
    var out = std.ArrayList(u8).empty;
    errdefer out.deinit(alloc);
    var line_buf: [512]u8 = undefined;
    for (decoded.run.items) |it| {
        const g: []const u8 = switch (it.status) {
            .ok => "✓",
            .fail => "✗",
            .running => "…",
        };
        const name = if (it.name.len > 0) it.name else "tool";
        const label = if (it.brief.len > 0) it.brief else name;
        const line = std.fmt.bufPrint(&line_buf, "{s} {s} — {s}\n", .{ g, name, label }) catch continue;
        out.appendSlice(alloc, line) catch break;
    }
    return out.toOwnedSlice(alloc) catch return text;
}
