//! Message kind gates (mirror bridge.MessageKind without importing bridge).
const std = @import("std");

pub const KIND_USER: u8 = 1;
pub const KIND_ASSISTANT: u8 = 2;
pub const KIND_SYSTEM: u8 = 3;
pub const KIND_ERROR: u8 = 4;
pub const KIND_THINKING: u8 = 5;
/// Protocol v10 — host-aggregated tool-run group (decoded by rich/toolrun.zig).
pub const KIND_TOOL: u8 = 6;
/// Protocol v12 — display-only `Skill attached: <slug>` row (session role
/// `skill_attached`). Kind value 7 is the next free enum after KIND_TOOL; the
/// protocol version is 12 — do not conflate the two.
pub const KIND_SKILL: u8 = 7;

/// User, assistant, and thinking monologues get GFM. System/tool-run lines and
/// errors stay plain (tool-run has its own custom expandable paint in
/// `ui/toolrun.zig`; skill rows have a compact headerless paint in
/// `ui/skill.zig`).
pub fn shouldPaintMarkdown(kind: u8) bool {
    return kind == KIND_USER or kind == KIND_ASSISTANT or kind == KIND_THINKING;
}

test "shouldPaintMarkdown kinds" {
    try std.testing.expect(shouldPaintMarkdown(KIND_USER));
    try std.testing.expect(shouldPaintMarkdown(KIND_ASSISTANT));
    try std.testing.expect(shouldPaintMarkdown(KIND_THINKING));
    try std.testing.expect(!shouldPaintMarkdown(KIND_SYSTEM));
    try std.testing.expect(!shouldPaintMarkdown(KIND_ERROR));
    try std.testing.expect(!shouldPaintMarkdown(KIND_TOOL));
    try std.testing.expect(!shouldPaintMarkdown(KIND_SKILL));
    try std.testing.expect(!shouldPaintMarkdown(0));
}

test "KIND_SKILL is the next enum value after KIND_TOOL (7, never the protocol version 12)" {
    try std.testing.expect(KIND_SKILL == 7);
    try std.testing.expect(KIND_SKILL == KIND_TOOL + 1);
    try std.testing.expect(KIND_SKILL != 12);
}
