//! Display-only skill-attach row (protocol v12 / kind 7).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const mixed_text = @import("../rich/mixed_text.zig");

/// Paint a display-only skill-attach row (protocol v12 / kind 7). Headerless and
/// compact: a single muted-TEAL line `Skill attached: <slug>`. The text is the
/// host-built NAME line only — a skill body is never shipped to the client or
/// folded into the model prompt, so there is nothing sensitive here. A long/
/// hostile wire line is hard-capped to ~160 bytes at a UTF-8 boundary with `…`.
pub fn paintSkillAttached(
    src: std.builtin.SourceLocation,
    msg_index: usize,
    text: []const u8,
) void {
    var cap_buf: [160]u8 = undefined;
    const shown: []const u8 = blk: {
        if (text.len <= cap_buf.len) break :blk text;
        // Reserve 3 bytes for the UTF-8 ellipsis (U+2026 = \xE2\x80\xA6).
        var n: usize = cap_buf.len - 3;
        // Back off a multibyte char truncated by the byte cap (never mojibake).
        while (n > 0 and (text[n] & 0xC0) == 0x80) n -= 1;
        @memcpy(cap_buf[0..n], text[0..n]);
        @memcpy(cap_buf[n .. n + 3], "…");
        break :blk cap_buf[0 .. n + 3];
    };
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = msg_index *% 1024 + 1,
        .color_text = palette.teal_muted,
        .font = .theme(.body),
    });
    mixed_text.addTextMixed(tl, shown, .theme(.body), .{
        .color_text = palette.teal_muted,
    });
    tl.deinit();
}
