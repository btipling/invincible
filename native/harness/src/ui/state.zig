//! Shared mutable frame state — single owner for scroll / maps / chip / hug / prompt.
//! All file-level vars that were in ui.zig move here. This module imports NO other
//! ui/* paint file (no cycles). Cleared/reset helpers live here so onInit + frame()
//! hydrate/clear call them from a single owner.
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("../bridge.zig");
const metrics = @import("metrics.zig");
const thinking_collapse = @import("../thinking_collapse.zig");

pub var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

/// First frame after init: focus the composer once.
pub var want_composer_focus: bool = true;
/// Shown line count last frame (messages + optional busy row).
pub var last_shown_count: usize = 0;
/// Ring message count last frame (for clear / hydrate / user-send detection).
pub var last_msg_count: usize = 0;
/// Virtual content scrollMax from last frame — stream growth detection (#251).
pub var last_scroll_max_y: f32 = 0;
/// Persistent across frames — frame-local ScrollInfo zeros viewport every paint.
pub var transcript_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

/// Two-level expand state for tool-run rows (#325 / plan #345), keyed by
/// per-message and per-item ids. Keeps open groups across repaints/frames the
/// way `reorder_tree.zig` keeps its open branches; cleared on reload/clear/
/// truncate so a fresh surface starts collapsed.
pub var toolrun_open_buf: [16384]u8 = undefined;
pub var toolrun_open_fba = std.heap.FixedBufferAllocator.init(&toolrun_open_buf);
pub var toolrun_open_l1 = std.AutoHashMap(dvui.Id, void).init(toolrun_open_fba.allocator());
pub var toolrun_open_l2 = std.AutoHashMap(dvui.Id, void).init(toolrun_open_fba.allocator());

/// #424 — in-memory operator-open set for committed (collapsed) thinking rows,
/// keyed by per-message thinking id. Mirrors `toolrun_open_l1` so a collapsed
/// thinking row the operator expands stays open across frames until toggled or
/// the transcript is cleared. Thinking is ephemeral (never survives refresh),
/// so no persisted state is needed.
pub var thinking_open_buf: [8192]u8 = undefined;
pub var thinking_open_fba = std.heap.FixedBufferAllocator.init(&thinking_open_buf);
pub var thinking_open_l1 = std.AutoHashMap(dvui.Id, void).init(thinking_open_fba.allocator());

pub fn clearThinkingOpenState() void {
    thinking_open_l1.clearRetainingCapacity();
}

/// #424 — the Wasm collapse-policy state: tracks the active Busy turn start so
/// the policy knows which thinking rows are "current turn" (full) vs committed
/// (collapsed).
pub var thinking_collapse_state: thinking_collapse.State = .{};
/// Previous lifecycle seen by `frame()` — for busy->ready/err edge detection.
pub var prev_lifecycle: thinking_collapse.Lifecycle = .boot;

pub fn clearToolRunOpenState() void {
    toolrun_open_l1.clearRetainingCapacity();
    toolrun_open_l2.clearRetainingCapacity();
}

/// Previous-frame measured composer-chrome outer height (px). Initialized to
/// idle so the first frame shows a compact composer. Updated after each frame
/// from the textEntry's natural wrapped height (sampled via dvui.minSizeGet
/// after te.deinit — NOT te.data().min_size which is the options seed); clamped
/// to [IDLE, MAX] so the band never collapses and never exceeds the multi-line
/// cap. The transcript rect is computed from this value, so both bands shift in
/// tandem (one-frame settle lag, no visual jump — adversarial review #584
/// Round 2 Major L1 and Round 3 Major L1+L9).
pub var composer_last_h: f32 = metrics.COMPOSER_IDLE_CHROME_H;

/// Per-slot content-local y-offset in scroll content space. Indexed by physical
/// ring slot (0..RING_CAP). Pre-allocated 2048 × 4 = 8 KiB — zero frame-path alloc.
/// Populated during the message paint loop; cleared on reset/clear.
pub var msg_content_y: [2048]f32 = [_]f32{0} ** 2048;
/// Physical ring slot of the most recent user message, or null when no user
/// messages exist in the current ring window.
pub var last_user_slot: ?usize = null;
/// Chip visibility from the PREVIOUS frame — drives scroll-area rect adjustment
/// and chip paint this frame. One-frame settle (same pattern as composer_last_h).
pub var prev_chip_visible: bool = false;

/// Queue-row being edited, or null. Held promote while non-null.
pub var queue_editing_index: ?usize = null;
/// One-frame settle for the queue band height (same pattern as chip / composer).
pub var prev_queue_band_h: f32 = 0;
/// Set when an edit is saved or cancelled — Trigger B for `tryPromoteQueued`.
pub var queue_closed_edit: bool = false;
/// Scratch buffer for the in-band queue-row editor.
pub var queue_edit_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;
/// dvui widget id of the active queue-row textEntry (set during paintRow
/// while editing; cleared on close). Used for blur-save detection — if the
/// textEntry loses focus while queue_editing_index is set, we save-and-close.
pub var queue_edit_textentry_id: ?dvui.Id = null;
/// Set in beginEdit; cleared after the first focusWidget call in paintRow.
/// Bridges the gap between beginEdit (sets editing_index) and the frame the
/// textEntry widget is actually created, so the TE receives focus immediately.
pub var queue_want_editor_focus: bool = false;
/// Set after the queue-row textEntry has been focused at least once.
/// Blur-save only fires when this is true and focus moves away — on the first
/// frame(s) of a new textEntry, `focused == null` is normal and must not close.
pub var queue_edit_seen_focused: bool = false;
pub var queue_list_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

pub fn resetTranscriptScroll() void {
    transcript_scroll = .{
        .vertical = .auto,
        .horizontal = .none,
    };
    last_shown_count = 0;
    last_msg_count = 0;
    last_scroll_max_y = 0;
    clearToolRunOpenState();
    clearThinkingOpenState();
    thinking_collapse_state.reset();
    prev_lifecycle = .boot;
    @memset(&msg_content_y, 0);
    last_user_slot = null;
    prev_chip_visible = false;
    queue_editing_index = null;
    queue_edit_textentry_id = null;
    queue_want_editor_focus = false;
    queue_edit_seen_focused = false;
    prev_queue_band_h = 0;
    queue_closed_edit = false;
    @memset(&queue_edit_buf, 0);
    queue_list_scroll = .{
        .vertical = .auto,
        .horizontal = .none,
    };
}
