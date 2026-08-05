//! StyleMap for rich transcript paint — palette.zig only (no freehand hex).
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const link_url = @import("link_url.zig");

pub const isSafeLinkUrl = link_url.isSafeLinkUrl;

pub const StyleMap = struct {
    body_text: dvui.Color = palette.teal_text,
    muted_text: dvui.Color = palette.teal_muted,
    strong_text: dvui.Color = palette.teal_text,
    emph_text: dvui.Color = palette.teal_muted,
    code_text: dvui.Color = palette.teal_text,
    code_fill: dvui.Color = palette.teal_surface,
    code_border: dvui.Color = palette.teal_border,
    link_text: dvui.Color = palette.teal_accent,
    heading_text: dvui.Color = palette.teal_text,
    bullet_text: dvui.Color = palette.teal_muted,
    fence_lang_text: dvui.Color = palette.teal_muted,
    /// Unified diff: added lines (`+`). WARM accent — intentional, not error.
    diff_add: dvui.Color = palette.warm_accent,
    /// Unified diff: removed lines (`-`). EMBER text = removed-line semantics only.
    diff_del: dvui.Color = palette.ember_text,
    /// Hunk / file headers (`@`, `---`, `+++`).
    diff_meta: dvui.Color = palette.teal_muted,
};

pub fn defaultStyle() StyleMap {
    return .{};
}
