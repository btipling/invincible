//! Composer arrow-key history — navigate prior user messages (plan #667).
//! Pure data module: no dvui, no bridge.zig import. The caller (ui.zig frame)
//! walks `messageAt` into a tiny `KindText` view and drives the step machine.
//!
//! Newest-first: ordinal 0 is the most recent user message in the visible
//! ring window. Re-resolve each step so ordinals stay correct after wrap/shrink.

pub const USER_KIND: u8 = 1; // bridge.MessageKind.user

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
