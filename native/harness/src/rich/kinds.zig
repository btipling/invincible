//! Message kind gates (mirror bridge.MessageKind without importing bridge).
const std = @import("std");

pub const KIND_USER: u8 = 1;
pub const KIND_ASSISTANT: u8 = 2;
pub const KIND_SYSTEM: u8 = 3;
pub const KIND_ERROR: u8 = 4;
pub const KIND_THINKING: u8 = 5;

/// User, assistant, and thinking monologues get GFM. System tool lines and errors stay plain.
pub fn shouldPaintMarkdown(kind: u8) bool {
    return kind == KIND_USER or kind == KIND_ASSISTANT or kind == KIND_THINKING;
}

test "shouldPaintMarkdown kinds" {
    try std.testing.expect(shouldPaintMarkdown(KIND_USER));
    try std.testing.expect(shouldPaintMarkdown(KIND_ASSISTANT));
    try std.testing.expect(shouldPaintMarkdown(KIND_THINKING));
    try std.testing.expect(!shouldPaintMarkdown(KIND_SYSTEM));
    try std.testing.expect(!shouldPaintMarkdown(KIND_ERROR));
    try std.testing.expect(!shouldPaintMarkdown(0));
}
