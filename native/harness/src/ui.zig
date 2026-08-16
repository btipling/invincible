//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! Polish (4.7): density, focus composer, touch targets, scroll stick-to-bottom.
//! #131 / plan #135: persistent transcript ScrollInfo + conditional stick rules.
//! #251: stick also on in-place stream growth (update_last / content height).
//! #137/#579: absolute-rect bands for transcript + composer (composer hugs one
//! line via previous-frame measured height, grows up to cap); status bar stays
//! absolute-rect at the very bottom. Build id (`h:…`) detects stale wasm.
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");
const build_options = @import("build_options");
const rich = @import("rich/root.zig");
const mixed_text = @import("rich/mixed_text.zig");
const composer_text = @import("composer_text.zig");
const cwd_slot = @import("cwd_slot.zig");
const toolrun = @import("rich/toolrun.zig");
const thinking_collapse = @import("thinking_collapse.zig");
const busy_row = @import("busy_row.zig");

/// Baked at compile time (`-Dbuild-id=…`); shown in header to detect stale wasm.
pub const BUILD_ID: []const u8 = build_options.build_id;

var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

/// First frame after init: focus the composer once.
var want_composer_focus: bool = true;
/// Shown line count last frame (messages + optional busy row).
var last_shown_count: usize = 0;
/// Ring message count last frame (for clear / hydrate / user-send detection).
var last_msg_count: usize = 0;
/// Virtual content scrollMax from last frame — stream growth detection (#251).
var last_scroll_max_y: f32 = 0;
/// Persistent across frames — frame-local ScrollInfo zeros viewport every paint.
var transcript_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

/// Two-level expand state for tool-run rows (#325 / plan #345), keyed by
/// per-message and per-item ids. Keeps open groups across repaints/frames the
/// way `reorder_tree.zig` keeps its open branches; cleared on reload/clear/
/// truncate so a fresh surface starts collapsed.
var toolrun_open_buf: [16384]u8 = undefined;
var toolrun_open_fba = std.heap.FixedBufferAllocator.init(&toolrun_open_buf);
var toolrun_open_l1 = std.AutoHashMap(dvui.Id, void).init(toolrun_open_fba.allocator());
var toolrun_open_l2 = std.AutoHashMap(dvui.Id, void).init(toolrun_open_fba.allocator());

/// #424 — in-memory operator-open set for committed (collapsed) thinking rows,
/// keyed by per-message thinking id. Mirrors `toolrun_open_l1` so a collapsed
/// thinking row the operator expands stays open across frames until toggled or
/// the transcript is cleared. Thinking is ephemeral (never survives refresh),
/// so no persisted state is needed.
var thinking_open_buf: [8192]u8 = undefined;
var thinking_open_fba = std.heap.FixedBufferAllocator.init(&thinking_open_buf);
var thinking_open_l1 = std.AutoHashMap(dvui.Id, void).init(thinking_open_fba.allocator());

fn clearThinkingOpenState() void {
    thinking_open_l1.clearRetainingCapacity();
}

/// #424 — the Wasm collapse-policy state: tracks the active Busy turn start so
/// the policy knows which thinking rows are "current turn" (full) vs committed
/// (collapsed).
var thinking_collapse_state: thinking_collapse.State = .{};
/// Previous lifecycle seen by `frame()` — for busy->ready/err edge detection.
var prev_lifecycle: thinking_collapse.Lifecycle = .boot;

fn clearToolRunOpenState() void {
    toolrun_open_l1.clearRetainingCapacity();
    toolrun_open_l2.clearRetainingCapacity();
}

/// Touch-friendly control height (CSS px ≈).
const TOUCH_H: f32 = 40;
/// Near-bottom epsilon for stick-to-bottom follow (plan #135).
const NEAR_BOTTOM_PX: f32 = 48;
/// Ignore subpixel layout noise when detecting in-place stream growth (#251).
const CONTENT_GREW_EPS: f32 = 1.0;
/// Reserved bottom chrome: single-row textEntry + trailing TOUCH_H icon + margins
/// (plan #457 — replaces the old textEntry + Send/Stop action row from plan #138).
/// Per-edge margin between textEntry content rect and composer-chrome box edge
/// (Options.padding.y). Plan #579 replaces the old fixed COMPOSER_PAD_Y (4 px
/// top-only) with 2 px per edge on the new dynamic hug box.
const COMPOSER_HUG_PAD: f32 = 2;
/// Multi-line composer visible-height cap (px). Wrapped lines grow the entry up
/// to this, then it scrolls vertically **inside** the entry — never a horizontal
/// gutter past the trailing icon (plan #457, repo no-h-scroll policy). The
/// composer-chrome box caps at COMPOSER_INPUT_MAX_H + 2*COMPOSER_HUG_PAD via
/// max_size_content; taller pasted content scrolls internally (plan #334 / #323).
const COMPOSER_INPUT_MAX_H: f32 = 120;
/// Vertical margins between header→scroll and scroll→chrome (Options.margin.h).
const BAND_GAP: f32 = 6;
/// Absolute floor so a short canvas still has a scroll band.
const SCROLL_FLOOR_H: f32 = 32;
/// Status-bar band height (px) — a two-line always-mounted full-width strip painted
/// directly BELOW the composer (plan #555 → #554, header merged by plan #570).
/// Reserved into the bottom chrome budget so the transcript never overlaps it and
/// the transcript+composer stack never jumps vertically when a sandbox attaches.
/// 64 px = two 32 px rows, exactly fitting Next (TOUCH_H − 8 = 32) + status slots.
/// Total chrome (64) ≤ old header+bar (92) — net −28 px transcript gain (plan #570).
const STATUS_BAR_H: f32 = 64;

/// Maximum composer-chrome outer height (px). The composer box rect grows up to
/// this from idle hug (~44 px) via previous-frame measured height. Multi-line
/// content past this cap scrolls internally (plan #457). The rect is still
/// absolute (Options.rect), so the scrollArea never publishes virtual content
/// height into the root flex (dvui `.auto` bar overwrites min_size.h —
/// adversarial review #584 Blocker L1).
const COMPOSER_MAX_CHROME_H: f32 = COMPOSER_INPUT_MAX_H + 2 * COMPOSER_HUG_PAD;
/// Idle composer-chrome outer height (px) when the field is a single line.
/// TOUCH_H (40) + 2 px top + 2 px bottom padding = 44 px. The composer band
/// is never smaller than this so the textEntry always has a touch target.
const COMPOSER_IDLE_CHROME_H: f32 = TOUCH_H + 2 * COMPOSER_HUG_PAD;

/// TextEntry internal padding + border overhead (px). The textEntry's computed
/// min_size (via dvui.minSizeGet after deinit) is the OUTER height (content +
/// padding + border). We convert outer→content: content_h = outer_h − overhead.
/// Both values set explicitly on the textEntry below so the formula is
/// deterministic regardless of dvui defaults (adversarial review #584 Round 3
/// Major L1+L9 — `WidgetData.min_size` is the options seed, not the computed
/// wrapped height; the sample must come from minSizeGet after deinit).
const TE_PAD_H: f32 = 6 + 6; // padding.y + padding.h
const TE_BORDER_H: f32 = 1 + 1; // border.y + border.h
const TE_OVERHEAD: f32 = TE_PAD_H + TE_BORDER_H; // 14

/// Previous-frame measured composer-chrome outer height (px). Initialized to
/// idle so the first frame shows a compact composer. Updated after each frame
/// from the textEntry's natural wrapped height (sampled via dvui.minSizeGet
/// after te.deinit — NOT te.data().min_size which is the options seed); clamped
/// to [IDLE, MAX] so the band never collapses and never exceeds the multi-line
/// cap. The transcript rect is computed from this value, so both bands shift in
/// tandem (one-frame settle lag, no visual jump — adversarial review #584
/// Round 2 Major L1 and Round 3 Major L1+L9).
var composer_last_h: f32 = COMPOSER_IDLE_CHROME_H;

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
    want_composer_focus = true;
    resetTranscriptScroll();
    rich.clearCache();
    // Reset the previous-frame hug to idle: an in-process re-init (wasm reload
    // / host re-mount) must not keep a stale multi-line 124 px band until the
    // next wrap sample (adversarial review #584 Round 4 Minor L8).
    composer_last_h = COMPOSER_IDLE_CHROME_H;
}

fn resetTranscriptScroll() void {
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
}

fn isNearBottom(si: *const dvui.ScrollInfo) bool {
    return si.offsetFromMax(.vertical) <= NEAR_BOTTOM_PX;
}

fn clampScrollToContent(si: *dvui.ScrollInfo) void {
    const max_y = si.scrollMax(.vertical);
    if (si.viewport.y > max_y) si.viewport.y = max_y;
    if (si.viewport.y < 0) si.viewport.y = 0;
}

fn scrollToBottom(si: *dvui.ScrollInfo) void {
    si.viewport.y = si.scrollMax(.vertical);
}

pub fn onDeinit() void {}

fn kindLabel(kind: u8) []const u8 {
    return switch (kind) {
        1 => "you",
        2 => "assistant",
        3 => "system",
        4 => "error",
        5 => "thinking",
        6 => "tools",
        7 => "skill",
        else => "msg",
    };
}

fn lifecycleLabel(l: bridge.Lifecycle) []const u8 {
    return switch (l) {
        .boot => "boot",
        .ready => "ready",
        .busy => "busy",
        .err => "error",
    };
}

fn kindTextColor(kind: u8) dvui.Color {
    return switch (kind) {
        1 => palette.teal_accent,
        2 => palette.warm_accent,
        3 => palette.teal_muted,
        4 => palette.ember_accent,
        // Muted warm — thinking monologue (not EMBER, not pure blue).
        5 => palette.warm_muted,
        else => palette.teal_text,
    };
}

fn kindFill(kind: u8) ?dvui.Color {
    return switch (kind) {
        1 => palette.teal_bg,
        2 => palette.teal_surface,
        3 => null,
        4 => palette.ember_surface,
        5 => palette.warm_bg,
        else => null,
    };
}

/// Build a human-readable multi-line summary of a tool-run payload for the Copy
/// button — never the dense `toolrun\t…` wire text. Falls back to the raw body
/// when the payload doesn't decode so we never lose data.
fn toolRunClipboard(text: []const u8) []const u8 {
    const alloc = dvui.currentWindow().arena();
    var decoded = toolrun.decode(alloc, text) orelse return text;
    defer decoded.deinit();
    var out = std.ArrayList(u8).empty;
    errdefer out.deinit(alloc);
    var line_buf: [512]u8 = undefined;
    for (decoded.run.items) |it| {
        const g: []const u8 = switch (it.status) {
            .ok => "✓",
            .fail => "✗",
            .running => "…",
        };
        const name = if (it.name.len > 0) it.name else "tool";
        const label = if (it.brief.len > 0) it.brief else name;
        const line = std.fmt.bufPrint(&line_buf, "{s} {s} — {s}\n", .{ g, name, label }) catch continue;
        out.appendSlice(alloc, line) catch break;
    }
    return out.toOwnedSlice(alloc) catch return text;
}

/// Paint one L0 count chip: a status mark run (a face that covers the code
/// point — ✓/✗ come from the embedded DejaVu Sans Symbols face, `…` is already
/// in the Noto heading face) followed by a heading-face count run. The glyph and
/// the count are separate runs because each face only covers a subset of the
/// code points (DejaVu Sans Symbols has ✓/✗ but no ASCII digits; Noto has digits
/// but no ✓/✗), so a single-face combined "✓ 3" run would tofu the other half.
/// L0 chrome mark size — DejaVu symbols at default body size read as dust next to
/// the "N tools called" heading; bump so ✓/✗/… match the count digits.
fn chromeMarkFont(base: dvui.Font) dvui.Font {
    return base.withSize(base.size + 5).withLineHeight(1.0);
}

/// L0 count digit size — keep with the mark, slightly larger than default heading.
fn chromeCountFont() dvui.Font {
    const h = dvui.Font.theme(.heading);
    return h.withSize(h.size + 2).withLineHeight(1.0);
}

/// Clipboard emoji on the copy control — OpenMoji outlines need ~2× body px.
fn chromeCopyFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return palette.fontEmoji()
        .withSize(body.size * 1.9)
        .withLineHeight(1.0);
}

/// Trailing composer icon glyphs (plan #457) — DejaVu Sans Symbols covers both
/// `▶` (launch/send, U+25B6) and `■` (stop, U+25A0); bump size so they read at
/// the fixed TOUCH_H square instead of tofu/dust.
fn composerIconFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return palette.fontSymbols()
        .withSize(body.size + 4)
        .withLineHeight(1.0);
}

fn paintStatusChip(
    src: std.builtin.SourceLocation,
    box_id: usize,
    glyph_id: usize,
    count_id: usize,
    color: dvui.Color,
    mark: []const u8,
    count: u32,
    mark_font: dvui.Font,
) void {
    var chip = dvui.box(src, .{ .dir = .horizontal }, .{
        .gravity_y = 0.5,
        .id_extra = box_id,
        // No extra pad — chips sit in the trailing chrome row with the copy btn.
        .margin = .{ .x = 0, .y = 0, .w = 2, .h = 0 },
    });
    defer chip.deinit();
    {
        var tl = dvui.textLayout(src, .{}, .{
            .id_extra = glyph_id,
            .color_text = color,
            .font = chromeMarkFont(mark_font),
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 3, .h = 0 },
        });
        tl.addText(mark, .{});
        tl.deinit();
    }
    {
        var tl = dvui.textLayout(src, .{}, .{
            .id_extra = count_id,
            .color_text = color,
            .font = chromeCountFont(),
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 4, .h = 0 },
        });
        tl.format("{d}", .{count}, .{});
        tl.deinit();
    }
}

/// True for tool names whose level-2 detail is a command/output block (exec
/// stdout/stderr, filesystem results, http bodies). Those previews paint in the
/// embedded Vera Sans Mono face for readable alignment (phase 3 #353); other
/// tools fall back to the body face.
fn isCommandLikeRun(name: []const u8) bool {
    return std.mem.eql(u8, name, "exec") or
        std.mem.eql(u8, name, "http_get") or
        std.mem.eql(u8, name, "http_head") or
        std.mem.eql(u8, name, "read_file") or
        std.mem.eql(u8, name, "write_file") or
        std.mem.eql(u8, name, "str_replace") or
        std.mem.eql(u8, name, "list_dir") or
        std.mem.eql(u8, name, "change_dir") or
        std.mem.eql(u8, name, "pwd");
}

/// True when a tool-run level-2 body should paint in the embedded Vera Sans Mono
/// face: command-like builtins (allowlist above) OR any multi-line detail (an
/// MCP/custom tool's dense stdout). Single-line prose detail stays the body face
/// (adversarial review #359 Minor — multi-line output should read as a block).
fn detailUsesMono(name: []const u8, detail: []const u8) bool {
    if (isCommandLikeRun(name)) return true;
    return std.mem.indexOfScalar(u8, detail, '\n') != null;
}

/// Paint an aggregated tool-run control (protocol v10 / kind 6).
///
/// Level 0 (default-collapsed): header `N tools called` + colored count chips
/// (TEAL✓ success / EMBER✗ fail-only / WARM… pending) as a touch-height hit
/// target. Level 1: one one-liner per tool (colored status glyph). Level 2:
/// that tool's inline detail. Returns true when the payload decoded and painted;
/// false means fail-open → caller renders the raw body as plain text.
fn paintToolRun(
    src: std.builtin.SourceLocation,
    msg_index: usize,
    text: []const u8,
    slot: ?usize,
    revision: u32,
) bool {
    // #404: slot-keyed decode cache keyed on (physical ring slot, write-revision).
    // An unchanged revision reuses the previously decoded summary with zero
    // re-decode (O(dirty), not O(N) every frame). The cached summary lives in
    // the long-lived gpa and is owned by the cache — never deinit'd here. The
    // frame loop always passes a slot, so the fresh per-frame arena decode below
    // is only a safety net for hypothetical non-ring callers.
    var owned: ?toolrun.Decoded = null;
    defer if (owned) |*d| d.deinit();
    const arena = dvui.currentWindow().arena();
    const run: ?*const toolrun.ToolRun = if (slot) |s|
        rich.toolrunCacheSlot(s, revision, text)
    else blk: {
        const dec = toolrun.decode(arena, text) orelse break :blk null;
        owned = dec;
        break :blk &owned.?.run;
    };
    if (run == null) return false;
    const runv = run.?;
    // Decoders recount ok/fail/pending from the kept (capped) items, so the
    // header count can never disagree with what actually paints (review).
    const total = runv.ok + runv.fail + runv.pending;

    // IMGUI identity: every widget in this control is keyed off `src` (the
    // single paintToolRun call site), so two tool-run rows must NOT share
    // id_extra — the codebase pattern is `msg_index *% …` (rich/paint.zig,
    // message Copy). `id_base` = msg_index times an odd factor; for the ring's
    // realistic msg_index (≤ MAX_MSG) products stay < 2^32 with no wrap.
    // Items get a 1024-wide namespace each (see item loop); 1000003 > 200·1024,
    // so the whole group stays below the next row's id_base and rows never
    // overlap, and within a row no two (item, widget) pairs can alias.
    const id_base: usize = @as(usize, msg_index) *% 1000003;

    const l1_raw: usize = id_base + 7;
    const l1_key: dvui.Id = @enumFromInt(l1_raw);
    var l1_expanded = toolrun_open_l1.contains(l1_key);

    if (total == 0) return false;

    // ── Level 0 header: expander label + right-aligned colored count chips ──
    var header_label: [40]u8 = undefined;
    const label =
        if (total == 1)
            (std.fmt.bufPrint(&header_label, "1 tool called", .{}) catch "tools")
        else
            (std.fmt.bufPrint(&header_label, "{d} tools called", .{total}) catch "tools");

    {
        // Single horizontal row: expander (fills) + one trailing chrome pack so
        // clipboard + status chips share the same vertical center as the label.
        var head = dvui.box(src, .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 120, .h = TOUCH_H - 4 },
            .id_extra = id_base + 1,
        });
        defer head.deinit();

        // Natural label height + gravity_y centers caret/text with the trail pack.
        // Do NOT force TOUCH_H min height on the expander — dvui pins the label to
        // the top of a tall expander box (operator: "1 tool called" looked top-aligned).
        const open = dvui.expander(src, label, .{ .expanded = &l1_expanded }, .{
            .expand = .horizontal,
            .gravity_y = 0.5,
            .id_extra = id_base + 2,
        });
        if (open) toolrun_open_l1.put(l1_key, {}) catch {} else _ = toolrun_open_l1.remove(l1_key);

        // Trailing pack (right): 📋 then ✓N / ✗N / …N — one gravity box so
        // padding/baseline match (operator: glyphs were tiny + clipboard pad fat
        // + row misaligned when chips and button were separate gravity_x children).
        {
            var trail = dvui.box(src, .{ .dir = .horizontal }, .{
                .gravity_x = 1.0,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 0, .h = TOUCH_H - 8 },
                .id_extra = id_base + 3,
            });
            defer trail.deinit();

            // Compact clipboard — tight pad, larger OpenMoji glyph.
            if (dvui.button(src, "📋", .{}, .{
                .gravity_y = 0.5,
                .style = .content,
                .id_extra = id_base + 29,
                .min_size_content = .{ .w = 22, .h = 22 },
                .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
                .font = chromeCopyFont(),
                .corners = .round(5),
                .color_fill = palette.teal_bg,
                .color_text = palette.teal_accent,
                .color_border = palette.teal_border,
                .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
            })) {
                // Same-frame write only — do not retain ring slices.
                dvui.clipboardTextSet(toolRunClipboard(text));
            }

            // Status marks must not tofu: ✓/✗ come from DejaVu Sans Symbols,
            // `…` from the Noto heading face (see paintStatusChip).
            if (runv.ok > 0) paintStatusChip(src, id_base + 20, id_base + 21, id_base + 22, palette.teal_accent, "✓", runv.ok, palette.fontSymbols());
            if (runv.fail > 0) paintStatusChip(src, id_base + 23, id_base + 24, id_base + 25, palette.ember_accent, "✗", runv.fail, palette.fontSymbols());
            if (runv.pending > 0) paintStatusChip(src, id_base + 26, id_base + 27, id_base + 28, palette.warm_accent, "…", runv.pending, .theme(.heading));
        }
    }

    // ── Level 1 + level 2 (expanded) ────────────────────────────────────────
    if (l1_expanded) {
        var list = dvui.box(src, .{ .dir = .vertical }, .{
            .expand = .horizontal,
            .margin = .{ .x = 10, .y = 0, .w = 0, .h = 0 },
            .id_extra = id_base + 10,
        });
        defer list.deinit();

        for (runv.items) |it| {
            const l2_key: dvui.Id = @enumFromInt(l1_raw *% 31 + it.id);
            // `it.id` is 1-based per group with up to MAX_ITEMS items. Each item
            // owns a 1024-wide namespace (`it_id *% 1024`) under this message's
            // id_base, holding up to 5 widget slots, so every (item, widget)
            // pair is unique within the row even for a full 200-item group;
            // 1000003 > 200·1024 keeps distinct rows disjoint. Matches the
            // rich/paint.zig `msg_index *% …` discipline (id = src + id_extra,
            // not a parent chain).
            const it_id: usize = it.id;
            // Widget slots inside the item's 1024-wide namespace:
            //   +0 item box · +1 status glyph · +2 expander / static label
            //   +3 detail box · +4 detail body
            const item_base: usize = id_base + it_id *% 1024;
            const has_detail = it.detail.len > 0;
            var l2_expanded = toolrun_open_l2.contains(l2_key);

            {
                var item_head = dvui.box(src, .{ .dir = .horizontal }, .{
                    .expand = .horizontal,
                    .min_size_content = .{ .w = 120, .h = TOUCH_H - 6 },
                    .id_extra = item_base + 0,
                });
                defer item_head.deinit();

                const glyph_color: dvui.Color = switch (it.status) {
                    .ok => palette.teal_accent,
                    .fail => palette.ember_accent,
                    .running => palette.warm_accent,
                };
                // Status marks must render (no tofu): ✓/✗ come from the embedded
                // DejaVu Sans Symbols face; `…` is already in the Noto heading face.
                const glyph_font: dvui.Font = switch (it.status) {
                    .ok, .fail => palette.fontSymbols(),
                    .running => .theme(.heading),
                };
                {
                    var tl = dvui.textLayout(src, .{}, .{
                        .id_extra = item_base + 1,
                        .color_text = glyph_color,
                        .gravity_y = 0.5,
                        .font = chromeMarkFont(glyph_font),
                        .margin = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
                    });
                    tl.addText(switch (it.status) {
                        .ok => "✓",
                        .fail => "✗",
                        .running => "…",
                    }, .{});
                    tl.deinit();
                }

                // No-detail items carry only the host's status-suffixed fallback
                // `brief` (`name · ✓/✗/running`); the colored glyph is the single
                // status channel, so paint those labels from `name` to avoid a
                // redundant second status affordance (parent Goal 3 / issue review).
                const item_label: []const u8 = if (has_detail and it.brief.len > 0) it.brief else it.name;
                if (has_detail) {
                    // Same as L0: natural height so label centers with the status glyph.
                    const open = dvui.expander(src, item_label, .{ .expanded = &l2_expanded }, .{
                        .id_extra = item_base + 2,
                        .expand = .horizontal,
                        .gravity_y = 0.5,
                    });
                    if (open) toolrun_open_l2.put(l2_key, {}) catch {} else _ = toolrun_open_l2.remove(l2_key);
                } else {
                    // No level-2 detail (e.g. a short/empty summary) — mount a
                    // static label, not a blank expander (review nit). The no-detail label
                    // is painted from `name`, so the colored glyph is the only status channel.
                    var tl = dvui.textLayout(src, .{}, .{
                        .id_extra = item_base + 2, // expander slot — mutually exclusive
                        .expand = .horizontal,
                        .color_text = palette.teal_text,
                        .gravity_y = 0.5,
                    });
                    tl.addText(item_label, .{});
                    tl.deinit();
                }
            }

            if (has_detail and l2_expanded) {
                var detail = dvui.box(src, .{ .dir = .vertical }, .{
                    .id_extra = item_base + 3,
                    .expand = .horizontal,
                    .margin = .{ .x = 26, .y = 0, .w = 0, .h = 0 },
                });
                defer detail.deinit();
                var tl = dvui.textLayout(src, .{}, .{
                    .id_extra = item_base + 4,
                    .expand = .horizontal,
                    .color_text = palette.teal_text,
                });
                // Phase 3 (#353): command/output previews (exec, filesystem,
                // http) paint in the embedded Vera Sans Mono face for a readable
                // aligned block; prose/other detail stays the body face. Symbols
                // still route to their DejaVu/OpenMoji faces via addTextMixed.
                const detail_font: dvui.Font = if (detailUsesMono(it.name, it.detail))
                    palette.fontMono()
                else
                    .theme(.body);
                mixed_text.addTextMixed(tl, it.detail, detail_font, .{
                    .color_text = palette.teal_text,
                });
                tl.deinit();
            }
        }
    }
    return true;
}

/// True when `b` is a UTF-8 continuation byte (0b10xxxxxx).
fn isUtf8Continuation(b: u8) bool {
    return (b & 0xC0) == 0x80;
}

/// One-line muted preview of a thinking monologue for the collapsed header
/// (text-only, bounded — no markdown parse, no full-body read). Returns a slice
/// into `buf`. Stops at the first newline and caps at ~80 bytes. Review: the
/// byte cap must never cut a multi-byte UTF-8 sequence mid-codepoint (CJK,
/// emoji, combining marks) — that would hand `textLayout` an invalid trailing
/// run, so we back off any truncated multibyte char to a codepoint boundary.
fn thinkingPreview(buf: *[96]u8, text: []const u8) []const u8 {
    var out: usize = 0;
    for (text) |c| {
        if (out >= 80) break;
        if (c == '\n' or c == '\r') break;
        buf[out] = c;
        out += 1;
    }
    // Trailing whitespace isn't part of the preview.
    while (out > 0 and (buf[out - 1] == ' ' or buf[out - 1] == '\t')) out -= 1;
    // Drop a multi-byte char truncated by the byte cap: first any trailing
    // continuation bytes, then a truncated leading byte (0xC0..0xFF). What's
    // left ends on a valid single-byte (ASCII) boundary — never mojibake.
    while (out > 0 and isUtf8Continuation(buf[out - 1])) out -= 1;
    if (out > 0 and (buf[out - 1] & 0xC0) == 0xC0) out -= 1;
    return buf[0..out];
}

/// Paint a thinking row (protocol v8 kind / bridge kind 5, #424).
///
/// When the row belongs to the active Busy turn (or the operator has expanded
/// it), render the FULL GFM monologue through the existing slot-keyed markdown
/// painter. Otherwise render a compact default-collapsed control mirroring the
/// tool-run L0 header: a `Thinking` expander + a bounded muted one-line preview
/// + a Copy button (copies the full source). Toggling flips the in-memory open
/// set so a committed row the operator opens stays open until re-toggled or the
/// transcript is cleared.
///
/// id namespace: `msg_index *% 1000033` (odd prime, distinct from tool-run's
/// `1000003` and the body's `1024`) so thinking chrome never aliases other rows'
/// tool-run/body ids.
fn paintThinking(
    src: std.builtin.SourceLocation,
    msg_index: usize,
    text: []const u8,
    slot: ?usize,
    revision: u32,
) void {
    const id_base: usize = @as(usize, msg_index) *% 1000033;
    const key: dvui.Id = @enumFromInt(id_base + 7);

    // Active-turn rows are pinned FULL while Busy (policy) — not togglable.
    // Committed rows are operator-toggled: `thinking_open_l1` is the only input.
    // Membership is the policy's job (pure, host-tested) — the live streaming
    // newest row is part of the active turn's ring-forward slot range, so it
    // stays full automatically (no ui-side `is_live_newest` escape hatch). The
    // policy took over the saturated-ring guard the old index-threshold used.
    const slotp = slot orelse {
        // A thinking row always maps to a ring slot; bail defensively rather
        // than derive membership from a bare visible index.
        return;
    };
    const ring_head = bridge.messageHead();
    const ring_cap = bridge.RING_CAP;
    const is_active = thinking_collapse_state.isActiveTurnFull(slotp, ring_head, ring_cap);
    const open_by_operator = thinking_open_l1.contains(key);
    // Single policy entry point — both the active-turn pin and the operator
    // override live inside `shouldRenderFull`.
    const full = thinking_collapse_state.shouldRenderFull(slotp, ring_head, ring_cap, open_by_operator);

    // Layout mutates `expanded` across the head + body blocks below. Starts at
    // the policy/output state; for a pinned active-turn row we re-assert `full`
    // after the expander so a click cannot collapse the live reasoning.
    var expanded = full;
    {
        var head = dvui.box(src, .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 120, .h = TOUCH_H - 4 },
            // same warm surface as the kind row uses for thinking (kindFill 5).
            .background = true,
            .color_fill = palette.warm_bg,
            .color_border = palette.teal_border,
            .padding = .{ .x = 8, .y = 2, .w = 8, .h = 2 },
            .id_extra = id_base + 1,
        });
        defer head.deinit();

        // Natural label height + gravity_y centers caret with preview/copy trail.
        const open = dvui.expander(src, "Thinking", .{ .expanded = &expanded }, .{
            .expand = .horizontal,
            .gravity_y = 0.5,
            .id_extra = id_base + 2,
            .color_text = palette.warm_muted,
            .font = .theme(.heading),
        });
        if (is_active) {
            // Pinned; never let a click collapse the live/active-turn reasoning.
            expanded = true;
        } else if (open) {
            thinking_open_l1.put(key, {}) catch {};
            expanded = true;
        } else {
            _ = thinking_open_l1.remove(key);
            expanded = false;
        }

        var trail = dvui.box(src, .{ .dir = .horizontal }, .{
            .gravity_x = 1.0,
            .gravity_y = 0.5,
            .min_size_content = .{ .w = 0, .h = TOUCH_H - 8 },
            .id_extra = id_base + 3,
        });
        defer trail.deinit();

        // Collapsed: bounded muted one-line preview (no markdown parse).
        if (!expanded) {
            var preview_buf: [96]u8 = undefined;
            const preview = thinkingPreview(&preview_buf, text);
            var tl = dvui.textLayout(src, .{}, .{
                .id_extra = id_base + 4,
                .color_text = palette.teal_muted,
                .gravity_y = 0.5,
                .font = .theme(.body),
                .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
            });
            tl.addText(preview, .{});
            tl.deinit();
        }
        // Copy button (full source → clipboard), same chrome as tool-run header.
        if (dvui.button(src, "📋", .{}, .{
            .gravity_y = 0.5,
            .style = .content,
            .id_extra = id_base + 5,
            .min_size_content = .{ .w = 22, .h = 22 },
            .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
            .font = chromeCopyFont(),
            .corners = .round(5),
            .color_fill = palette.teal_bg,
            .color_text = palette.teal_accent,
            .color_border = palette.teal_border,
        })) {
            dvui.clipboardTextSet(text);
        }
    }

    // Full GFM monologue when expanded (functionally unchanged paint path; the
    // slot-keyed parse cache + cache_layout handling is preserved).
    if (expanded) {
        rich.paintMessageBody(src, rich.KIND_THINKING, text, .{
            .msg_index = msg_index,
            .slot = slot,
            .revision = revision,
        });
    }
}

/// Paint a display-only skill-attach row (protocol v12 / kind 7). Headerless and
/// compact: a single muted-TEAL line `Skill attached: <slug>`. The text is the
/// host-built NAME line only — a skill body is never shipped to the client or
/// folded into the model prompt, so there is nothing sensitive here. A long/
/// hostile wire line is hard-capped to ~160 bytes at a UTF-8 boundary with `…`.
fn paintSkillAttached(
    src: std.builtin.SourceLocation,
    msg_index: usize,
    text: []const u8,
) void {
    var cap_buf: [160]u8 = undefined;
    const shown: []const u8 = blk: {
        if (text.len <= cap_buf.len) break :blk text;
        // Reserve 3 bytes for the UTF-8 ellipsis (U+2026 = \xE2\x80\xA6).
        var n: usize = cap_buf.len - 3;
        // Back off a multibyte char truncated by the byte cap (never mojibake).
        while (n > 0 and (text[n] & 0xC0) == 0x80) n -= 1;
        @memcpy(cap_buf[0..n], text[0..n]);
        @memcpy(cap_buf[n .. n + 3], "…");
        break :blk cap_buf[0 .. n + 3];
    };
    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .id_extra = msg_index *% 1024 + 1,
        .color_text = palette.teal_muted,
        .font = .theme(.body),
    });
    mixed_text.addTextMixed(tl, shown, .theme(.body), .{
        .color_text = palette.teal_muted,
    });
    tl.deinit();
}

/// Cap a status-slot value to `MAX_STATUS_SLOT_LEN` bytes at a UTF-8 boundary
/// with a trailing ellipsis (never mojibake). The bridge already refuses
/// oversize pushes, but defends against a hostile pre-v14 wire value anyway.
fn truncateStatusValue(
    buf: *[bridge.MAX_STATUS_SLOT_LEN]u8,
    src: []const u8,
) []const u8 {
    if (src.len <= buf.len) return src;
    // Reserve 3 bytes for the UTF-8 ellipsis (U+2026 = \xE2\x80\xA6).
    var n: usize = buf.len - 3;
    // Back off a multibyte char truncated by the byte cap (never mojibake).
    while (n > 0 and (src[n] & 0xC0) == 0x80) n -= 1;
    @memcpy(buf[0..n], src[0..n]);
    @memcpy(buf[n .. n + 3], "…");
    return buf[0 .. n + 3];
}

/// UTF-8 code-point byte length for the leading byte at `b` (defensive: bridge
/// slot values are already valid UTF-8, so a lead byte maps to its true length;
/// a stray continuation byte (0x80..0xBF) maps to 1 so we never over-read).
fn utf8CharLen(b: u8) usize {
    if (b < 0x80) return 1;
    if (b < 0xC0) return 1; // continuation byte — treat as a lone 1-byte unit
    if (b < 0xE0) return 2;
    if (b < 0xF0) return 3;
    return 4;
}

/// Paint-time PIXEL ellipsizer (PR #543 re-run L9): shrink `src` to fit `max_w`
/// px as measured by `body`, keeping complete UTF-8 code points and a trailing
/// ellipsis. Only reached when the highest-priority status slot cannot fit at
/// full width on a very narrow canvas — so the operator still sees which sandbox
/// is bound (e.g. `sandbox 446655…`) instead of the whole pack painting nothing.
/// Never mutates the stored bridge value. Returns `src` unchanged when it already
/// fits; otherwise writes the ellipsized prefix into `buf` (caller-owned, >= the
/// slot cap) and returns a slice of it.
fn truncateToWidthPx(
    body: dvui.Font,
    buf: []u8,
    src: []const u8,
    max_w: f32,
) []const u8 {
    const ell = "…";
    if (max_w <= 0 or src.len == 0) return "";
    if (body.textSize(src).w <= max_w) return src;
    const ell_w = body.textSize(ell).w;
    var i: usize = 0;
    var used: f32 = 0;
    while (i < src.len) {
        const cl = @min(utf8CharLen(src[i]), src.len - i);
        // Leave room for the trailing ellipsis in the caller's byte buffer: a
        // cap-length slot whose prefix would fill buf entirely must still fit
        // the "…" (Nit L1 — a ≥94-byte cwd would otherwise return "" and leave
        // an empty gutter slot painted with just the 10px gap).
        if (i + cl + ell.len > buf.len) break;
        const cp = src[i .. i + cl];
        const w = body.textSize(cp).w;
        if (used + w + ell_w > max_w) break;
        @memcpy(buf[i .. i + cl], cp);
        used += w;
        i += cl;
    }
    if (i == 0 or i + ell.len > buf.len) return "";
    @memcpy(buf[i .. i + ell.len], ell);
    return buf[0 .. i + ell.len];
}

/// Gap (px) added to each slot's measured text width — matches the `margin.w`
/// on each slot textLayout below, so the budget math equals the paint exactly.
const STATUS_SLOT_GAP: f32 = 10;
/// Extra pad subtracted from the pack budget so the reservation never races
/// live-layout rounding (a couple px either way must not push a primary control).
const STATUS_PACK_BUDGET_SAFETY: f32 = 4;

/// Width (px) available to the status-slot pack this frame. The pack lives on
/// line 2 of the two-line bottom status bar (plan #555 → #554, header merged by
/// plan #570); the budget is the bar's content-rect width minus the rounding-
/// safety pad (`STATUS_PACK_BUDGET_SAFETY`). Line 1 holds identity controls
/// (lifecycle · build id · model · Next), so the pack shares the bar but each
/// line has its own fixed 32 px height — neither can displace the other. The pack
/// still DROPS slots per `STATUS_SLOT_DROP_ORDER` then pixel-ellipsizes the
/// survivor to fit, exactly as before (see the narrow-canvas ellipsize decision:
/// even here the operator still sees *which* sandbox is bound, PR #543 re-run L9).
fn statusPackMaxWidth() f32 {
    const content_w = dvui.parentGet().data().contentRect().w;
    return @max(0, content_w - STATUS_PACK_BUDGET_SAFETY);
}

/// Paint the right-aligned status-slot pack into line 2 of the two-line bottom
/// status bar (protocol v13, plan #538/#541/#554, header merged by plan #570).
/// Line 2 is a fixed 32 px horizontal row sharing the 64 px bar with the identity
/// row (line 1: lifecycle · build id · model · Next); each line has its own
/// explicit height so neither can displace the other. A narrow canvas DROPS slots
/// per `STATUS_SLOT_DROP_ORDER` then pixel-ellipsizes the kept slot to fit.
/// Sandbox + cwd render as muted TEAL one-liners (WARM when busy); an empty slot
/// is hidden (never a blank placeholder / broken layout). When there are NO
/// non-empty slots at all, the caller still mounts the fixed `STATUS_BAR_H` band
/// as a subtle empty strip (locked decision, plan #555) — it never collapses and
/// `chrome_y`/`scroll_h` stay constant, so the transcript+composer stack never
/// jumps. Slot values are already capped at `MAX_STATUS_SLOT_LEN` by the bridge;
/// this defends the paint against a stale/oversize value with a UTF-8-safe ellipsis.
fn paintStatusSlots(life: bridge.Lifecycle) void {
    const busy = life == .busy;
    const budget = statusPackMaxWidth();
    if (budget <= 0) return;

    // Collect non-empty slots in drop-priority order (first = least important,
    // i.e. git → context → cwd → sandbox), with their truncated text + width.
    const body = (dvui.Options{}).fontGet();
    var slot: [bridge.MAX_STATUS_SLOTS]u32 = undefined;
    var buf: [bridge.MAX_STATUS_SLOTS][bridge.MAX_STATUS_SLOT_LEN]u8 = undefined;
    var text: [bridge.MAX_STATUS_SLOTS][]const u8 = undefined;
    var width: [bridge.MAX_STATUS_SLOTS]f32 = undefined;
    var n: usize = 0;
    for (bridge.STATUS_SLOT_DROP_ORDER) |s| {
        const raw = bridge.statusSlotValue(s);
        if (raw.len == 0) continue;
        // Cwd "." is the workspace-root default — hide the trivial chip (plan #579).
        if (s == bridge.STATUS_SLOT_CWD and !cwd_slot.isVisible(raw)) continue;
        slot[n] = s;
        text[n] = truncateStatusValue(&buf[n], raw);
        width[n] = body.textSize(text[n]).w + STATUS_SLOT_GAP;
        n += 1;
    }
    if (n == 0) return;

    // Drop lowest-importance slots (front of the drop order) until the pack fits
    // the primary-reserved budget. Retained = [keep_from..n).
    var total: f32 = 0;
    for (width[0..n]) |w| total += w;
    var keep_from: usize = 0;
    while (keep_from < n and total > budget) : (keep_from += 1) {
        total -= width[keep_from];
    }
    if (keep_from >= n) {
        // Even the most important slot (sandbox — last in the drop order) can't
        // fit at full width on a very narrow canvas. Never paint nothing (PR
        // #543 re-run L9): pixel-ellipsize that identity slot down to the leftover
        // budget so the operator still sees *which* sandbox is bound (e.g.
        // `sandbox 446655…`). This is the plan's "slots truncate" half that a
        // pure drop-to-empty would forfeit at exactly the viewport the plan locked.
        keep_from = n - 1;
        const max_text_w = budget - STATUS_SLOT_GAP;
        if (max_text_w <= 0) return; // no room even for the slot's gap — paint nothing
        text[keep_from] = truncateToWidthPx(body, buf[keep_from][0..], text[keep_from], max_text_w);
        if (text[keep_from].len == 0) return; // no room at all — no empty gutter (Nit L1)
    }

    const slot_color: dvui.Color = if (busy) palette.warm_accent else palette.teal_muted;
    // Right-aligned pack: gravity_x pulls the whole group to the trailing edge.
    var pack = dvui.box(@src(), .{ .dir = .horizontal }, .{
        .gravity_x = 1.0,
        .gravity_y = 0.5,
        .id_extra = 0x61_0001,
    });
    defer pack.deinit();

    var i = keep_from;
    while (i < n) : (i += 1) {
        var tl = dvui.textLayout(@src(), .{}, .{
            .background = false,
            .id_extra = 0x61_0002 + @as(usize, slot[i]),
            .color_text = slot_color,
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 10, .h = 0 },
        });
        tl.addText(text[i], .{});
        tl.deinit();
    }
}

fn clearPrompt() void {
    @memset(&prompt_buf, 0);
}

fn submitText(text: []const u8) void {
    // Normalize CRLF/lone-CR -> LF and clamp to SUBMIT_CAP at a codepoint
    // boundary (composer_text.zig). Blank/whitespace after normalization is
    // rejected, preserving the existing empty-send guard. In-place into
    // prompt_buf is safe: normalized length never exceeds the input consumed.
    const norm = composer_text.normalizeInto(text, prompt_buf[0..], bridge.SUBMIT_CAP);
    if (norm.is_blank) {
        clearPrompt();
        return;
    }
    bridge.queueSubmitFromUi(norm.text);
    clearPrompt();
}

pub fn frame() !void {
    const life = bridge.getLifecycle();
    const busy = life == .busy;

    // Full-bleed root. Children that use Options.rect do not report min-size up
    // the tree (WidgetData.minSizeReportToParent) — required so tall transcript
    // content cannot push the composer off-canvas.
    var root = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_text,
        .color_border = palette.teal_border,
        .padding = .all(8),
    });
    defer root.deinit();

    // Viewport in parent content coords (IMGUI: recompute every frame).
    var avail = root.data().contentRect().justSize();
    if (avail.h < 1 or avail.w < 1) {
        const wr = dvui.windowRect();
        avail = .{ .x = 0, .y = 0, .w = @max(1, wr.w - 16), .h = @max(1, wr.h - 16) };
    }

    // Status bar is absolute-rect at the very bottom (always-mounted, fixed 64 px).
    // Transcript + composer use absolute rects — neither participates in root flex,
    // so the scrollArea's `.auto` bar cannot publish virtual content height as the
    // root's min-size (dvui ScrollContainerWidget.deinit overwrites min_size.h with
    // full virtual content — adversarial review #584 Blocker L1).
    // Composer height is dynamic: previous-frame measured via composer_last_h,
    // clamped to [IDLE, MAX], so the band hugs the field at idle (~44 px) and
    // grows up as lines wrap (adversarial review #584 Round 2 Major L1+L9).
    const composer_h = @max(COMPOSER_IDLE_CHROME_H, @min(composer_last_h, COMPOSER_MAX_CHROME_H));
    const status_y = avail.h - STATUS_BAR_H;
    const composer_y = status_y - composer_h;
    const scroll_y: f32 = BAND_GAP;
    const scroll_h: f32 = @max(SCROLL_FLOOR_H, composer_y - BAND_GAP - scroll_y);

    // ── Transcript (absolute rect — height from dynamic composer band) ────
    // (Header band removed — plan #570 merges its content into the two-line status bar)
    const near_before = isNearBottom(&transcript_scroll);
    const prev_msg = last_msg_count;
    const prev_shown = last_shown_count;
    const n = bridge.messageCount();
    const shown = n + @as(usize, if (busy) 1 else 0);

    // #424 — track lifecycle transitions so committed (completed-turn) thinking
    // collapses at turn end (busy -> ready/err) and the active Busy turn stays
    // fully expanded. Lifecycle enum values mirror bridge.Lifecycle 1:1. The busy
    // start is captured as the *physical ring head* (the slot the turn begins
    // appending at), not a message count, so membership survives saturation/wrap.
    {
        const cur_lc: thinking_collapse.Lifecycle = @enumFromInt(@intFromEnum(life));
        thinking_collapse_state.onLifecycleTransition(prev_lifecycle, cur_lc, bridge.messageHead());
        prev_lifecycle = cur_lc;
    }
    var user_scroll: dvui.Point = .{};
    {
        var scroll = dvui.scrollArea(@src(), .{
            .scroll_info = &transcript_scroll,
            .vertical_bar = .auto,
            .user_scroll = &user_scroll,
        }, .{
            .rect = .{ .x = 0, .y = scroll_y, .w = 0, .h = scroll_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = scroll_h - 16 },
            .max_size_content = .height(scroll_h - 16),
            .padding = .all(8),
        });
        defer scroll.deinit();

        var body = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
        });
        defer body.deinit();

        // Protocol v6: host sets can_load_earlier when SessionStore has older turns.
        if (bridge.canLoadEarlier()) {
            if (dvui.button(@src(), "Load earlier", .{}, .{
                .expand = .horizontal,
                .style = .content,
                .min_size_content = .{ .w = 120, .h = TOUCH_H - 4 },
                .corners = .round(6),
                .color_fill = palette.teal_bg,
                .color_text = palette.teal_accent,
                .color_border = palette.teal_border,
                .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
                .id_extra = 0xffff_fffd,
            })) {
                if (!busy) bridge.queueLoadEarlierFromUi();
            }
        }

        if (n == 0) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.teal_muted,
            });
            if (bridge.modelCatalogCount() == 0) {
                tl.addText(
                    "No models available\n\nAsk a tenant admin to grant you an inference key,\nor wait for the host catalog to load.\n",
                    .{},
                );
            } else {
                tl.addText(
                    "Start a conversation\n\nType below, then Ctrl+Enter or Send.\nUse Next in the status bar to cycle models.\n",
                    .{},
                );
            }
            tl.deinit();
        } else {
            // Paint entire in-ring transcript (ring capacity 2048 — bridge.zig
            // MAX_MSG, which is private). No paint-cap / earlier hint. Empty/
            // blank assistant rows are omitted at paint (issue #324) — rule
            // lives in composer_text.zig.
            var i: usize = 0;
            while (i < n) : (i += 1) {
                if (bridge.messageAt(i)) |m| {
                    // Skip empty/blank assistant bands at paint (issue #324).
                    // The host opens a transient zero-visible-text assistant slot
                    // during multi-tool turns that would otherwise render as a
                    // full blank card ("stuck" look). Ring data is untouched —
                    // skip at paint only, so Copy/update_last/id_extra still key
                    // off ring index `i`. System/error rows and tool traces stay
                    // visible, and the busy row ("Waiting for model…") still shows.
                    if (composer_text.shouldOmitMessageAtPaint(m.kind, m.text)) {
                        continue;
                    }
                    const is_err = m.kind == 4;
                    var row = dvui.box(@src(), .{ .dir = .vertical }, .{
                        .expand = .horizontal,
                        .id_extra = i,
                        .background = kindFill(m.kind) != null,
                        .color_fill = kindFill(m.kind),
                        .color_border = if (is_err) palette.ember_border else palette.teal_border,
                        .padding = .{ .x = 8, .y = 6, .w = 8, .h = 6 },
                        .margin = .{ .x = 0, .y = 0, .w = 0, .h = 4 },
                        .style = if (is_err) .err else .content,
                    });
                    defer row.deinit();

                    // Kind label + Copy (message source → system clipboard).
                    // Tool-run (kind 6) rows are headerless (parent E): no `tools`
                    // band — the copy affordance lives on the L0 header row inside
                    // paintToolRun. Thinking (kind 5) rows are also headerless
                    // (#424): the `Thinking` expander + Copy + preview live in
                    // paintThinking, and the active/live turn keeps full GFM below.
                    // id_extra: label i*2; Copy i*%1024+2 (plain +1).
                    if (m.kind != rich.KIND_TOOL and m.kind != rich.KIND_THINKING and m.kind != rich.KIND_SKILL) {
                        var kind_row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                            .expand = .horizontal,
                            .id_extra = i,
                        });
                        defer kind_row.deinit();

                        {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i * 2,
                                .color_text = kindTextColor(m.kind),
                                .font = .theme(.heading),
                                .gravity_y = 0.5,
                            });
                            tl.format("{s}", .{kindLabel(m.kind)}, .{});
                            tl.deinit();
                        }
                        if (m.text.len > 0) {
                            if (dvui.button(@src(), "📋", .{}, .{
                                .gravity_y = 0.5,
                                .style = .content,
                                .id_extra = i *% 1024 + 2,
                                .min_size_content = .{ .w = 22, .h = 22 },
                                .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
                                .font = chromeCopyFont(),
                                .corners = .round(5),
                                .color_fill = palette.teal_bg,
                                .color_text = palette.teal_accent,
                                .color_border = palette.teal_border,
                                .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                            })) {
                                // Same-frame write only — do not retain ring slices.
                                dvui.clipboardTextSet(m.text);
                            }
                        }
                    }
                    {
                        // #424: thinking (kind 5) rows route through paintThinking,
                        // which renders the compact expandable control or, for the
                        // active busy turn / operator-open rows, the full GFM body.
                        if (m.kind == rich.KIND_THINKING) {
                            paintThinking(@src(), i, m.text, bridge.messageSlotAt(i), bridge.messageRevisionAt(i));
                        } else if (rich.shouldPaintMarkdown(m.kind)) {
                            // #424: for non-thinking markdown kinds, defer to the
                            // generic slot-keyed painter below (unchanged).
                            rich.paintMessageBody(@src(), m.kind, m.text, .{
                                .msg_index = i,
                                .slot = bridge.messageSlotAt(i),
                                .revision = bridge.messageRevisionAt(i),
                            });
                        } else if (m.kind == rich.KIND_SKILL) {
                            // Protocol v12 (kind 7): display-only `Skill attached:
                            // <slug>` row. Headerless, compact, muted TEAL — shows
                            // only the skill NAME, never a skill body (bodies stay
                            // server-side in the model's system context).
                            paintSkillAttached(@src(), i, m.text);
                        } else if (m.kind == rich.KIND_TOOL) {
                            if (!paintToolRun(@src(), i, m.text, bridge.messageSlotAt(i), bridge.messageRevisionAt(i))) {
                                // Fail-open (plan #345): unknown/old tool-run
                                // payload decodes to nothing → render raw text.
                                var tl = dvui.textLayout(@src(), .{}, .{
                                    .expand = .horizontal,
                                    .id_extra = i *% 1024 + 1,
                                    .color_text = palette.teal_text,
                                    .font = .theme(.body),
                                });
                                mixed_text.addTextMixed(tl, m.text, .theme(.body), .{
                                    .color_text = palette.teal_text,
                                });
                                tl.deinit();
                                // Keep the Copy affordance on a fail-open tool row
                                // too — headerless chrome moved Copy off the kind
                                // band, which is skipped for tool-run kinds.
                                if (dvui.button(@src(), "📋", .{}, .{
                                    .gravity_y = 0.5,
                                    .style = .content,
                                    .id_extra = i *% 1024 + 2,
                                    .min_size_content = .{ .w = 22, .h = 22 },
                                    .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
                                    .font = chromeCopyFont(),
                                    .corners = .round(5),
                                    .color_fill = palette.teal_bg,
                                    .color_text = palette.teal_accent,
                                    .color_border = palette.teal_border,
                                    .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                                })) {
                                    dvui.clipboardTextSet(toolRunClipboard(m.text));
                                }
                            }
                        } else {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i *% 1024 + 1,
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                                .font = .theme(.body),
                            });
                            mixed_text.addTextMixed(tl, m.text, .theme(.body), .{
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                            });
                            tl.deinit();
                        }
                    }
                }
            }
        }

        if (busy) {
            // Busy row (plan #574): the 2×4 WARM spinner sits LEFT of
            // "Waiting for model…" on the same line. Painted by the standalone
            // `busy_row` module (extracted so the host dvui testing-backend test
            // `busy_row_layout.test.zig` runs the exact same paint — PR #576
            // Blocker L6). The spinner's phase scalar comes from the host 10 Hz
            // tick (`inv_set_busy_tick`); the v14 ` · mm:ss` clock from
            // `bridge.turnElapsed()` — both passed in, no wasm/global dependency.
            busy_row.paintBusyRow(bridge.busyTick(), bridge.turnElapsed());
        }
    }

    // Conditional stick-to-bottom (plan #135 / #131 / #251).
    // Count changes cover pushMessage; content_grew covers inv_update_last_message
    // stream growth (thinking/assistant) where msg_count is unchanged.
    const max_y = transcript_scroll.scrollMax(.vertical);
    const content_grew = max_y > last_scroll_max_y + CONTENT_GREW_EPS;
    const count_changed = shown != prev_shown;

    if (n < prev_msg) {
        // Ring cleared only (count->0). No partial-truncate path: bridge's
        // msg_count drops solely via inv_clear_messages — update_last never
        // decreases it — so (n == 0) below is exactly the clear case. Drop the
        // parse cache (generation bump) and reset tool-run expand state so a
        // fresh window starts collapsed.
        if (n == 0) rich.clearCache();
        clearToolRunOpenState();
        clearThinkingOpenState();
        thinking_collapse_state.reset();
        transcript_scroll.velocity = .{ .x = 0, .y = 0 };
        scrollToBottom(&transcript_scroll);
    } else if (count_changed or content_grew) {
        const newest_is_user = blk: {
            if (n == 0) break :blk false;
            if (bridge.messageAt(n - 1)) |m| break :blk m.kind == @intFromEnum(bridge.MessageKind.user);
            break :blk false;
        };
        const user_sent = newest_is_user and shown > prev_shown;
        const hydrate = (prev_msg == 0 and n > 1) or (n >= prev_msg + 3);
        const should_follow = user_sent or hydrate or prev_msg == 0 or (near_before and user_scroll.y >= 0);
        if (should_follow) {
            scrollToBottom(&transcript_scroll);
        } else {
            clampScrollToContent(&transcript_scroll);
        }
    } else {
        clampScrollToContent(&transcript_scroll);
    }
    // Always refresh trackers (grow, shrink, no-op) so stream deltas stay accurate.
    last_shown_count = shown;
    last_msg_count = n;
    last_scroll_max_y = transcript_scroll.scrollMax(.vertical);

    // ── Composer chrome (absolute rect — hugs one line, grows up to cap) ───
    // Dynamic height: previous-frame measured via composer_last_h, clamped to
    // [COMPOSER_IDLE_CHROME_H, COMPOSER_MAX_CHROME_H]. At idle the band is ~44 px
    // (Send sits on the field baseline); multi-line paste grows the rect up to
    // 124 px over one frame settle (adversarial review #584 Round 2 Major L1+L9).
    var typed: []const u8 = prompt_buf[0..0];
    {
        var chrome = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .rect = .{ .x = 0, .y = composer_y, .w = 0, .h = composer_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_bg,
            .color_border = palette.teal_border,
            .padding = .{ .x = 0, .y = COMPOSER_HUG_PAD, .w = 0, .h = COMPOSER_HUG_PAD },
        });
        defer chrome.deinit();

        // Single-row composer (plan #457): the multi-line field and ONE trailing
        // icon button pack horizontally, so a tall paste grows the field up to
        // COMPOSER_INPUT_MAX_H and then scrolls inside it — there is no second
        // action row to crush (#344), and no hint copy below the field. Plain
        // Enter inserts a newline; the send chord is Ctrl+Enter (Cmd+Enter on
        // mac). dvui's web backend reports modifier bits on keydown, and a
        // multiline `textEntry` ignores modifiers on Enter (it consumes Enter
        // and inserts '\n'), so we detect the chord here in the pending event
        // list and mark it handled — which also stops the widget from inserting
        // a stray newline for the submit keystroke.
        var composer_submit = false;
        if (!busy) {
            const es = dvui.events();
            for (0..es.len) |idx| {
                const e = &es[idx];
                if (e.handled) continue;
                const ke = switch (e.evt) {
                    .key => |k| k,
                    else => continue,
                };
                if (ke.code == .enter and (ke.mod.control() or ke.mod.command())) {
                    // A multiline textEntry consumes Enter and inserts '\n',
                    // ignoring the modifier (verified against pinned dvui), so
                    // mark EVERY enter-chord event (.down and .repeat) handled
                    // to stop it injecting a stray newline for the submit
                    // stroke. Submit once per gesture, on the initial .down.
                    e.handled = true;
                    if (ke.action == .down) composer_submit = true;
                }
            }
        }
        {
            var te = dvui.textEntry(@src(), .{
                .text = .{ .buffer = prompt_buf[0..] },
                .placeholder = "Message the model…",
                .multiline = true,
                .break_lines = true,
            }, .{
                .expand = .horizontal,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 120, .h = TOUCH_H },
                .max_size_content = .{ .w = 0, .h = COMPOSER_INPUT_MAX_H },
                .color_fill = palette.teal_surface,
                .color_text = palette.teal_text,
                .color_border = if (busy) palette.teal_border else palette.teal_accent,
                .margin = .{ .x = 0, .y = 0, .w = 8, .h = 0 },
                // Explicit padding + border so TE_OVERHEAD (14) is
                // deterministic — dvui defaults would otherwise make the
                // outer→content conversion fragile (Round 3 Minor L8).
                .padding = .{ .x = 6, .y = 6, .w = 6, .h = 6 },
                .border = .{ .x = 1, .y = 1, .w = 1, .h = 1 },
            });
            typed = te.getText();
            if (want_composer_focus) {
                dvui.focusWidget(te.data().id, null, null);
                want_composer_focus = false;
            }
            // Capture the textEntry's natural wrapped height for next frame's
            // dynamic hug. `te.data().min_size` is the OPTIONS seed (re-seeded
            // each frame from min_size_content), NOT the computed wrapped
            // height. The textEntry's draw() computes the real wrap height but
            // that value only reaches dvui.minSizeGet(id) AFTER te.deinit()
            // (its children report back during deinit). We sample the OUTER
            // height (content + TE padding + TE border), convert to content,
            // then pad for the chrome box. Clamped to [IDLE, MAX] so the band
            // hugs the field and never collapses (adversarial review #584
            // Round 4 Blocker L1 + Major L1: `dvui.minSizeGet` returns `?Size`,
            // and `TextEntryWidget.deinit` ends in `defer self.* = undefined`,
            // so the lookup Id must be captured BEFORE deinit — reading
            // `te.data().id` after would be use-after-undefined. If the queried
            // id has no stored size this frame, fall back to the previous
            // frame's measured height instead of collapsing (never a zero shot)).
            const te_id = te.data().id;
            te.deinit();
            const outer_h = if (dvui.minSizeGet(te_id)) |ms| ms.h else composer_last_h;
            const raw_content = @max(0.0, outer_h - TE_OVERHEAD);
            const content_h = @max(TOUCH_H, @min(raw_content, COMPOSER_INPUT_MAX_H));
            composer_last_h = @max(COMPOSER_IDLE_CHROME_H, @min(content_h + 2 * COMPOSER_HUG_PAD, COMPOSER_MAX_CHROME_H));
            if (composer_submit and typed.len > 0) {
                submitText(typed);
                typed = prompt_buf[0..0];
                want_composer_focus = true;
            }
        }

        // Single square icon-only action button, same row as the field (no
        // labelled Stop/Send pill; the hints `busy… Stop to cancel` /
        // `Ctrl/Cmd+Enter to send` are gone — that state lives on the host
        // top-bar Busy chip). Idle ▶ = Send (submit when non-empty); Busy ■ =
        // Stop/cancel (protocol v9 pending cancel → host abort). Glyphs come
        // from the embedded DejaVu Sans Symbols face so they never tofu.
        if (busy) {
            if (dvui.button(@src(), "■", .{}, .{
                .gravity_y = 1.0,
                .style = .content,
                .font = composerIconFont(),
                .min_size_content = .{ .w = TOUCH_H, .h = TOUCH_H },
                .corners = .round(8),
                .color_fill = palette.warm_bg,
                .color_text = palette.warm_accent,
                .color_border = palette.ember_border,
            })) {
                bridge.queueCancelFromUi();
            }
        } else if (dvui.button(@src(), "▶", .{}, .{
            .gravity_y = 1.0,
            .style = .highlight,
            .font = composerIconFont(),
            .min_size_content = .{ .w = TOUCH_H, .h = TOUCH_H },
            .corners = .round(8),
        })) {
            if (typed.len > 0) {
                submitText(typed);
                want_composer_focus = true;
            }
        }
    }

    // ── Status bar (absolute bottom band — BELOW the composer, always mounted) ──
    // Two-line layout (plan #570): vertical container with identity on line 1
    // and status slots on line 2. Always mounted at fixed STATUS_BAR_H so the
    // transcript+composer stack never jumps when a sandbox attaches.
    {
        var bar = dvui.box(@src(), .{ .dir = .vertical }, .{
            .rect = .{ .x = 0, .y = status_y, .w = 0, .h = STATUS_BAR_H },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .{ .x = 10, .y = 0, .w = 10, .h = 0 },
            .min_size_content = .{ .w = 120, .h = STATUS_BAR_H },
            .id_extra = 0x61_0300,
        });
        defer bar.deinit();

        // Line 1: identity (lifecycle · build id · model label · Next)
        // Each line gets exactly STATUS_BAR_H/2 = 32 px so the Next button
        // (TOUCH_H − 8 = 32) fills its row without clipping line 2 (plan #570
        // fallback, adversarial review #573 Major L9).
        {
            var line1 = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 120, .h = STATUS_BAR_H / 2 },
                .id_extra = 0x61_0100,
            });
            defer line1.deinit();

            {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .background = false,
                    .color_text = if (busy) palette.warm_accent else palette.teal_muted,
                    .gravity_y = 0.5,
                });
                tl.format("{s}", .{lifecycleLabel(life)}, .{});
                tl.deinit();
            }
            {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .background = false,
                    .color_text = palette.teal_muted,
                    .gravity_y = 0.5,
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                });
                tl.format("h:{s}", .{BUILD_ID}, .{});
                tl.deinit();
            }
            {
                const cat_n = bridge.modelCatalogCount();
                {
                    var tl = dvui.textLayout(@src(), .{}, .{
                        .background = false,
                        .color_text = if (cat_n == 0) palette.teal_muted else palette.teal_accent,
                        .gravity_y = 0.5,
                        .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                    });
                    if (cat_n == 0) {
                        tl.addText("no model", .{});
                    } else {
                        tl.format("{s}", .{bridge.selectedModelLabel()}, .{});
                    }
                    tl.deinit();
                }
                if (cat_n > 1) {
                    if (dvui.button(@src(), "Next", .{}, .{
                        .gravity_y = 0.5,
                        .style = .content,
                        .min_size_content = .{ .w = 52, .h = TOUCH_H - 8 },
                        .corners = .round(6),
                        .color_fill = palette.teal_surface,
                        .color_text = palette.teal_accent,
                        .color_border = palette.teal_accent,
                        .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                    })) {
                        if (!busy) {
                            bridge.cycleSelectedModel();
                        }
                    }
                }
            }
        }

        // Line 2: status slots (protocol v13 store + drop order untouched).
        // Each line gets exactly STATUS_BAR_H/2 = 32 px so the two rows never
        // compete for space (plan #570 fallback, adversarial review #573 Major L9).
        {
            var line2 = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 120, .h = STATUS_BAR_H / 2 },
                .id_extra = 0x61_0200,
            });
            defer line2.deinit();
            paintStatusSlots(life);
        }
    }
}
