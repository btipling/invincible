//! Prompt submit / clear helpers — the composer widgets themselves stay in frame().
const std = @import("std");
const bridge = @import("../bridge.zig");
const composer_text = @import("../composer_text.zig");
const state = @import("state.zig");
const scroll = @import("scroll.zig");

pub fn clearPrompt() void {
    @memset(&state.prompt_buf, 0);
}

/// Reset history state after the operator submits (or blank-rejects) from
/// history — the next ↑ must re-enter from the newest (plan #667).
pub fn resetHistory() void {
    state.history_index = null;
    state.history_draft_len = 0;
    @memset(&state.history_draft_buf, 0);
    @memset(&state.history_newest_fingerprint, 0);
    state.history_newest_fp_len = 0;
}

pub fn submitText(text: []const u8) void {
    // Normalize CRLF/lone-CR -> LF and clamp to SUBMIT_CAP at a codepoint
    // boundary (composer_text.zig). Blank/whitespace after normalization is
    // rejected, preserving the existing empty-send guard. In-place into
    // prompt_buf is safe: normalized length never exceeds the input consumed.
    const norm = composer_text.normalizeInto(text, state.prompt_buf[0..], bridge.SUBMIT_CAP);
    if (norm.is_blank) {
        clearPrompt();
        resetHistory();
        return;
    }
    bridge.queueSubmitFromUi(norm.text);
    clearPrompt();
    resetHistory();
}

pub fn submitOrEnqueue(text: []const u8) void {
    const norm = composer_text.normalizeInto(text, state.prompt_buf[0..], bridge.SUBMIT_CAP);
    if (norm.is_blank) {
        clearPrompt();
        resetHistory();
        return;
    }
    if (bridge.getLifecycle() == .busy) {
        bridge.enqueueFromUi(norm.text) catch return;
        clearPrompt();
        resetHistory();
        // Transcript layout already ran this frame — follow immediately
        // (same feedback as idle send). Queue-band paint already ran
        // (above the composer), so queue virtual_size is stale; latch a
        // follow for the end of next `queue_band.paint` after the new row
        // is laid out (plan #699 / source #696; n > QUEUE_BAND_MAX_ROWS).
        scroll.scrollToBottom(&state.transcript_scroll);
        state.queue_follow = true;
        return;
    }
    bridge.queueSubmitFromUi(norm.text);
    clearPrompt();
    resetHistory();
}
