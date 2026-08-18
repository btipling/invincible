//! Kind label / color / fill helpers. Pure functions — no frame state, no dvui calls.
const dvui = @import("dvui");
const palette = @import("../palette.zig");

pub fn kindLabel(kind: u8) []const u8 {
    return switch (kind) {
        1 => "you",
        2 => "assistant",
        3 => "system",
        4 => "error",
        5 => "thinking",
        6 => "tools",
        7 => "skill",
        else => "msg",
    };
}

pub fn kindTextColor(kind: u8) dvui.Color {
    return switch (kind) {
        1 => palette.teal_accent,
        2 => palette.warm_accent,
        3 => palette.teal_muted,
        4 => palette.ember_accent,
        // Muted warm — thinking monologue (not EMBER, not pure blue).
        5 => palette.warm_muted,
        else => palette.teal_text,
    };
}

pub fn kindFill(kind: u8) ?dvui.Color {
    return switch (kind) {
        1 => palette.teal_bg,
        2 => palette.teal_surface,
        3 => null,
        4 => palette.ember_surface,
        5 => palette.warm_bg,
        else => null,
    };
}
