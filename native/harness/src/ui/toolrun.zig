//! Aggregated tool-run control (protocol v10 / kind 6).
//! Level 0: header + count chips. Level 1: one-liners. Level 2: inline detail.
//! Import convention: decode is `../rich/toolrun.zig` (aliased `rich_toolrun`),
//! NOT `toolrun.zig` (which would be this file itself).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const rich = @import("../rich/root.zig");
const rich_toolrun = @import("../rich/toolrun.zig");
const mixed_text = @import("../rich/mixed_text.zig");
const state = @import("state.zig");
const chrome = @import("chrome.zig");
const metrics = @import("metrics.zig");

/// True for tool names whose level-2 detail is a command/output block (exec
/// stdout/stderr, filesystem results, http bodies). Those previews paint in the
/// embedded Vera Sans Mono face for readable alignment (phase 3 #353); other
/// tools fall back to the body face.
pub fn isCommandLikeRun(name: []const u8) bool {
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
pub fn detailUsesMono(name: []const u8, detail: []const u8) bool {
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
pub fn paintToolRun(
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
    var owned: ?rich_toolrun.Decoded = null;
    defer if (owned) |*d| d.deinit();
    const arena = dvui.currentWindow().arena();
    const run: ?*const rich_toolrun.ToolRun = if (slot) |s|
        rich.toolrunCacheSlot(s, revision, text)
    else blk: {
        const dec = rich_toolrun.decode(arena, text) orelse break :blk null;
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
    var l1_expanded = state.toolrun_open_l1.contains(l1_key);

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
            .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H - 4 },
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
        if (open) state.toolrun_open_l1.put(l1_key, {}) catch {} else _ = state.toolrun_open_l1.remove(l1_key);

        // Trailing pack (right): 📋 then ✓N / ✗N / …N — one gravity box so
        // padding/baseline match (operator: glyphs were tiny + clipboard pad fat
        // + row misaligned when chips and button were separate gravity_x children).
        {
            var trail = dvui.box(src, .{ .dir = .horizontal }, .{
                .gravity_x = 1.0,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 0, .h = metrics.TOUCH_H - 8 },
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
                .font = chrome.chromeCopyFont(),
                .corners = .round(5),
                .color_fill = palette.teal_bg,
                .color_text = palette.teal_accent,
                .color_border = palette.teal_border,
                .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
            })) {
                // Same-frame write only — do not retain ring slices.
                dvui.clipboardTextSet(chrome.toolRunClipboard(text));
            }

            // Status marks must not tofu: ✓/✗ come from DejaVu Sans Symbols,
            // `…` from the Noto heading face (see paintStatusChip).
            if (runv.ok > 0) chrome.paintStatusChip(src, id_base + 20, id_base + 21, id_base + 22, palette.teal_accent, "✓", runv.ok, palette.fontSymbols());
            if (runv.fail > 0) chrome.paintStatusChip(src, id_base + 23, id_base + 24, id_base + 25, palette.ember_accent, "✗", runv.fail, palette.fontSymbols());
            if (runv.pending > 0) chrome.paintStatusChip(src, id_base + 26, id_base + 27, id_base + 28, palette.warm_accent, "…", runv.pending, .theme(.heading));
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
            var l2_expanded = state.toolrun_open_l2.contains(l2_key);

            {
                var item_head = dvui.box(src, .{ .dir = .horizontal }, .{
                    .expand = .horizontal,
                    .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H - 6 },
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
                        .font = chrome.chromeMarkFont(glyph_font),
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
                    if (open) state.toolrun_open_l2.put(l2_key, {}) catch {} else _ = state.toolrun_open_l2.remove(l2_key);
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
                    mixed_text.addTextMixed(tl, item_label, .theme(.body), .{
                        .color_text = palette.teal_text,
                    });
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
