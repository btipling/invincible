//! Composer arrow-key history — navigate prior user messages (plan #667).
//! Pure data module: no dvui, no bridge.zig import. The caller (ui.zig frame)
//! walks `messageAt` into a tiny `KindText` view and drives the step machine.
//!
//! Newest-first: ordinal 0 is the most recent user message in the visible
//! ring window. Re-resolve each step so ordinals stay correct after wrap/shrink.
const std = @import("std");

pub const USER_KIND: u8 = 1; // bridge.MessageKind.user

/// Bytes stored from the newest user row at history-entry. Messages shorter
/// than this are stored in full (exact compare). Longer messages store a
/// prefix; only that truncated case may match a different longer string.
pub const FINGERPRINT_MAX: usize = 64;

pub const KindText = struct {
    kind: u8,
    text: []const u8,
};

/// Count user-message (kind=1) rows in `msgs`.
pub fn userCount(msgs: []const KindText) usize {
    var n: usize = 0;
    for (msgs) |m| {
        if (m.kind == USER_KIND) n += 1;
    }
    return n;
}

/// Newest-first: ordinal 0 is the LAST user message in `msgs` (visible order
/// oldest→newest). Returns null when ordinal is out of range or no user rows.
pub fn userTextAt(msgs: []const KindText, ordinal: usize) ?[]const u8 {
    var idx: usize = msgs.len;
    var found: usize = 0;
    while (idx > 0) {
        idx -= 1;
        const m = &msgs[idx];
        if (m.kind == USER_KIND) {
            if (found == ordinal) return m.text;
            found += 1;
        }
    }
    return null;
}

/// Compare candidate text against a stored fingerprint of the newest user
/// row at history-entry time.
///
/// - fp.len == 0 → false (no fingerprint stored)
/// - fp.len < FINGERPRINT_MAX → exact identity (`eql(fp, candidate)`).
///   `fp="ok"` does **not** match `"okay rewrite the tests"`.
/// - fp.len >= FINGERPRINT_MAX → first-64 compare (truncated store). Two
///   different ≥64 B messages that share those 64 bytes still match — that
///   is the Strategy A residual without a session id.
pub fn fingerprintMatch(fp: []const u8, candidate: []const u8) bool {
    if (fp.len == 0) return false;
    if (fp.len < FINGERPRINT_MAX) return std.mem.eql(u8, fp, candidate);
    if (candidate.len < FINGERPRINT_MAX) return false;
    return std.mem.eql(u8, fp[0..FINGERPRINT_MAX], candidate[0..FINGERPRINT_MAX]);
}

pub const Step = enum { older, newer };

pub const Outcome = enum {
    load, // copy userTextAt into prompt_buf
    restore_draft, // restore saved draft, clear history_index
    noop, // nothing to do
};

pub const StepResult = struct {
    outcome: Outcome,
    index: ?usize, // next history_index (null = not in history)
};

/// Restore a saved draft into a prompt buffer. Always memsets prompt_buf to 0
/// first, then copies up to draft.len bytes (0-length copy is a no-op for empty
/// drafts). Always nul-terminates. Returns the actual bytes copied (≤ prompt.len-1).
/// Caller sets history_index = null and clears history-state fields after calling.
pub fn restoreDraftToPrompt(prompt_buf: []u8, draft: []const u8) usize {
    @memset(prompt_buf, 0);
    if (draft.len == 0) return 0;
    const ncopy = @min(draft.len, prompt_buf.len - 1);
    @memcpy(prompt_buf[0..ncopy], draft[0..ncopy]);
    prompt_buf[ncopy] = 0;
    return ncopy;
}

/// Pure step machine — no side effects (no alloc, no global state).
///
/// - older: null → 0 (enter, if user_n > 0); Some(i) → i+1 (stay at oldest)
/// - newer: null → noop; Some(0) → restore_draft; Some(i) → i-1
/// - saturate: Some(i) with i >= user_n → restore_draft (ring shrink / wrap)
pub fn step(index: ?usize, user_n: usize, dir: Step) StepResult {
    switch (dir) {
        .older => {
            if (index) |i| {
                if (i >= user_n) return .{ .outcome = .restore_draft, .index = null };
                if (user_n == 0) return .{ .outcome = .noop, .index = null };
                const next = i + 1;
                if (next < user_n) return .{ .outcome = .load, .index = next };
                return .{ .outcome = .noop, .index = i }; // at oldest already
            } else {
                if (user_n == 0) return .{ .outcome = .noop, .index = null };
                return .{ .outcome = .load, .index = 0 };
            }
        },
        .newer => {
            if (index) |i| {
                if (i >= user_n) return .{ .outcome = .restore_draft, .index = null };
                if (i == 0) return .{ .outcome = .restore_draft, .index = null };
                // i > 0 → walk forward
                return .{ .outcome = .load, .index = i - 1 };
            } else {
                return .{ .outcome = .noop, .index = null };
            }
        },
    }
}
