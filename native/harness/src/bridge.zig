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

/// Bump on breaking export/layout changes. Must match `HARNESS_PROTOCOL_VERSION` in TS.
pub const PROTOCOL_VERSION: u32 = 8;

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
};

const MAX_MSG = 48;
/// Cap per transcript line (UTF-8). Longer Gateway replies are truncated at the host edge.
pub const MAX_MSG_LEN = 4096;
const ECHO_CAP = 1024;
pub const SUBMIT_CAP = 4096;
/// Protocol v3 model catalog caps (host pushes UTF-8 model ids).
pub const MAX_CATALOG = 64;
pub const MAX_MODEL_ID_LEN = 128;

const StoredMsg = struct {
    kind: u8 = 0,
    len: u32 = 0,
    data: [MAX_MSG_LEN]u8 = undefined,
};

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
var suppress_refresh: bool = false;

const CatalogEntry = struct {
    len: u32 = 0,
    data: [MAX_MODEL_ID_LEN]u8 = undefined,
};

var catalog: [MAX_CATALOG]CatalogEntry = [_]CatalogEntry{.{}} ** MAX_CATALOG;
var catalog_count: u32 = 0;
var selected_index: u32 = 0;

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

pub fn messageAt(i: usize) ?struct { kind: u8, text: []const u8 } {
    if (i >= msg_count) return null;
    const idx = (msg_head + MAX_MSG - msg_count + i) % MAX_MSG;
    const m = &messages[idx];
    return .{ .kind = m.kind, .text = m.data[0..m.len] };
}

pub fn lastEcho() []const u8 {
    return echo_buf[0..echo_len];
}

pub fn queueSubmitFromUi(text: []const u8) void {
    // Drop empty / whitespace-only; host validates again.
    var start: usize = 0;
    while (start < text.len and (text[start] == ' ' or text[start] == '\t' or text[start] == '\n' or text[start] == '\r')) : (start += 1) {}
    if (start >= text.len) return;
    // Ignore while host is processing, submit pending, or load-earlier pending.
    if (lifecycle == .busy or has_pending_submit or has_pending_load_earlier) return;
    pending_submit_len = copySlice(&pending_submit, text[start..]);
    has_pending_submit = pending_submit_len > 0;
    if (!has_pending_submit) return;
    // Immediate user line in Wasm transcript; host uses pushUser:false on this path.
    {
        const slot = &messages[msg_head];
        slot.kind = 1; // user
        slot.len = copySlice(&slot.data, pending_submit[0..pending_submit_len]);
        msg_head = (msg_head + 1) % MAX_MSG;
        if (msg_count < MAX_MSG) msg_count += 1;
    }
    lifecycle = .busy;
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
    suppress_refresh = false;
    catalog_count = 0;
    selected_index = 0;
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

/// Batch host→Wasm updates (hydrate) without per-message wasm_refresh.
export fn inv_begin_batch() void {
    suppress_refresh = true;
}

export fn inv_end_batch() void {
    suppress_refresh = false;
    refresh();
}

export fn inv_push_message(kind: u8, ptr: [*]const u8, len: usize) void {
    const src = ptr[0..len];
    const slot = &messages[msg_head];
    slot.kind = kind;
    slot.len = copySlice(&slot.data, src);
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
    const src = ptr[0..len];
    slot.len = copySlice(&slot.data, src);
    refresh();
    return 1;
}

export fn inv_clear_messages() void {
    msg_head = 0;
    msg_count = 0;
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
