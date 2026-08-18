//! Prompt submit / clear helpers — the composer widgets themselves stay in frame().
const std = @import("std");
const bridge = @import("../bridge.zig");
const composer_text = @import("../composer_text.zig");
const state = @import("state.zig");

pub fn clearPrompt() void {
    @memset(&state.prompt_buf, 0);
}

pub fn submitText(text: []const u8) void {
    // Normalize CRLF/lone-CR -> LF and clamp to SUBMIT_CAP at a codepoint
    // boundary (composer_text.zig). Blank/whitespace after normalization is
    // rejected, preserving the existing empty-send guard. In-place into
    // prompt_buf is safe: normalized length never exceeds the input consumed.
    const norm = composer_text.normalizeInto(text, state.prompt_buf[0..], bridge.SUBMIT_CAP);
    if (norm.is_blank) {
        clearPrompt();
        return;
    }
    bridge.queueSubmitFromUi(norm.text);
    clearPrompt();
}

pub fn submitOrEnqueue(text: []const u8) void {
    const norm = composer_text.normalizeInto(text, state.prompt_buf[0..], bridge.SUBMIT_CAP);
    if (norm.is_blank) {
        clearPrompt();
        return;
    }
    if (bridge.getLifecycle() == .busy) {
        bridge.enqueueFromUi(norm.text) catch return;
        clearPrompt();
        return;
    }
    bridge.queueSubmitFromUi(norm.text);
    clearPrompt();
}
