const std = @import("std");

/// Invincible agent harness — dvui web backend → wasm32-freestanding.
pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    const web_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    const dvui_dep = b.dependency("dvui", .{
        .target = web_target,
        .optimize = optimize,
        .backend = .web,
    });
    // plan #647: dedicated right-click branch in vendored TextLayoutWidget.
    // zig-pkg is extracted by b.dependency; compile steps created below see the
    // patched file. Idempotent (marker comment).
    applyInvincibleRightClickPatch(b, dvui_dep);

    // Phase 1 rich transcript (#143): zmd (MIT) markdown parser, freestanding.
    const zmd_dep = b.dependency("zmd", .{
        .target = web_target,
        .optimize = optimize,
    });

    const strip = switch (optimize) {
        .ReleaseFast, .ReleaseSmall => true,
        else => false,
    };

    // Baked build id (short git SHA) — shown in canvas chrome to detect stale wasm.
    const build_id = b.option([]const u8, "build-id", "Harness build id (git short SHA)") orelse "dev";
    const build_opts = b.addOptions();
    build_opts.addOption([]const u8, "build_id", build_id);

    // Primary artifact name: harness.wasm (issues #17 / #18).
    const exe = b.addExecutable(.{
        .name = "harness",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = web_target,
            .optimize = optimize,
            .link_libc = false,
            .strip = strip,
        }),
    });
    // Freestanding library-style Wasm (no _start); host calls exports.
    exe.entry = .disabled;
    exe.root_module.addImport("dvui", dvui_dep.module("dvui_web"));
    exe.root_module.addImport("web-backend", dvui_dep.module("web"));
    exe.root_module.addImport("zmd", zmd_dep.module("zmd"));
    exe.root_module.addOptions("build_options", build_opts);

    // Zig std.Build.Module.export_symbol_names:
    //   "Symbols to be exported when compiling to WebAssembly."
    // Each name becomes a linker `--export=` root (see Module.zig → zig_args).
    //
    // Why this is required (Zig 0.16 freestanding Wasm):
    // - `export fn` in source marks a symbol for export, but with
    //   `entry = .disabled` the linker has no `_start` root and will GC
    //   exports that nothing in the module calls.
    // - Alternative: `exe.rdynamic = true` (-rdynamic) keeps *all*
    //   export-marked symbols; export_symbol_names is the explicit list.
    // - dvui's web backend already lists dvui_* / gpa_* / add_event / …;
    //   inv_* must be listed here or JS never sees the bridge.
    // Docs/tutorial: export fn + rdynamic OR export_symbol_names.
    exe.root_module.export_symbol_names = &.{
        "inv_protocol_version",
        "inv_ping",
        "inv_set_lifecycle",
        "inv_get_lifecycle",
        "inv_message_count",
        "inv_message_kind_at",
        "inv_message_text_len_at",
        "inv_message_text_copy_at",
        "inv_begin_batch",
        "inv_end_batch",
        "inv_push_message",
        "inv_update_last_message",
        "inv_clear_messages",
        "inv_echo",
        "inv_echo_len",
        "inv_echo_copy",
        "inv_has_pending_submit",
        "inv_pending_submit_len",
        "inv_pending_submit_copy",
        "inv_ack_pending_submit",
        "inv_set_can_load_earlier",
        "inv_has_pending_load_earlier",
        "inv_ack_pending_load_earlier",
        "inv_has_pending_cancel",
        "inv_ack_pending_cancel",
        "inv_clear_model_catalog",
        "inv_push_model_catalog_entry",
        "inv_model_catalog_count",
        "inv_selected_model_len",
        "inv_selected_model_copy",
        "inv_cycle_selected_model",
        "inv_set_selected_model",
        "inv_has_pending_model_change",
        "inv_ack_pending_model_change",
        "inv_clear_session_catalog",
        "inv_push_session_catalog_entry",
        "inv_session_catalog_count",
        "inv_set_current_session",
        "inv_has_pending_session_switch",
        "inv_pending_session_switch_len",
        "inv_pending_session_switch_copy",
        "inv_ack_pending_session_switch",
        "inv_set_status_slot",
        "inv_status_slot_len",
        "inv_status_slot_copy",
        "inv_status_slots_clear",
        "inv_set_turn_elapsed",
        "inv_set_busy_tick",
        "inv_image_cache_put",
        "inv_image_cache_clear",
        "inv_math_cache_put",
        "inv_math_cache_clear",
    };

    const install_wasm = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .{ .custom = "bin" } },
    });

    const compile_step = b.step("harness", "Compile Invincible harness Wasm");
    compile_step.dependOn(&install_wasm.step);
    compile_step.dependOn(&b.addInstallFileWithDir(b.path("static/index.html"), .prefix, "bin/index.html").step);
    const web_js = dvui_dep.namedLazyPath("web.js");
    compile_step.dependOn(&b.addInstallFileWithDir(web_js, .prefix, "bin/web.js").step);

    // Alias web.wasm → same bytes (stock dvui HTML samples hardcode web.wasm).
    const copy_web = b.addSystemCommand(&.{ "cp", "-f" });
    copy_web.addArg("zig-out/bin/harness.wasm");
    copy_web.addArg("zig-out/bin/web.wasm");
    copy_web.step.dependOn(&install_wasm.step);
    compile_step.dependOn(&copy_web.step);

    b.getInstallStep().dependOn(compile_step);

    // Host unit tests for rich/parse.zig (phase 1 smoke). Not run on wasm target.
    const host_target = b.graph.host;
    const zmd_host = b.dependency("zmd", .{
        .target = host_target,
        .optimize = optimize,
    });

    // Host-target dvui with testing backend — used only by busy_row_layout
    // layout-rect tests (PR #576 Blocker L6). No SDL/GLFW/OpenGL; pure IMGUI
    // layout (rects, no pixels). The test imports busy_row.zig which needs dvui
    // + palette, so both ride the same module graph.
    const dvui_testing_dep = b.dependency("dvui", .{
        .target = host_target,
        .optimize = optimize,
        .backend = .testing,
    });
    const parse_tests = b.addTest(.{
        .name = "rich-parse",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/parse.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    parse_tests.root_module.addImport("zmd", zmd_host.module("zmd"));
    const run_parse_tests = b.addRunArtifact(parse_tests);
    const test_parse = b.step("test-parse", "Run rich/parse.zig unit tests (host)");
    test_parse.dependOn(&run_parse_tests.step);

    // Host unit tests for cache / link allowlist / kind gate (no dvui frame).
    const test_rich = b.step("test-rich", "Run rich/* host unit tests (parse, cache, links, link_click, kinds, image_cache, math, math_cache, diff_lang, highlight, unicode_face, blockquote, table, thematic, footnote, deflist) + composer_text + cwd_slot + ring_slot (#404 write seam) + chip_preview (#645) + text_wave (#655) + rect_spinner (#651) + busy_spinner + elapsed_clock + model_catalog + session_catalog");
    test_rich.dependOn(&run_parse_tests.step);

    const cache_tests = b.addTest(.{
        .name = "rich-cache",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/cache.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    cache_tests.root_module.addImport("zmd", zmd_host.module("zmd"));
    test_rich.dependOn(&b.addRunArtifact(cache_tests).step);

    // Host unit tests for composer_text.zig (#323 / plan #334): CRLF->LF
    // normalization + SUBMIT_CAP clamp at UTF-8 boundaries. Pure, no dvui.
    {
        const composer_text_tests = b.addTest(.{
            .name = "composer_text",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/composer_text.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(composer_text_tests).step);
    }

    // Host unit tests for cwd_slot.zig (plan #579, adversarial review #584
    // Minor L6): the "."-hidden predicate. Pure, no dvui.
    {
        const cwd_slot_tests = b.addTest(.{
            .name = "cwd_slot",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/cwd_slot.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(cwd_slot_tests).step);
    }

    // Host unit tests for chip_preview.zig (plan #645, review #646 L6): slash+body
    // strips, slash-only keeps, empty, newline, UTF-8 back-off, trailing ws.
    // Pure, no dvui.
    {
        const chip_preview_tests = b.addTest(.{
            .name = "chip_preview",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/chip_preview.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(chip_preview_tests).step);
    }

    // Host unit tests for elapsed_clock.zig (plan #567, protocol v14 turn-clock
    // feed): the four `m:ss` / `h:mm:ss` format cases + undersized-buffer guard.
    // Pure, no dvui.
    {
        const elapsed_clock_tests = b.addTest(.{
            .name = "elapsed_clock",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/elapsed_clock.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(elapsed_clock_tests).step);
    }

    // Host unit tests for model_catalog.zig (plan #614): shortLabel / chooseIndex /
    // showChevron / canCommit. Pure, no dvui.
    {
        const model_catalog_tests = b.addTest(.{
            .name = "model_catalog",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/model_catalog.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(model_catalog_tests).step);
    }

    // Host unit tests for session_catalog.zig (protocol v17 session-rail list).
    {
        const session_catalog_tests = b.addTest(.{
            .name = "session_catalog",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/session_catalog.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(session_catalog_tests).step);
    }

    // Host unit tests for busy_spinner.zig (plan #574): the 2×4 clockwise LUT —
    // head-per-phase, trail ramp, and natural u8 wrap. Pure, no dvui.
    {
        const busy_spinner_tests = b.addTest(.{
            .name = "busy_spinner",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/busy_spinner.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(busy_spinner_tests).step);
    }

    // Host unit tests for text_wave.zig (plan #655): head position, cyclic
    // distance, color-step mapping, scalar count, empty/single-char/UTF-8 edges,
    // full-cycle ramp coverage. Pure logic, no dvui frame — but text_wave.zig
    // imports dvui (via rect_spinner.ColorRamp), so add dvui_testing.
    {
        const text_wave_tests = b.addTest(.{
            .name = "text_wave",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/text_wave.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        text_wave_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(text_wave_tests).step);
    }

    // Host unit tests for rect_spinner.zig (plan #651 L6 lock): TEAL_IDLE_RAMP
    // constant — all four entries are teal_muted. Imports rect_spinner.zig,
    // which needs dvui + palette; tests are pure, no frame.
    {
        const rect_spinner_tests = b.addTest(.{
            .name = "rect_spinner",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/rect_spinner.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        rect_spinner_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(rect_spinner_tests).step);
    }

    const link_tests = b.addTest(.{
        .name = "rich-link-url",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/link_url.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(link_tests).step);

    // Host unit tests for link_click.zig (plan #647): copy vs open vs open_new.
    // Pure pointer flags, no dvui.
    {
        const link_click_tests = b.addTest(.{
            .name = "rich-link-click",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/rich/link_click.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(link_click_tests).step);
    }

    const image_cache_tests = b.addTest(.{
        .name = "rich-image-cache",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/image_cache.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(image_cache_tests).step);

    const kinds_tests = b.addTest(.{
        .name = "rich-kinds",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/kinds.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(kinds_tests).step);

    const diff_lang_tests = b.addTest(.{
        .name = "rich-diff-lang",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/diff_lang.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(diff_lang_tests).step);

    const highlight_tests = b.addTest(.{
        .name = "rich-highlight",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/highlight.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(highlight_tests).step);

    const unicode_face_tests = b.addTest(.{
        .name = "rich-unicode-face",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/unicode_face.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(unicode_face_tests).step);

    const blockquote_tests = b.addTest(.{
        .name = "rich-blockquote",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/blockquote.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(blockquote_tests).step);

    const table_tests = b.addTest(.{
        .name = "rich-table",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/table.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(table_tests).step);

    const thematic_tests = b.addTest(.{
        .name = "rich-thematic",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/thematic.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(thematic_tests).step);
    const footnote_tests = b.addTest(.{
        .name = "rich-footnote",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/footnote.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(footnote_tests).step);

    const deflist_tests = b.addTest(.{
        .name = "rich-deflist",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/deflist.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(deflist_tests).step);

    const math_tests = b.addTest(.{
        .name = "rich-math",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/math.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(math_tests).step);

    const math_cache_tests = b.addTest(.{
        .name = "rich-math-cache",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/math_cache.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(math_cache_tests).step);

    // Protocol v10 tool-run payload decoder (#325 / plan #345). Pure, no dvui.
    const toolrun_tests = b.addTest(.{
        .name = "rich-toolrun",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/toolrun.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(toolrun_tests).step);

    // #404: per-slot tool-run decode cache (slot + revision), pure, no dvui.
    const toolrun_cache_tests = b.addTest(.{
        .name = "rich-toolrun-cache",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/toolrun_cache.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(toolrun_cache_tests).step);

    // #404 follow-up (PR #407 review L6): pin the ring-slot write seam —
    // the `bridge` producers route every body write through `ring_slot.write`,
    // so a forgotten `revision` bump (stale parse/decode on a committed row)
    // is structurally impossible. Pure, no dvui/wasm frame.
    const ring_slot_tests = b.addTest(.{
        .name = "ring-slot",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/ring_slot.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(ring_slot_tests).step);

    // #424: thinking collapse policy (busy turn boundary -> full vs collapsed).
    // Pure, no dvui/wasm frame.
    const thinking_collapse_tests = b.addTest(.{
        .name = "thinking-collapse",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/thinking_collapse.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(thinking_collapse_tests).step);

    // Rich-glue invariants: #387 host/whitespace pins plus current-behavior
    // drift-guards. #336's emph-split is fixed (guard pins the corrected
    // literal-underscore behavior); #343's link-tail `>` is fixed (guard pins
    // the corrected clean-href output); #341's loose-list marker renumber is
    // fixed too (guard pins the preserved counter; also locked by the
    // parse-level #341 tests in `test-rich`). All three related-bug guards are
    // now FIXED pins, so there are no open-bug expectations left in this suite.
    // All GREEN contract pins. NOT part of the default `test-rich` release
    // gate (invariants are a complementary snapshot/drift-check layer, not
    // a duplicate of the blocking gate); `build-harness.yml` runs them as a
    // non-blocking `continue-on-error` step so a rich parse change flags drift
    // without blocking merge.
    // Run explicitly: `zig build test-rich-invariants`.
    const red_tests = b.addTest(.{
        .name = "rich-glue-invariants",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/rich_glue_invariants.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    red_tests.root_module.addImport("zmd", zmd_host.module("zmd"));
    const run_red_tests = b.addRunArtifact(red_tests);
    const test_rich_invariants = b.step("test-rich-invariants", "Run rich-glue invariant suite (#387 white-space/glue pins + #336 fixed guard + #341 fixed guard + #343 fixed guard; green, non-blocking)");
    test_rich_invariants.dependOn(&run_red_tests.step);

    // Host dvui testing-backend layout-rect tests for busy_row.zig (plan #574,
    // PR #576 Blocker L6). Imports busy_row.zig (which needs dvui + palette)
    // and runs the exact same `paintBusyRow` that the harness emits, asserting
    // cell 5×5, sibling-only 3 px gaps, outer grid 13×29, and spinner-left-of-
    // text positioning — no pixels, no SDL/GLFW/OpenGL, no PNG goldens.
    {
        const busy_row_layout_tests = b.addTest(.{
            .name = "busy_row_layout",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/busy_row_layout.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        busy_row_layout_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(busy_row_layout_tests).step);
    }

    // Host dvui testing-backend layout-rect tests for transcript_split.zig
    // (empty collapsible left rail). Closed 40 / open 220 widths + toggle tag.
    {
        const transcript_split_layout_tests = b.addTest(.{
            .name = "transcript_split_layout",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/transcript_split_layout.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        transcript_split_layout_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(transcript_split_layout_tests).step);
    }

    // Host dvui testing-backend layout-rect tests for model_picker.zig
    // (status-bar model menu). Trigger height locked at PICKER_TRIGGER_H.
    {
        const model_picker_layout_tests = b.addTest(.{
            .name = "model_picker_layout",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/model_picker_layout.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        model_picker_layout_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(model_picker_layout_tests).step);
    }

    // Host dvui testing-backend tests for `mixed_text.lookalikePaintFont`
    // (PR #595 adversarial-review Minors L1/L6): pins that the U+2015 separator
    // lookalike is ALWAYS Noto body at the surrounding run's size, regardless of
    // whether the base is Vera mono / body / DejaVu symbols — the exact gap that
    // shipped a wrong face in #594 while tests stayed green. No frame needed.
    {
        const mixed_text_lookalike_tests = b.addTest(.{
            .name = "mixed_text_lookalike",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/mixed_text_lookalike.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        mixed_text_lookalike_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(mixed_text_lookalike_tests).step);
    }
}

/// plan #647 — insert a dedicated right-click press/release branch into vendored
/// `TextLayoutWidget.processEvent`. Must NOT OR `.right` into the left/middle
/// selection gate (that starts `dragPreStart` / `sel_move`).
///
/// Runs at build-file eval, after `b.dependency("dvui")` has extracted zig-pkg.
/// Idempotent via the `invincible: dedicated right-click` marker.
/// Fail-closed: every error path is fatal — if the vendored branch cannot be
/// applied the build must fail (review #662 L1+L4+L6).
fn applyInvincibleRightClickPatch(b: *std.Build, dvui_dep: *std.Build.Dependency) void {
    const io = b.graph.io;
    const widget = resolveDvuiWidgetPath(b, io, dvui_dep) orelse {
        @panic("plan #647: TextLayoutWidget.zig not found — right-click patch cannot be applied (fail-closed)");
    };
    const widget_dirname = std.fs.path.dirname(widget) orelse
        @panic("plan #647: cannot resolve parent dir of TextLayoutWidget.zig path");
    const widget_basename = std.fs.path.basename(widget);

    var widget_parent_dir = std.Io.Dir.openDirAbsolute(io, widget_dirname, .{}) catch |err| {
        std.debug.panic("plan #647: openDirAbsolute({s}) failed: {}", .{ widget_dirname, err });
    };
    defer widget_parent_dir.close(io);

    const src = std.Io.Dir.readFileAlloc(widget_parent_dir, io, widget_basename, b.allocator, .limited(4 * 1024 * 1024)) catch |err| {
        std.debug.panic("plan #647: read {s} failed: {}", .{ widget, err });
    };
    if (std.mem.indexOf(u8, src, "invincible: dedicated right-click") != null) return;

    const needle = "            } else if (me.action == .motion and dvui.captured(self.data().id)) {";
    const insert =
        \\            } else if (me.action == .press and me.button == .right) {
        \\                // invincible: dedicated right-click — capture only, no drag/select
        \\                e.handle(@src(), self.data());
        \\                dvui.captureMouse(self.data(), e.num);
        \\            } else if (me.action == .release and me.button == .right) {
        \\                // invincible: dedicated right-click — set click_pt for addTextClick
        \\                e.handle(@src(), self.data());
        \\                if (dvui.captured(self.data().id)) {
        \\                    self.click_pt = self.data().contentRectScale().pointFromPhysical(me.p);
        \\                    self.click_event = e.evt;
        \\                    dvui.captureMouse(null, e.num);
        \\                    dvui.dragEnd();
        \\                }
        \\            } else if (me.action == .motion and dvui.captured(self.data().id)) {
    ;
    const idx = std.mem.indexOf(u8, src, needle) orelse {
        @panic("plan #647: right-click needle not found in TextLayoutWidget.zig — dvui pin may have drifted; update the needle in build.zig applyInvincibleRightClickPatch");
    };
    const new_src = std.mem.concat(b.allocator, u8, &.{ src[0..idx], insert, src[idx + needle.len ..] }) catch
        @panic("plan #647: OOM concatenating right-click patch");

    var file = widget_parent_dir.createFile(io, widget_basename, .{}) catch |err| {
        std.debug.panic("plan #647: createFile {s} failed: {}", .{ widget, err });
    };
    defer file.close(io);
    file.writeStreamingAll(io, new_src) catch |err| {
        std.debug.panic("plan #647: writeStreamingAll {s} failed: {}", .{ widget, err });
    };
}

fn resolveDvuiWidgetPath(b: *std.Build, io: std.Io, dvui_dep: *std.Build.Dependency) ?[]const u8 {
    const lp = dvui_dep.path("src/widgets/TextLayoutWidget.zig");
    const Lp = @TypeOf(lp);
    if (@hasDecl(Lp, "getPath")) {
        return lp.getPath(b);
    }
    if (@hasDecl(Lp, "getPath3")) {
        const p = lp.getPath3(b, null);
        return b.pathResolve(&.{ p.root_dir.path orelse ".", p.sub_path });
    }
    return findTextLayoutWidgetOnDisk(b, io);
}

fn findTextLayoutWidgetOnDisk(b: *std.Build, io: std.Io) ?[]const u8 {
    const roots = [_][]const u8{ "zig-pkg", ".zig-cache", "zig-cache" };
    for (roots) |root| {
        if (walkForWidget(b, io, root)) |p| return p;
    }
    return null;
}

fn walkForWidget(b: *std.Build, io: std.Io, root: []const u8) ?[]const u8 {
    // Resolve root relative to build root (Zig 0.16: no std.fs.cwd()).
    const build_root_abs = b.build_root.getPath(b);
    const full_root = std.fs.path.join(b.allocator, &.{ build_root_abs, root }) catch return null;
    var dir = std.Io.Dir.openDirAbsolute(io, full_root, .{ .iterate = true }) catch return null;
    defer dir.close(io);
    var it = dir.walk(b.allocator) catch return null;
    defer it.deinit();
    while (it.next() catch null) |ent| {
        if (ent.kind != .file) continue;
        if (std.mem.eql(u8, ent.basename, "TextLayoutWidget.zig")) {
            return std.fs.path.join(b.allocator, &.{ build_root_abs, root, ent.path }) catch return null;
        }
    }
    return null;
}
