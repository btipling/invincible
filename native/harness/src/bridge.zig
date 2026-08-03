//! Invincible JS ↔ Wasm bridge (Phase 3.6–3.7 / issues #21–#22).
//!
//! Host (Next/TS) owns network (`POST /api/chat`) and DOM shell.
//! Wasm owns dvui frame loop and local transcript state.
//!
//! `export fn inv_*` live here; they must also be listed in
//! `build.zig` → `root_module.export_symbol_names` (Zig 0.16 Wasm GC roots).
//! Protocol doc: README.md.
const WebBackend = @import("web-backend");

/// Bump on breaking export/layout changes. Must match `HARNESS_PROTOCOL_VERSION` in TS.
pub const PROTOCOL_VERSION: u32 = 1;

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
};

const MAX_MSG = 16;
/// Cap per transcript line (UTF-8). Longer Gateway replies are truncated at the host edge.
pub const MAX_MSG_LEN = 4096;
const ECHO_CAP = 1024;
pub const SUBMIT_CAP = 4096;

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

fn refresh() void {
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
    // Ignore while host is already processing or a submit is still pending.
    if (lifecycle == .busy or has_pending_submit) return;
    pending_submit_len = copySlice(&pending_submit, text[start..]);
    has_pending_submit = pending_submit_len > 0;
    if (!has_pending_submit) return;
    // Immediate user line in Wasm transcript; host uses pushUser:false on this path.
    _ = pushMessage(1, pending_submit[0..pending_submit_len]);
    lifecycle = .busy;
}

pub fn reset() void {
    lifecycle = .boot;
    msg_head = 0;
    msg_count = 0;
    echo_len = 0;
    has_pending_submit = false;
    pending_submit_len = 0;
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

export fn inv_push_message(kind: u8, ptr: [*]const u8, len: usize) void {
    const src = ptr[0..len];
    const slot = &messages[msg_head];
    slot.kind = kind;
    slot.len = copySlice(&slot.data, src);
    msg_head = (msg_head + 1) % MAX_MSG;
    if (msg_count < MAX_MSG) msg_count += 1;
    refresh();
}

export fn inv_clear_messages() void {
    msg_head = 0;
    msg_count = 0;
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
