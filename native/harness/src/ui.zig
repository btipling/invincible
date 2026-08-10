//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! Polish (4.7): density, focus composer, touch targets, scroll stick-to-bottom.
//! #131 / plan #135: persistent transcript ScrollInfo + conditional stick rules.
//! #251: stick also on in-place stream growth (update_last / content height).
//! #137: IMGUI absolute-rect bands (header / transcript / composer) so content
//! min-size cannot push chrome off-canvas. Build id (`h:…`) detects stale wasm.
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");
const build_options = @import("build_options");
const rich = @import("rich/root.zig");
const mixed_text = @import("rich/mixed_text.zig");
const composer_text = @import("composer_text.zig");
const toolrun = @import("rich/toolrun.zig");

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

fn clearToolRunOpenState() void {
    toolrun_open_l1.clearRetainingCapacity();
    toolrun_open_l2.clearRetainingCapacity();
}

const SMOKE_PROMPT = "Reply with exactly: PONG";
/// Touch-friendly control height (CSS px ≈).
const TOUCH_H: f32 = 40;
/// Near-bottom epsilon for stick-to-bottom follow (plan #135).
const NEAR_BOTTOM_PX: f32 = 48;
/// Ignore subpixel layout noise when detecting in-place stream growth (#251).
const CONTENT_GREW_EPS: f32 = 1.0;
/// Reserved bottom chrome: textEntry + action row + margins (plan #138).
/// Height budget: header + this win over transcript min on short canvases.
const COMPOSER_CHROME_MIN: f32 = 2 * TOUCH_H + 20;
/// Chrome box top padding (Options.padding.y) — outside min_size_content.
const COMPOSER_PAD_Y: f32 = 4;
/// Multi-line composer visible-height cap (px). Stays inside the reserved
/// bottom band so the absolute-rect transcript height is unchanged; taller
/// pasted content scrolls internally (plan #334 / #323).
const COMPOSER_INPUT_MAX_H: f32 = 52;
/// Vertical margins between header→scroll and scroll→chrome (Options.margin.h).
const BAND_GAP: f32 = 6;
/// Absolute floor so a short canvas still has a scroll band.
const SCROLL_FLOOR_H: f32 = 32;

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
    want_composer_focus = true;
    resetTranscriptScroll();
    rich.clearCache();
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

/// Paint an aggregated tool-run control (protocol v10 / kind 6).
///
/// Level 0 (default-collapsed): header `N tools called` + colored count chips
/// (TEAL✓ success / EMBER✗ fail-only / WARM… pending) as a touch-height hit
/// target. Level 1: one one-liner per tool (colored status glyph). Level 2:
/// that tool's inline detail. Returns true when the payload decoded and painted;
/// false means fail-open → caller renders the raw body as plain text.
fn paintToolRun(src: std.builtin.SourceLocation, msg_index: usize, text: []const u8) bool {
    var decoded = toolrun.decode(dvui.currentWindow().arena(), text) orelse return false;
    defer decoded.deinit();
    const run = decoded.run;
    // Decoders recount ok/fail/pending from the kept (capped) items, so the
    // header count can never disagree with what actually paints (review).
    const total = run.ok + run.fail + run.pending;

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
        var head = dvui.box(src, .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 120, .h = TOUCH_H - 4 },
            .id_extra = id_base + 1,
        });
        defer head.deinit();

        const open = dvui.expander(src, label, .{ .expanded = &l1_expanded }, .{
            .expand = .horizontal,
            .min_size_content = .{ .h = TOUCH_H - 4 },
            .gravity_y = 0.5,
            .id_extra = id_base + 2,
        });
        if (open) toolrun_open_l1.put(l1_key, {}) catch {} else _ = toolrun_open_l1.remove(l1_key);

        if (run.ok > 0 or run.fail > 0 or run.pending > 0) {
            var chips = dvui.box(src, .{ .dir = .horizontal }, .{
                .gravity_x = 1.0,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 0, .h = TOUCH_H - 8 },
                .id_extra = id_base + 3,
            });
            defer chips.deinit();
            if (run.ok > 0) {
                var tl = dvui.textLayout(src, .{}, .{
                    .id_extra = id_base + 4,
                    .color_text = palette.teal_accent,
                    .gravity_y = 0.5,
                    .font = .theme(.heading),
                    .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
                });
                tl.format("{s} {d}", .{ "✓", run.ok }, .{});
                tl.deinit();
            }
            if (run.fail > 0) {
                var tl = dvui.textLayout(src, .{}, .{
                    .id_extra = id_base + 5,
                    .color_text = palette.ember_accent,
                    .gravity_y = 0.5,
                    .font = .theme(.heading),
                    .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
                });
                tl.format("{s} {d}", .{ "✗", run.fail }, .{});
                tl.deinit();
            }
            if (run.pending > 0) {
                var tl = dvui.textLayout(src, .{}, .{
                    .id_extra = id_base + 6,
                    .color_text = palette.warm_accent,
                    .gravity_y = 0.5,
                    .font = .theme(.heading),
                    .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
                });
                tl.format("{s} {d}", .{ "…", run.pending }, .{});
                tl.deinit();
            }
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

        for (run.items) |it| {
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
                {
                    var tl = dvui.textLayout(src, .{}, .{
                        .id_extra = item_base + 1,
                        .color_text = glyph_color,
                        .gravity_y = 0.5,
                        .font = .theme(.heading),
                        .margin = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
                    });
                    tl.addText(switch (it.status) {
                        .ok => "✓",
                        .fail => "✗",
                        .running => "…",
                    }, .{});
                    tl.deinit();
                }

                const item_label: []const u8 = if (it.brief.len > 0) it.brief else it.name;
                if (has_detail) {
                    const open = dvui.expander(src, item_label, .{ .expanded = &l2_expanded }, .{
                        .id_extra = item_base + 2,
                        .expand = .horizontal,
                        .gravity_y = 0.5,
                        .min_size_content = .{ .h = TOUCH_H - 6 },
                    });
                    if (open) toolrun_open_l2.put(l2_key, {}) catch {} else _ = toolrun_open_l2.remove(l2_key);
                } else {
                    // No level-2 detail (e.g. a short/empty summary) — mount a
                    // static label, not a blank expander (review nit). The name+
                    // status one-liner is still useful at level 1.
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
                    .margin = .{ .x = 22, .y = 0, .w = 0, .h = 0 },
                });
                defer detail.deinit();
                var tl = dvui.textLayout(src, .{}, .{
                    .id_extra = item_base + 4,
                    .expand = .horizontal,
                    .color_text = palette.teal_text,
                });
                mixed_text.addTextMixed(tl, it.detail, .theme(.body), .{
                    .color_text = palette.teal_text,
                });
                tl.deinit();
            }
        }
    }
    return true;
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

    // Fixed chrome height (content + pad). Header uses a measured estimate then
    // absolute placement so bands never depend on expand packing order.
    const chrome_h: f32 = COMPOSER_CHROME_MIN + COMPOSER_PAD_Y;
    // Header band: title row ~ TOUCH_H + padding/margin.
    const header_h: f32 = TOUCH_H + 24;
    const scroll_y = header_h + BAND_GAP;
    const scroll_h = @max(SCROLL_FLOOR_H, avail.h - scroll_y - chrome_h - BAND_GAP);
    const chrome_y = avail.h - chrome_h;

    // ── Header (absolute top band) ────────────────────────────────────────
    {
        var head = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .rect = .{ .x = 0, .y = 0, .w = 0, .h = header_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .{ .x = 10, .y = 6, .w = 10, .h = 6 },
            .min_size_content = .{ .w = 0, .h = TOUCH_H - 8 },
        });
        defer head.deinit();

        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .font = .theme(.heading),
                .color_text = palette.teal_text,
                .gravity_y = 0.5,
            });
            tl.addText("Agent harness", .{});
            tl.deinit();
        }
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .color_text = if (busy) palette.warm_accent else palette.teal_muted,
                .gravity_y = 0.5,
            });
            tl.format("{s}", .{lifecycleLabel(life)}, .{});
            tl.deinit();
        }
        // Build id — proves which wasm is running (stale-cache detector).
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .color_text = palette.teal_muted,
                .gravity_y = 0.5,
                .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
            });
            tl.format("h:{s}", .{BUILD_ID}, .{});
            tl.deinit();
        }
        // Protocol v3: cycle through granted models (host pushed catalog).
        {
            const cat_n = bridge.modelCatalogCount();
            {
                var tl = dvui.textLayout(@src(), .{}, .{
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
                    .color_fill = palette.teal_bg,
                    .color_text = palette.teal_accent,
                    .color_border = palette.teal_border,
                    .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                })) {
                    if (!busy) {
                        bridge.cycleSelectedModel();
                    }
                }
            }
        }
    }

    // ── Transcript (absolute middle band — fixed pixel height) ────────────
    const near_before = isNearBottom(&transcript_scroll);
    const prev_msg = last_msg_count;
    const prev_shown = last_shown_count;
    const n = bridge.messageCount();
    const shown = n + @as(usize, if (busy) 1 else 0);
    var user_scroll: dvui.Point = .{};
    {
        // Content height = band minus vertical padding (all 8 → 16).
        const scroll_pad_v: f32 = 16;
        const scroll_content_h = @max(SCROLL_FLOOR_H, scroll_h - scroll_pad_v);
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
            .min_size_content = .{ .w = 120, .h = scroll_content_h },
            .max_size_content = .height(scroll_content_h),
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
                    "Start a conversation\n\nType below, then Ctrl+Enter or Send.\nUse Next in the header to cycle models.\n",
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
                    // id_extra: label i*2; Copy i*%1024+2 (plain body uses +1).
                    {
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
                            if (dvui.button(@src(), "Copy", .{}, .{
                                .gravity_y = 0.5,
                                .style = .content,
                                .id_extra = i *% 1024 + 2,
                                .min_size_content = .{ .w = 56, .h = TOUCH_H - 8 },
                                .corners = .round(6),
                                .color_fill = palette.teal_bg,
                                .color_text = palette.teal_accent,
                                .color_border = palette.teal_border,
                                .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                            })) {
                                // Same-frame write only — do not retain ring slices.
                                // Tool-run rows copy a human-readable per-tool
                                // summary, not the dense wire payload.
                                dvui.clipboardTextSet(
                                    if (m.kind == rich.KIND_TOOL) toolRunClipboard(m.text) else m.text,
                                );
                            }
                        }
                    }
                    {
                        if (rich.shouldPaintMarkdown(m.kind)) {
                            rich.paintMessageBody(@src(), m.kind, m.text, .{ .msg_index = i });
                        } else if (m.kind == rich.KIND_TOOL) {
                            if (!paintToolRun(@src(), i, m.text)) {
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
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.warm_accent,
                .id_extra = 0xffff_ffff,
            });
            tl.addText("Waiting for model…", .{});
            tl.deinit();
        }
    }

    // Conditional stick-to-bottom (plan #135 / #131 / #251).
    // Count changes cover pushMessage; content_grew covers inv_update_last_message
    // stream growth (thinking/assistant) where msg_count is unchanged.
    const max_y = transcript_scroll.scrollMax(.vertical);
    const content_grew = max_y > last_scroll_max_y + CONTENT_GREW_EPS;
    const count_changed = shown != prev_shown;

    if (n < prev_msg) {
        // Ring cleared or truncated — drop parse cache (generation bump) and
        // reset tool-run expand state so a fresh/old window starts collapsed.
        if (n == 0) rich.clearCache();
        clearToolRunOpenState();
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

    // ── Composer chrome (absolute bottom band — always on-canvas) ─────────
    var typed: []const u8 = prompt_buf[0..0];
    {
        var chrome = dvui.box(@src(), .{ .dir = .vertical }, .{
            .rect = .{ .x = 0, .y = chrome_y, .w = 0, .h = chrome_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_bg,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = COMPOSER_CHROME_MIN },
            .max_size_content = .height(COMPOSER_CHROME_MIN),
            .padding = .{ .x = 0, .y = COMPOSER_PAD_Y, .w = 0, .h = 0 },
        });
        defer chrome.deinit();

        // Multi-line composer. Plain Enter inserts a newline; the send chord is
        // Ctrl+Enter (Cmd+Enter on mac). dvui's web backend reports modifier
        // bits on keydown, and a multiline `textEntry` ignores modifiers on
        // Enter (it consumes Enter and inserts '\n'), so we detect the chord
        // here in the pending event list and mark it handled — which also stops
        // the widget from inserting a stray newline for the submit keystroke.
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
                .min_size_content = .{ .w = 120, .h = TOUCH_H },
                .max_size_content = .{ .w = 0, .h = COMPOSER_INPUT_MAX_H },
                .color_fill = palette.teal_surface,
                .color_text = palette.teal_text,
                .color_border = if (busy) palette.teal_border else palette.teal_accent,
                .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
            });
            typed = te.getText();
            if (want_composer_focus) {
                dvui.focusWidget(te.data().id, null, null);
                want_composer_focus = false;
            }
            te.deinit();
            if (composer_submit and typed.len > 0) {
                submitText(typed);
                typed = prompt_buf[0..0];
                want_composer_focus = true;
            }
        }

        {
            var row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .min_size_content = .{ .w = 0, .h = TOUCH_H + 4 },
            });
            defer row.deinit();

            if (busy) {
                // Stop cancels inflight turn (protocol v9 pending cancel → host abort).
                if (dvui.button(@src(), "Stop", .{}, .{
                    .gravity_y = 0.5,
                    .style = .content,
                    .min_size_content = .{ .w = 72, .h = TOUCH_H },
                    .corners = .round(8),
                    .color_fill = palette.warm_bg,
                    .color_text = palette.warm_accent,
                    .color_border = palette.ember_border,
                })) {
                    bridge.queueCancelFromUi();
                }
            } else if (dvui.button(@src(), "Send", .{}, .{
                .gravity_y = 0.5,
                .style = .highlight,
                .min_size_content = .{ .w = 72, .h = TOUCH_H },
                .corners = .round(8),
            })) {
                if (typed.len > 0) {
                    submitText(typed);
                    want_composer_focus = true;
                }
            }
            if (!busy) {
                if (dvui.button(@src(), "PONG", .{}, .{
                    .gravity_y = 0.5,
                    .style = .app1,
                    .min_size_content = .{ .w = 72, .h = TOUCH_H },
                    .corners = .round(8),
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                })) {
                    submitText(SMOKE_PROMPT);
                    want_composer_focus = true;
                }
            }
            {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .gravity_y = 0.5,
                    .color_text = palette.teal_muted,
                    .margin = .{ .x = 10, .y = 0, .w = 0, .h = 0 },
                });
                if (busy) {
                    tl.addText("busy… Stop to cancel", .{});
                } else {
                    tl.addText("Ctrl/Cmd+Enter to send", .{});
                }
                tl.deinit();
            }
        }
    }
}
