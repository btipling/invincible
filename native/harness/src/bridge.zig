//! Invincible JS ↔ Wasm bridge (Phase 3.6 + Phase 4.4 v2 hydrate/batch).
//!
//! Host (Next/TS) owns network (`POST /api/chat`) and DOM shell.
//! Wasm owns dvui frame loop and local transcript state.
//!
//! `export fn inv_*` live here; they must also be listed in
//! `build.zig` → `root_module.export_symbol_names` (Zig 0.16 Wasm GC roots).
//! Protocol doc: README.md.
const WebBackend = @import("web-backend");
const image_cache = @import("rich/image_cache.zig");
const math_cache = @import("rich/math_cache.zig");
const composer_text = @import("composer_text.zig");
const ring_slot = @import("ring_slot.zig");

/// Bump on breaking export/layout changes. Must match `HARNESS_PROTOCOL_VERSION` in TS.
/// v9: pending cancel (user Stop) — additive exports.
/// v10: tool-run aggregation message kind (kind 6, `tool_run`) — no new export.
/// v11: additive ring-readback exports for tests (`inv_message_*_at`) — see below.
/// v12: additive message kind 7 `skill_attached` (display-only skill row) — no new export.
/// v13: additive status-slot store (plan #538/#541) — `inv_set_status_slot`,
/// `inv_status_slot_len/copy`, `inv_status_slots_clear`.
pub const PROTOCOL_VERSION: u32 = 13;

pub const Lifecycle = enum(u8) {
    boot = 0,
    ready = 1,
    busy = 2,
    err = 3,
};

pub const MessageKind = enum(u8) {
    user = 1,
    assistant = 2,
    system = 3,
    error_msg = 4,
    /// Protocol v8 — model reasoning monologue (display-only; not folded into history).
    thinking = 5,
    /// Protocol v10 — host-aggregated tool-run group (display-only, session role `tool_run`).
    /// Payload is the versioned delimiter format decoded by `rich/toolrun.zig`.
    tool_run = 6,
    /// Protocol v12 — display-only `Skill attached: <slug>` row (session role
    /// `skill_attached`). Enum value 7 (next after tool_run) — distinct from the
    /// protocol version 12.
    skill_attached = 7,
};

/// Transcript ring slots. Host `HARNESS_RING_MAX` must match.
/// Sized for long multi-tool agent turns — not a toy ring.
const MAX_MSG = 2048;
/// Ring capacity exposed to the thinking-collapse policy
/// (`thinking_collapse.zig`) — the physical-slot namespace for busy-turn
/// membership math. Internal (read in-Wasm, never exported): no build.zig
/// whitelist change, no protocol bump.
pub const RING_CAP: usize = MAX_MSG;
/// Cap per transcript line (UTF-8 bytes). Host truncates to this before push/update.
/// 256 KiB — long thinking / assistant monologues (caution-theater 4–64 KiB removed).
/// Single source of truth: `ring_slot.MAX_MSG_LEN` (host-unit-tested seam, #404).
pub const MAX_MSG_LEN = ring_slot.MAX_MSG_LEN;
const ECHO_CAP = 1024;
/// User submit buffer (composer → host).
pub const SUBMIT_CAP = 262144;
/// Protocol v3 model catalog caps (host pushes UTF-8 model ids).
pub const MAX_CATALOG = 64;
pub const MAX_MODEL_ID_LEN = 128;
/// Protocol v13 status-slot store (host pushes one status slot value).
/// Slots are a fixed, bounded array — a host push REPLACES a slot (no append/
/// accumulation), mirroring the model-catalog pattern but keyed by index so
/// later phases (git/context slots) can reserve slots without ABI churn.
pub const MAX_STATUS_SLOTS = 8;
pub const MAX_STATUS_SLOT_LEN = 96;
/// Slot indices — shared contract with the DOM host (plan #538/#541).
/// Sandbox and cwd ship in phase 1; git/context are reserved for phases 2/3.
pub const STATUS_SLOT_SANDBOX: u32 = 0;
pub const STATUS_SLOT_CWD: u32 = 1;
pub const STATUS_SLOT_GIT: u32 = 2;
pub const STATUS_SLOT_CONTEXT: u32 = 3;
/// Priority order for dropping slots on narrow canvases (last = kept longest).
/// git → context → cwd → sandbox (sandbox is the LAST to hide). Phase 1 paints
/// sandbox + cwd only; the drop order anticipates phases 2/3 placeholders.
pub const STATUS_SLOT_DROP_ORDER = [_]u32{ STATUS_SLOT_GIT, STATUS_SLOT_CONTEXT, STATUS_SLOT_CWD, STATUS_SLOT_SANDBOX };

/// Ring slot type. The per-slot `revision` (bumped by `ring_slot.write` on
/// every body write — #404 dirty detection) lives in `ring_slot.Slot`; all
/// body writes are routed through that single seam so the bump is structural,
/// not remembered. Host-tested in `test-rich` (`ring_slot.zig`).
/// Revision is internal only (read in-Wasm, never exported): no build.zig
/// whitelist change.
const StoredMsg = ring_slot.Slot;

var lifecycle: Lifecycle = .boot;
var messages: [MAX_MSG]StoredMsg = [_]StoredMsg{.{}} ** MAX_MSG;
var msg_head: usize = 0;
var msg_count: usize = 0;

var echo_buf: [ECHO_CAP]u8 = undefined;
var echo_len: u32 = 0;

var pending_submit: [SUBMIT_CAP]u8 = undefined;
var pending_submit_len: u32 = 0;
var has_pending_submit: bool = false;
/// Host sets when SessionStore has messages older than the current ring window.
var can_load_earlier: bool = false;
var has_pending_load_earlier: bool = false;
/// Protocol v9 — user Stop; host polls and aborts inflight turn.
var has_pending_cancel: bool = false;
var suppress_refresh: bool = false;

const CatalogEntry = struct {
    len: u32 = 0,
    data: [MAX_MODEL_ID_LEN]u8 = undefined,
};

var catalog: [MAX_CATALOG]CatalogEntry = [_]CatalogEntry{.{}} ** MAX_CATALOG;
var catalog_count: u32 = 0;
var selected_index: u32 = 0;

const StatusSlot = struct {
    len: u32 = 0,
    data: [MAX_STATUS_SLOT_LEN]u8 = undefined,
};

/// Protocol v13 status-slot store (keyed, bounded). A push to an index replaces
/// that slot; out-of-range or oversize pushes are rejected. `reset()` clears all.
var status_slots: [MAX_STATUS_SLOTS]StatusSlot = [_]StatusSlot{.{}} ** MAX_STATUS_SLOTS;

fn refresh() void {
    if (suppress_refresh) return;
    WebBackend.wasm.wasm_refresh();
}

fn copySlice(dst: []u8, src: []const u8) u32 {
    const n = @min(dst.len, src.len);
    if (n > 0) @memcpy(dst[0..n], src[0..n]);
    return @intCast(n);
}

pub fn getLifecycle() Lifecycle {
    return lifecycle;
}

pub fn messageCount() usize {
    return msg_count;
}

/// Current ring head: the physical slot the *next* message write will use
/// (0..RING_CAP). #424 — the collapse policy keys busy-turn membership on this
/// (ring-forward slot range from the busy-start slot), so it stays correct even
/// when the ring is saturated or has wrapped. Internal (read in-Wasm, never
/// exported): no build.zig whitelist change.
pub fn messageHead() usize {
    return msg_head;
}

pub fn messageAt(i: usize) ?struct { kind: u8, text: []const u8 } {
    if (i >= msg_count) return null;
    const idx = (msg_head + MAX_MSG - msg_count + i) % MAX_MSG;
    const m = &messages[idx];
    return .{ .kind = m.kind, .text = m.data[0..m.len] };
}

/// Physical ring slot backing visible index `i` (0..msg_count), or null.
/// #404: the slot-keyed caches key on this (not the visible index) so ring wrap
/// / truncate can never alias a stale cache entry onto a different message.
pub fn messageSlotAt(i: usize) ?usize {
    if (i >= msg_count) return null;
    return (msg_head + MAX_MSG - msg_count + i) % MAX_MSG;
}

/// Per-slot write-revision for visible index `i`, or 0 when out of range.
/// #404: O(1) dirty detection — painter compares to its cached revision.
pub fn messageRevisionAt(i: usize) u32 {
    const s = messageSlotAt(i) orelse return 0;
    return messages[s].revision;
}

pub fn lastEcho() []const u8 {
    return echo_buf[0..echo_len];
}

pub fn queueSubmitFromUi(text: []const u8) void {
    // Preserve leading whitespace/newlines so a multi-line paste that starts
    // with blank lines or an indented first line is not silently flattened on
    // submit (composer_text.zig already normalized CRLF -> LF). We only reject
    // when the *entire* text is blank/whitespace (host validates again).
    if (composer_text.isBlank(text)) return;
    // Ignore while host is processing, submit pending, or load-earlier pending.
    if (lifecycle == .busy or has_pending_submit or has_pending_load_earlier) return;
    pending_submit_len = copySlice(&pending_submit, text);
    has_pending_submit = pending_submit_len > 0;
    if (!has_pending_submit) return;
    // Immediate user line in Wasm transcript; host uses pushUser:false on this path.
    {
        // #404 write seam — bumps revision so slot-keyed caches re-parse.
        ring_slot.write(&messages[msg_head], 1, pending_submit[0..pending_submit_len]);
        msg_head = (msg_head + 1) % MAX_MSG;
        if (msg_count < MAX_MSG) msg_count += 1;
    }
    lifecycle = .busy;
    refresh();
}

/// User Stop — discard unacked submit and signal host to abort. Does not set Ready.
pub fn queueCancelFromUi() void {
    if (lifecycle != .busy and !has_pending_submit) return;
    has_pending_submit = false;
    pending_submit_len = 0;
    has_pending_cancel = true;
    refresh();
}

pub fn reset() void {
    lifecycle = .boot;
    msg_head = 0;
    msg_count = 0;
    echo_len = 0;
    has_pending_submit = false;
    pending_submit_len = 0;
    can_load_earlier = false;
    has_pending_load_earlier = false;
    has_pending_cancel = false;
    suppress_refresh = false;
    catalog_count = 0;
    selected_index = 0;
    for (&status_slots) |*s| s.len = 0;
    image_cache.clear();
    math_cache.clear();
}

pub fn modelCatalogCount() u32 {
    return catalog_count;
}

/// Selected model id bytes, or empty if catalog empty.
pub fn selectedModelId() []const u8 {
    if (catalog_count == 0) return &[_]u8{};
    const idx = @min(selected_index, catalog_count - 1);
    const e = &catalog[idx];
    return e.data[0..e.len];
}

/// Short label for UI: after last '/' else full id.
pub fn selectedModelLabel() []const u8 {
    const id = selectedModelId();
    if (id.len == 0) return id;
    var last_slash: ?usize = null;
    for (id, 0..) |c, i| {
        if (c == '/') last_slash = i;
    }
    if (last_slash) |s| {
        if (s + 1 < id.len) return id[s + 1 ..];
    }
    return id;
}

/// Cycle selection forward. No-op if count ≤ 1.
pub fn cycleSelectedModel() void {
    if (catalog_count <= 1) return;
    selected_index = (selected_index + 1) % catalog_count;
    refresh();
}

/// Protocol v13 — current status-slot value bytes (`slot_status`), or empty when
/// out of range / unset. ui.zig paints the header slots from this.
pub fn statusSlotValue(slot: u32) []const u8 {
    if (slot >= MAX_STATUS_SLOTS) return &[_]u8{};
    const s = &status_slots[slot];
    return s.data[0..s.len];
}

pub fn canLoadEarlier() bool {
    return can_load_earlier;
}

/// Canvas "Load earlier" — host polls pending and hydrates an older SessionStore window.
pub fn queueLoadEarlierFromUi() void {
    if (!can_load_earlier or has_pending_load_earlier) return;
    if (lifecycle == .busy or has_pending_submit) return;
    has_pending_load_earlier = true;
    refresh();
}

// ── Stable ABI (also whitelist in build.zig export_symbol_names) ───────────

export fn inv_protocol_version() u32 {
    return PROTOCOL_VERSION;
}

/// Round-trip scalar probe: returns `x ^ 0xA5A5`.
export fn inv_ping(x: i32) i32 {
    return x ^ 0xA5A5;
}

export fn inv_set_lifecycle(status: u8) void {
    lifecycle = switch (status) {
        0 => .boot,
        1 => .ready,
        2 => .busy,
        3 => .err,
        else => .err,
    };
    refresh();
}

/// Host reads authoritative lifecycle (0–3).
export fn inv_get_lifecycle() u8 {
    return @intFromEnum(lifecycle);
}

/// Transcript length (ring count).
export fn inv_message_count() u32 {
    return @intCast(msg_count);
}

// ── Protocol v11 — additive ring-readback exports (tests only) ─────────────
// Host-tests / real-Wasm integration read the ring via these to observe kind-6
// rows and their bodies exactly as painted. They are additive read-only windows:
// they never mutate the ring, never count toward `inv_message_count`, and never
// affect paint. Zero → out of range / mismatch, mirroring `messageAt(i)`.

export fn inv_message_kind_at(i: u32) u8 {
    const m = messageAt(i) orelse return 0;
    return m.kind;
}

export fn inv_message_text_len_at(i: u32) u32 {
    const m = messageAt(i) orelse return 0;
    return @intCast(m.text.len);
}

export fn inv_message_text_copy_at(i: u32, out: [*]u8, max_len: usize) u32 {
    const m = messageAt(i) orelse return 0;
    return copySlice(out[0..@min(max_len, m.text.len)], m.text);
}

/// Batch host→Wasm updates (hydrate) without per-message wasm_refresh.
export fn inv_begin_batch() void {
    suppress_refresh = true;
}

export fn inv_end_batch() void {
    suppress_refresh = false;
    refresh();
}

export fn inv_push_message(kind: u8, ptr: [*]const u8, len: usize) void {
    // #404 write seam — bumps revision so slot-keyed caches re-parse.
    ring_slot.write(&messages[msg_head], kind, ptr[0..len]);
    msg_head = (msg_head + 1) % MAX_MSG;
    if (msg_count < MAX_MSG) msg_count += 1;
    refresh();
}

/// Replace the newest ring message when kind matches (protocol v7+ stream growth; Thinking in v8).
/// Returns 1 on update, 0 if empty ring or kind mismatch.
export fn inv_update_last_message(kind: u8, ptr: [*]const u8, len: usize) u8 {
    if (msg_count == 0) return 0;
    const idx = (msg_head + MAX_MSG - 1) % MAX_MSG;
    const slot = &messages[idx];
    if (slot.kind != kind) return 0;
    // #404 write seam — bumps revision (stream growth → re-parse the live row).
    ring_slot.write(slot, kind, ptr[0..len]);
    refresh();
    return 1;
}

export fn inv_clear_messages() void {
    msg_head = 0;
    msg_count = 0;
    has_pending_cancel = false;
    image_cache.clear();
    math_cache.clear();
    refresh();
}

/// Store UTF-8 for later `inv_echo_copy`. Returns stored length (capped).
export fn inv_echo(ptr: [*]const u8, len: usize) u32 {
    echo_len = copySlice(&echo_buf, ptr[0..len]);
    refresh();
    return echo_len;
}

export fn inv_echo_len() u32 {
    return echo_len;
}

export fn inv_echo_copy(out_ptr: [*]u8, max_len: usize) u32 {
    const n = @min(max_len, @as(usize, echo_len));
    if (n > 0) @memcpy(out_ptr[0..n], echo_buf[0..n]);
    return @intCast(n);
}

export fn inv_has_pending_submit() u8 {
    return if (has_pending_submit) 1 else 0;
}

export fn inv_pending_submit_len() u32 {
    return if (has_pending_submit) pending_submit_len else 0;
}

export fn inv_pending_submit_copy(out_ptr: [*]u8, max_len: usize) u32 {
    if (!has_pending_submit) return 0;
    const n = @min(max_len, @as(usize, pending_submit_len));
    if (n > 0) @memcpy(out_ptr[0..n], pending_submit[0..n]);
    return @intCast(n);
}

export fn inv_ack_pending_submit() void {
    has_pending_submit = false;
    pending_submit_len = 0;
    refresh();
}

export fn inv_set_can_load_earlier(v: u8) void {
    const next = v != 0;
    if (can_load_earlier == next) return;
    can_load_earlier = next;
    if (!can_load_earlier) has_pending_load_earlier = false;
    refresh();
}

export fn inv_has_pending_load_earlier() u8 {
    return if (has_pending_load_earlier) 1 else 0;
}

export fn inv_ack_pending_load_earlier() void {
    has_pending_load_earlier = false;
}

/// Protocol v9 — host polls user Stop.
export fn inv_has_pending_cancel() u8 {
    return if (has_pending_cancel) 1 else 0;
}

export fn inv_ack_pending_cancel() void {
    has_pending_cancel = false;
}

// ── Protocol v3 model catalog ──────────────────────────────────────────────

export fn inv_clear_model_catalog() void {
    catalog_count = 0;
    selected_index = 0;
    refresh();
}

/// Append one UTF-8 model id. Returns 1 on success, 0 if rejected (empty/oversize/full).
export fn inv_push_model_catalog_entry(ptr: [*]const u8, len: usize) u8 {
    if (len == 0 or len > MAX_MODEL_ID_LEN) return 0;
    if (catalog_count >= MAX_CATALOG) return 0;
    const src = ptr[0..len];
    // Reject ids containing control chars / whitespace (gateway ids are [a-zA-Z0-9./_:-] etc.)
    for (src) |c| {
        if (c < 0x21 or c > 0x7e) return 0; // printable ASCII only
    }
    const slot = &catalog[catalog_count];
    slot.len = copySlice(&slot.data, src);
    catalog_count += 1;
    if (catalog_count == 1) selected_index = 0;
    refresh();
    return 1;
}

export fn inv_model_catalog_count() u32 {
    return catalog_count;
}

export fn inv_selected_model_len() u32 {
    return @intCast(selectedModelId().len);
}

export fn inv_selected_model_copy(out_ptr: [*]u8, max_len: usize) u32 {
    const id = selectedModelId();
    const n = @min(max_len, id.len);
    if (n > 0) @memcpy(out_ptr[0..n], id[0..n]);
    return @intCast(n);
}

/// Cycle selected model (UI / tests). Returns new index or 0 if empty.
export fn inv_cycle_selected_model() u32 {
    cycleSelectedModel();
    if (catalog_count == 0) return 0;
    return selected_index;
}

// ── Protocol v13 — status-slot store (host → Wasm) ────────────────────────
// Fixed, keyed, bounded. A host push REPLACES one slot (no accumulation). The
// store is additive to v12 (old exports untouched).

/// Set one status slot to a host string. Returns 1 on success, 0 on out-of-range
/// index or oversized value. `len == 0` CLEARS the slot (empty slot => hidden in
/// the pack); values over `MAX_STATUS_SLOT_LEN` are rejected (never silently
/// truncated on the wire — the cap is authoritative).
export fn inv_set_status_slot(slot: u32, ptr: [*]const u8, len: usize) u8 {
    if (slot >= MAX_STATUS_SLOTS) return 0;
    if (len > MAX_STATUS_SLOT_LEN) return 0;
    const s = &status_slots[slot];
    if (len == 0) {
        s.len = 0;
        refresh();
        return 1;
    }
    s.len = copySlice(&s.data, ptr[0..len]);
    refresh();
    return 1;
}

export fn inv_status_slot_len(slot: u32) u32 {
    const v = statusSlotValue(slot);
    return @intCast(v.len);
}

export fn inv_status_slot_copy(slot: u32, out_ptr: [*]u8, max_len: usize) u32 {
    const v = statusSlotValue(slot);
    const n = @min(max_len, v.len);
    if (n > 0) @memcpy(out_ptr[0..n], v[0..n]);
    return @intCast(n);
}

export fn inv_status_slots_clear() void {
    for (&status_slots) |*s| s.len = 0;
    refresh();
}

// ── Protocol v4 image texture cache ───────────────────────────────────────

/// Copy host-decoded RGBA into the paint cache. Returns 0=ok, nonzero=error.
export fn inv_image_cache_put(
    url_ptr: [*]const u8,
    url_len: usize,
    rgba_ptr: [*]const u8,
    width: u32,
    height: u32,
) u8 {
    const url = url_ptr[0..url_len];
    const need: usize = @as(usize, width) * @as(usize, height) * 4;
    // Host passes full buffer; reject if width/height would overflow.
    if (width == 0 or height == 0) return 1;
    if (need > image_cache.MAX_RGBA_BYTES) return 2;
    const rgba = rgba_ptr[0..need];
    image_cache.put(url, rgba, width, height) catch return 3;
    refresh();
    return 0;
}

export fn inv_image_cache_clear() void {
    image_cache.clear();
    refresh();
}

// ── Protocol v5 math texture cache ────────────────────────────────────────

/// Copy host-rasterized math RGBA. display: 0=inline, 1=display.
/// Returns 0=ok, nonzero=error.
export fn inv_math_cache_put(
    tex_ptr: [*]const u8,
    tex_len: usize,
    display: u8,
    rgba_ptr: [*]const u8,
    width: u32,
    height: u32,
) u8 {
    const tex = tex_ptr[0..tex_len];
    const need: usize = @as(usize, width) * @as(usize, height) * 4;
    if (width == 0 or height == 0) return 1;
    if (need > math_cache.MAX_RGBA_BYTES) return 2;
    const rgba = rgba_ptr[0..need];
    math_cache.put(tex, display, rgba, width, height) catch return 3;
    refresh();
    return 0;
}

export fn inv_math_cache_clear() void {
    math_cache.clear();
    refresh();
}
