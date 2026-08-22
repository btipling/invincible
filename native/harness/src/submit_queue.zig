//! Wasm-ephemeral FIFO of operator follow-up prompts (plan #664).
//!
//! Pure, no dvui / Wasm frame / GPA. Host-unit-tested via `test-rich`.
//! Per-item storage is `ITEM_BYTES` == `bridge.SUBMIT_CAP` (duplicated so this
//! module does not import `bridge.zig`, which pulls the web backend).

const std = @import("std");
const composer_text = @import("composer_text.zig");

/// Generous follow-up list. UI shows 3 rows and scrolls the rest.
pub const MAX_ITEMS: usize = 16;

/// Must match `bridge.SUBMIT_CAP`. Not a new cap — same clamp as a live Send.
pub const ITEM_BYTES: usize = 262144;

pub const Slot = struct {
    len: u32 = 0,
    data: [ITEM_BYTES]u8 = undefined,
};

pub const Q = struct {
    slots: [MAX_ITEMS]Slot = [_]Slot{.{}} ** MAX_ITEMS,
    head: usize = 0,
    len: usize = 0,
};

pub fn count(q: *const Q) u32 {
    return @intCast(q.len);
}

pub fn peek(q: *const Q) ?[]const u8 {
    if (q.len == 0) return null;
    const s = &q.slots[q.head];
    return s.data[0..s.len];
}

pub fn item(q: *const Q, i: usize) ?[]const u8 {
    if (i >= q.len) return null;
    const idx = (q.head + i) % MAX_ITEMS;
    const s = &q.slots[idx];
    return s.data[0..s.len];
}

pub fn push(q: *Q, text: []const u8) error{ Blank, Full }!void {
    if (q.len >= MAX_ITEMS) return error.Full;
    const idx = (q.head + q.len) % MAX_ITEMS;
    const s = &q.slots[idx];
    const norm = composer_text.normalizeInto(text, s.data[0..], ITEM_BYTES);
    if (norm.is_blank) return error.Blank;
    s.len = @intCast(norm.text.len);
    q.len += 1;
}

/// Drop the head. Does **not** return a view (that would UAF if the slot is reused).
pub fn pop(q: *Q) void {
    if (q.len == 0) return;
    q.slots[q.head].len = 0;
    q.head = (q.head + 1) % MAX_ITEMS;
    q.len -= 1;
}

/// Insert `text` at the head (index 0), shifting every existing item down one
/// (plan #759 — `Continue the current turn` on give-up with a non-empty queue).
/// Never pops; fails `Full` at `MAX_ITEMS` and `Blank` on a blank/whitespace
/// input. Normalizes via the same `composer_text.normalizeInto` path as `push`,
/// so an index-0 head behaves exactly like a normal enqueued row.
pub fn insertFront(q: *Q, text: []const u8) error{ Blank, Full }!void {
    if (q.len >= MAX_ITEMS) return error.Full;
    // Normalize into a scratch first so a Blank input never mutates the queue.
    var tmp: [ITEM_BYTES]u8 = undefined;
    const norm = composer_text.normalizeInto(text, tmp[0..], ITEM_BYTES);
    if (norm.is_blank) return error.Blank;
    // Shift existing items up one physical slot (tail-1 → tail … head → head+1).
    var j: usize = q.len;
    while (j > 0) : (j -= 1) {
        const dst_i = (q.head + j) % MAX_ITEMS;
        const src_i = (q.head + j - 1) % MAX_ITEMS;
        copySlot(&q.slots[dst_i], &q.slots[src_i]);
    }
    const head = &q.slots[q.head];
    @memcpy(head.data[0..norm.text.len], norm.text);
    head.len = @intCast(norm.text.len);
    q.len += 1;
}

fn copySlot(dst: *Slot, src: *const Slot) void {
    dst.len = src.len;
    if (src.len > 0) {
        @memcpy(dst.data[0..src.len], src.data[0..src.len]);
    }
}

pub fn removeAt(q: *Q, i: usize) void {
    if (i >= q.len) return;
    if (i == 0) {
        pop(q);
        return;
    }
    var j: usize = i;
    while (j + 1 < q.len) : (j += 1) {
        const dst_i = (q.head + j) % MAX_ITEMS;
        const src_i = (q.head + j + 1) % MAX_ITEMS;
        copySlot(&q.slots[dst_i], &q.slots[src_i]);
    }
    q.slots[(q.head + q.len - 1) % MAX_ITEMS].len = 0;
    q.len -= 1;
}

pub fn replaceAt(q: *Q, i: usize, text: []const u8) error{ Blank, BadIndex }!void {
    if (i >= q.len) return error.BadIndex;
    const idx = (q.head + i) % MAX_ITEMS;
    const s = &q.slots[idx];
    var tmp: [ITEM_BYTES]u8 = undefined;
    const norm = composer_text.normalizeInto(text, tmp[0..], ITEM_BYTES);
    if (norm.is_blank) return error.Blank;
    @memcpy(s.data[0..norm.text.len], norm.text);
    s.len = @intCast(norm.text.len);
}

pub fn clear(q: *Q) void {
    q.head = 0;
    q.len = 0;
    for (&q.slots) |*s| s.len = 0;
}

pub fn canPromote(args: struct {
    editing: bool,
    busy: bool,
    has_pending_submit: bool,
    has_pending_load_earlier: bool,
    count: u32,
}) bool {
    return !args.editing and !args.busy and !args.has_pending_submit and
        !args.has_pending_load_earlier and args.count > 0;
}

/// If `submit` returns true, pop the head. Used by `bridge.tryPromoteQueued`.
pub fn promoteIf(q: *Q, submit: *const fn ([]const u8) bool) bool {
    const text = peek(q) orelse return false;
    if (!submit(text)) return false;
    pop(q);
    return true;
}
