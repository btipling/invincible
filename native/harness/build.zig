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
    applyInvincibleShiftClickPatch(b, dvui_dep);

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
        "inv_queued_count",
        "inv_set_queue_promote_allowed",
        "inv_queued_insert_front",
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
    const test_rich = b.step("test-rich", "Run rich/* host unit tests (parse, cache, links, link_click, kinds, image_cache, math, math_cache, diff_lang, highlight, unicode_face, blockquote, table, thematic, footnote, deflist) + composer_text + composer_history + cwd_slot + ring_slot (#404 write seam) + chip_preview (#645) + text_wave (#655) + rect_spinner (#651) + busy_spinner + elapsed_clock + model_catalog + session_catalog + submit_queue + queue_preview + queue_band + composer + paint_diff + toolrun (#732 tofu seams)");
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

    // Host unit tests for composer_history.zig (plan #667): userCount,
    // userTextAt, step machine. Pure, no dvui, no bridge.zig.
    {
        const composer_history_tests = b.addTest(.{
            .name = "composer_history",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/ui/composer_history.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(composer_history_tests).step);
    }

    // Host unit tests for keymap.zig (plan #741): the single chord table +
    // reserved-browser deny-list + leader machine. Pure, no dvui, no bridge.
    {
        const keymap_tests = b.addTest(.{
            .name = "keymap",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/keymap.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(keymap_tests).step);
    }

    // Host unit tests for help_overlay.zig (plan #761 Nit L6): pin the leader
    // chord glyphs (Ctrl+I / "Leader I, then ?" / "Leader I, then t") and guard
    // against stale "Space" copy. `rowChord` is a hardcoded parallel switch —
    // not derived from the keymap table — so without a test a revert to the
    // pre-#761 "Leader Space" strings would ship while keymap.zig tests stay
    // green. Since #781 the suite also drives the overlay modal `floatingWindow`
    // through the dvui TESTING backend (`dvui.testing.init/.settle/.step/paint`)
    // to lock the wide two-column table, wheel-stays-in-panel, backdrop-close,
    // and key-through-modal behavior — the frame mounts a transcript stand-in
    // exactly as ui.zig does. help_overlay imports dvui (via mixed_text), so
    // wire dvui_testing (still no web-backend: the module's imports stop at
    // mixed_text/unicode_face, which are bridge-free).
    {
        const help_overlay_tests = b.addTest(.{
            .name = "help_overlay",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/help_overlay.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        help_overlay_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        test_rich.dependOn(&b.addRunArtifact(help_overlay_tests).step);
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

    // Host unit tests for bridge.zig protocol-v19 promote gate (plan #760):
    // default-true legacy auto-promote, host set/read round-trip, and reset() /
    // inv_clear_messages re-arming on fresh surfaces. Imports bridge.zig which
    // needs the web-backend stub (mirrors queue_band_tests wiring).
    {
        const bridge_tests = b.addTest(.{
            .name = "bridge",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/bridge.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        bridge_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        bridge_tests.root_module.addImport("web-backend", b.createModule(.{
            .root_source_file = b.path("src/test_web_backend_stub.zig"),
            .target = host_target,
            .optimize = optimize,
        }));
        test_rich.dependOn(&b.addRunArtifact(bridge_tests).step);
    }

    // Host unit tests for submit_queue.zig + queue_preview.zig (plan #664).
    {
        const submit_queue_tests = b.addTest(.{
            .name = "submit_queue",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/submit_queue.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(submit_queue_tests).step);
    }
    {
        const queue_preview_tests = b.addTest(.{
            .name = "queue_preview",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/queue_preview.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        test_rich.dependOn(&b.addRunArtifact(queue_preview_tests).step);
    }

    // Host unit tests for queue_band.zig (plan #677 — blur-save + latch-drop
    // fixes: desiredHeight, beginEdit/closeEdit/saveEdit lifecycle,
    // shouldBlurSave + shouldDropEditOnEmptyQueue predicates
    // (adversarial review #680 Round 2 Major L6)).
    {
        const queue_band_tests = b.addTest(.{
            .name = "queue_band",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/queue_band.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        queue_band_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        // bridge.zig imports web-backend (Wasm-only); provide a no-op stub
        // for host-target tests so the queue-bridge functions compile.
        queue_band_tests.root_module.addImport("web-backend", b.createModule(.{
            .root_source_file = b.path("src/test_web_backend_stub.zig"),
            .target = host_target,
            .optimize = optimize,
        }));
        test_rich.dependOn(&b.addRunArtifact(queue_band_tests).step);
    }

    // Host unit tests for composer.zig enqueue follow (plan #699).
    {
        const composer_tests = b.addTest(.{
            .name = "composer",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/composer.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        composer_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        composer_tests.root_module.addImport("web-backend", b.createModule(.{
            .root_source_file = b.path("src/test_web_backend_stub.zig"),
            .target = host_target,
            .optimize = optimize,
        }));
        test_rich.dependOn(&b.addRunArtifact(composer_tests).step);
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

    // Host dvui testing-backend layout-rect tests for composer_chrome.zig
    // (plan #737, source #734). Drives the REAL extracted `paintComposerChrome`
    // and locks the trailing-reserved icon-pack geometry: the field is
    // width-bounded to `avail_w − (TOUCH_H×n + 8)` so a long unbreakable line
    // can never squeeze the ▶/■ icons off-canvas. composer_chrome imports
    // chrome → rich/toolrun → bridge.zig, so the test needs BOTH dvui
    // (dvui_testing) and the web-backend stub (mirrors queue_band_tests /
    // composer_tests wiring).
    {
        const composer_layout_tests = b.addTest(.{
            .name = "composer_layout",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/composer_layout.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        composer_layout_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        composer_layout_tests.root_module.addImport("web-backend", b.createModule(.{
            .root_source_file = b.path("src/test_web_backend_stub.zig"),
            .target = host_target,
            .optimize = optimize,
        }));
        test_rich.dependOn(&b.addRunArtifact(composer_layout_tests).step);
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

    // PR #681: paintDiffFence / paintDiffText layout tests. Smoke (non-zero
    // rects, line counts, no crash) PLUS a definitive test that paintDiffText
    // uses addTextMixed (rect equals mixed, differs from substituted — a revert
    // to substituted fails CI). Face routing (✎ → DejaVu symbols) is separately
    // pinned by unicode_face.test.zig.
    {
        const paint_diff_tests = b.addTest(.{
            .name = "paint_diff",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/paint_diff.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        paint_diff_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        paint_diff_tests.root_module.addImport("zmd", zmd_host.module("zmd"));
        test_rich.dependOn(&b.addRunArtifact(paint_diff_tests).step);
    }

    // Plan #732 (tofu fix): seam constants pinning that the str_replace L2
    // old/new bands (toolrun.zig) and the collapsed thinking preview
    // (thinking.zig) use addTextMixed — same seam pattern as paint_diff.zig's
    // diffTextPainter. toolrun.test.zig transitively imports bridge.zig (Wasm
    // web-backend, provided via the stub like queue_band/composer) + rich/parse
    // (zmd), so wire all three module imports.
    {
        const toolrun_seam_tests = b.addTest(.{
            .name = "toolrun",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/toolrun.test.zig"),
                .target = host_target,
                .optimize = optimize,
            }),
        });
        toolrun_seam_tests.root_module.addImport("dvui", dvui_testing_dep.module("dvui_testing"));
        toolrun_seam_tests.root_module.addImport("web-backend", b.createModule(.{
            .root_source_file = b.path("src/test_web_backend_stub.zig"),
            .target = host_target,
            .optimize = optimize,
        }));
        toolrun_seam_tests.root_module.addImport("zmd", zmd_host.module("zmd"));
        test_rich.dependOn(&b.addRunArtifact(toolrun_seam_tests).step);
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

/// plan #752 — dedicate a Shift+click selection-extend path in the vendored
/// `TextLayoutWidget`. Stock dvui treats a left press as a plain caret move
/// (`selection.moveCursor(hit, false)`, no extend). This patch adds a
/// `sel_move.shift_click` variant that extends the selection to the click point
/// using the widget's own stock extend (`selection.moveCursor(hit, true)`, the
/// same path as Shift+arrow), so the anchor edge stays fixed across repeated
/// Shift+clicks (A,B,C → [A,C]) and after a drag-select ([5,20] then Shift+click
/// 30 → [5,30]). A Shift+click also zeros `click_num` and is excluded from the
/// release double-click counter, so the next plain click stays a caret-move +
/// clear (stock web never counts Shift+clicks toward double-clicks). Exclusion
/// is detected three ways at release (see needle 9): same-frame `.shift_click`,
/// live `me.mod.shift()`, and — the last two adversarial Nits (rounds 4 and 5) —
/// a persisted `_shift_click_press` flag that survives a two-frame click where
/// Shift is released before mouseup and is consumed once per release (needle 10),
/// so a Shift+press that became a drag cannot leave a stale flag.
///
/// The click point → byte resolution lives in `selMovePre`/`lineBreak` (during
/// `addText`, the only place text rects exist), so the variant rides the same
/// async `sel_move` machine the plan's #647 split forbids overloading. The
/// plain left-click move-caret path is untouched; `.right`/`.middle` are
/// untouched (no #647 regression); copy is handled by `TextEntryWidget.copy()`
/// on the reserved chord (kept browser-reserved, handled inside the widget).
///
/// Runs at build-file eval, after the #647 right-click patch. Idempotent via
/// the `invincible: dedicated shift-click` marker. Fail-closed: every needle
/// must match exactly once or the build panics.
fn applyInvincibleShiftClickPatch(b: *std.Build, dvui_dep: *std.Build.Dependency) void {
    const io = b.graph.io;
    const widget = resolveDvuiWidgetPath(b, io, dvui_dep) orelse {
        @panic("plan #752: TextLayoutWidget.zig not found — shift-click patch cannot be applied (fail-closed)");
    };
    const widget_dirname = std.fs.path.dirname(widget) orelse
        @panic("plan #752: cannot resolve parent dir of TextLayoutWidget.zig path");
    const widget_basename = std.fs.path.basename(widget);

    var widget_parent_dir = std.Io.Dir.openDirAbsolute(io, widget_dirname, .{}) catch |err| {
        std.debug.panic("plan #752: openDirAbsolute({s}) failed: {}", .{ widget_dirname, err });
    };
    defer widget_parent_dir.close(io);

    const src = std.Io.Dir.readFileAlloc(widget_parent_dir, io, widget_basename, b.allocator, .limited(4 * 1024 * 1024)) catch |err| {
        std.debug.panic("plan #752: read {s} failed: {}", .{ widget, err });
    };
    if (std.mem.indexOf(u8, src, "invincible: dedicated shift-click") != null) return;

    const Patch = struct { needle: []const u8, replacement: []const u8 };
    const patches = [_]Patch{
        .{
            // 1. union variant after the `.mouse` struct.
            .needle =
            \\        drag_pt: ?Point = null, // point of current mouse drag
            \\    },
            ,
            .replacement =
            \\        drag_pt: ?Point = null, // point of current mouse drag
            \\    },
            \\
            \\    // invincible: dedicated shift-click (plan #752) — extend the selection to the
            \\    // click point via the widget's own stock extend (moveCursor(hit, true), the
            \\    // same path as Shift+arrow), so the anchor edge stays fixed across repeated
            \\    // Shift+clicks. Click point resolved to a byte during addText.
            \\    shift_click: struct {
            \\        down_pt: ?Point = null, // click point, resolved to a byte during addText
            \\        byte: ?usize = null, // resolved byte index of the click point
            \\    },
            ,
        },
        .{
            // 2. selMovePre — resolve the click point, extend from anchor.
            .needle =
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            \\            if (ep.pt) |p| {
            \\                if (self.findPoint(p, text_rect, self.bytes_seen, text_line, options)) |ba| {
            \\                    self.selection.moveCursor(ba.byte, false);
            ,
            .replacement =
            \\            }
            \\        },
            \\        .shift_click => |*sc| {
            \\            if (sc.down_pt) |p| {
            \\                if (self.findPoint(p, text_rect, self.bytes_seen, text_line, options)) |ba| {
            \\                    sc.byte = ba.byte;
            \\                    // stock extend: keeps the fixed (anchor) edge, moves only the
            \\                    // active end — matches Shift+arrow; fixes repeated Shift+clicks
            \\                    // (A,B,C -> [A,C]) and drag-then-Shift+click ([5,20]+30 -> [5,30]).
            \\                    self.selection.moveCursor(ba.byte, true);
            \\                    self.selection.affinity = ba.affinity;
            \\                    sc.down_pt = null;
            \\                } else {
            \\                    // haven't found it yet, keep cursor at end to not trigger cursor_seen
            \\                    self.selection.moveCursor(self.bytes_seen + end, true);
            \\                }
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            \\            if (ep.pt) |p| {
            \\                if (self.findPoint(p, text_rect, self.bytes_seen, text_line, options)) |ba| {
            \\                    self.selection.moveCursor(ba.byte, false);
            ,
        },
        .{
            // 3. lineBreak — extend when the click point sits past a wrapped line end.
            .needle =
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            \\            if (ep.pt) |p| {
            \\                if (p.y < self.insert_pt.y) {
            ,
            .replacement =
            \\            }
            \\        },
            \\        .shift_click => |*sc| {
            \\            if (sc.down_pt) |p| {
            \\                if (p.y < self.insert_pt.y) {
            \\                    // point was right of previous line, no newline
            \\                    sc.byte = self.bytes_seen;
            \\                    self.selection.moveCursor(self.bytes_seen, true);
            \\                    self.selection.affinity = .before;
            \\                    sc.down_pt = null;
            \\                    self.cursorSeen();
            \\                }
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            \\            if (ep.pt) |p| {
            \\                if (p.y < self.insert_pt.y) {
            ,
        },
        .{
            // 4. selMoveText — no-op arm (selection already set in selMovePre).
            .needle =
            \\        .none => {},
            \\        .mouse => {},
            \\        .expand_pt => |*ep| {
            \\            if (!ep.done) {
            \\                const search = if (ep.which == .word) word_breaks else "\n";
            ,
            .replacement =
            \\        .none => {},
            \\        .mouse => {},
            \\        .shift_click => {},
            \\        .expand_pt => |*ep| {
            \\            if (!ep.done) {
            \\                const search = if (ep.which == .word) word_breaks else "\n";
            ,
        },
        .{
            // 5. cursorSeen — no-op arm.
            .needle =
            \\        .none => {},
            \\        .mouse => {},
            \\        .expand_pt => |*ep| {
            \\            if (!ep.done) {
            \\                switch (ep.which) {
            ,
            .replacement =
            \\        .none => {},
            \\        .mouse => {},
            \\        .shift_click => {},
            \\        .expand_pt => |*ep| {
            \\            if (!ep.done) {
            \\                switch (ep.which) {
            ,
        },
        .{
            // 6. bytesNeeded — no-op arm (anchor is in the visible region like mouse).
            .needle =
            \\        .mouse => {}, // all in visible region, excepted below
            \\        .expand_pt => |*ep| {
            ,
            .replacement =
            \\        .mouse => {}, // all in visible region, excepted below
            \\        .shift_click => {}, // all in visible region like mouse
            \\        .expand_pt => |*ep| {
            ,
        },
        .{
            // 7. addTextDone fallback — resolve an unresolved click to end-of-text.
            .needle =
            \\            if (m.drag_pt) |_| {
            \\                self.selection.cursor = self.bytes_seen;
            \\                self.selection.start = @min(m.byte.?, self.bytes_seen);
            \\                self.selection.end = @max(m.byte.?, self.bytes_seen);
            \\                m.drag_pt = null;
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            ,
            .replacement =
            \\            if (m.drag_pt) |_| {
            \\                self.selection.cursor = self.bytes_seen;
            \\                self.selection.start = @min(m.byte.?, self.bytes_seen);
            \\                self.selection.end = @max(m.byte.?, self.bytes_seen);
            \\                m.drag_pt = null;
            \\            }
            \\        },
            \\        .shift_click => |*sc| {
            \\            if (sc.down_pt) |_| {
            \\                // click point never resolved to a text rect — extend to end-of-text
            \\                sc.byte = self.bytes_seen;
            \\                self.selection.moveCursor(self.bytes_seen, true);
            \\                sc.down_pt = null;
            \\            }
            \\        },
            \\        .expand_pt => |*ep| {
            ,
        },
        .{
            // 8. press handler — Shift+pointer press picks .shift_click; plain click untouched.
            .needle =
            \\                } else if (me.button.pointer()) {
            \\                    // a click always sets sel_move - has the highest priority
            \\                    const p = self.data().contentRectScale().pointFromPhysical(me.p);
            \\                    self.sel_move = .{ .mouse = .{ .down_pt = p } };
            \\                    self.scroll_to_cursor = true;
            \\
            \\                    if (self.click_num == 1) {
            \\                        // select word we touched
            \\                        self.sel_move = .{ .expand_pt = .{ .which = .word, .pt = p } };
            \\                    } else if (self.click_num == 2) {
            \\                        // select line we touched
            \\                        self.sel_move = .{ .expand_pt = .{ .which = .line, .pt = p } };
            \\                    }
            \\                }
            ,
            .replacement =
            \\                } else if (me.button.pointer()) {
            \\                    // invincible: dedicated shift-click (plan #752) — if shift is
            \\                    // held, extend selection to the click point; never fall through
            \\                    // to the plain caret-move / drag path, and never count this as a
            \\                    // click toward the next word/line double-click (stock web).
            \\                    if (me.mod.shift()) {
            \\                        self.click_num = 0;
            \\                        // persist that this press was a Shift+click so its release —
            \\                        // even a two-frame web click where Shift is released before
            \\                        // mouseup (adversarial round-4 Nit L1) — is never counted
            \\                        // toward the next word/line double-click. The `.shift_click`
            \\                        // variant is frame-local (re-inits to .none each frame), so
            \\                        // this store flag crosses the press→release frame gap, the
            \\                        // same way `.mouse.byte` persists while captured. Consumed
            \\                        // (dataRemove) at the release cleanup (needle 10), which runs on any
            \\                        // pointer/middle release — click and drag alike.
            \\                        dvui.dataSet(null, self.data().id, "_shift_click_press", true);
            \\                        self.sel_move = .{ .shift_click = .{} };
            \\                        self.sel_move.shift_click.down_pt = self.data().contentRectScale().pointFromPhysical(me.p);
            \\                        self.scroll_to_cursor = true;
            \\                    } else {
            \\                        // a click always sets sel_move - has the highest priority
            \\                        const p = self.data().contentRectScale().pointFromPhysical(me.p);
            \\                        self.sel_move = .{ .mouse = .{ .down_pt = p } };
            \\                        self.scroll_to_cursor = true;
            \\
            \\                        if (self.click_num == 1) {
            \\                            // select word we touched
            \\                            self.sel_move = .{ .expand_pt = .{ .which = .word, .pt = p } };
            \\                        } else if (self.click_num == 2) {
            \\                            // select line we touched
            \\                            self.sel_move = .{ .expand_pt = .{ .which = .line, .pt = p } };
            \\                        }
            \\                    }
            \\                }
            ,
        },
        .{
            // 9. release handler — a Shift+click must never count toward the word/line
            //    double-click counter (it already zeroed click_num at press), so the
            //    follow-on plain click stays a caret-move + clear. Stock web does not
            //    count Shift+clicks toward double-clicks. THREE-WAY gate (adversarial
            //    round-3 CONCERNS L1 + round-4 Nit L1): skip the increment when this
            //    press was a Shift+click, detected by ANY of:
            //      (a) `self.sel_move == .shift_click` — press and release in the same
            //          event batch, so the variant is still set at release;
            //      (b) `me.mod.shift()` — Shift still held at mouseup (the common
            //          two-frame web click: `sel_move` is frame-local and re-inits to
            //          `.none` each frame, so the release frame does not retain
            //          `.shift_click`);
            //      (c) persisted `_shift_click_press` — set by the press handler
            //          (needle 8) and read here, closing the two-frame click where Shift
            //          was released before mouseup (round-4 Nit). It mirrors how
            //          `.mouse.byte` persists across captured frames; it is read here and
            //          consumed at the release cleanup (needle 10), so a Shift+press that
            //          became a drag cannot leave a stale flag that would suppress a later
            //          plain click's count (adversarial round-5 Nit L1).
            //    Round 2 gated only on `!me.mod.shift()` (PASS; Nit about the shift-
            //    released-before-mouseup hyper-edge). Round 3 swapped it for only
            //    `self.sel_move != .shift_click`, which broke the common path — see
            //    the gate below for why (a) and (b) must be OR'd together, and (c)
            //    for the round-4 gap.
            .needle =
            \\                        if (me.button.pointer()) {
            \\                            self.click_num += 1;
            \\                            self.click_num_pt = me.p;
            \\                            if (self.click_num >= 3) {
            \\                                self.click_num = 0;
            \\                            }
            \\
            ,
            .replacement =
            \\                        // invincible: never count a Shift+click toward the next word/line
            \\                        // double-click (it already zeroed click_num at press). THREE-WAY
            \\                        // detection that this press was a Shift+click:
            \\                        //   (a) still-captured same-frame release (`sel_move == .shift_click`);
            \\                        //   (b) common two-frame click with Shift still held at mouseup
            \\                        //       (`me.mod.shift()` — the frame-local .shift_click variant
            \\                        //       re-inits to .none every frame, so a single
            \\                        //       `sel_move != .shift_click` gate failed in round 3);
            \\                        //   (c) two-frame click where Shift was released before mouseup
            \\                        //       (round-4 race): the `_shift_click_press` flag persisted by
            \\                        //       the press handler crosses the frame gap (like `.mouse.byte`).
            \\                        // Read here (single consumer, the click-without-drag arm); the
            \\                        // flag is consumed exactly once per release at the release cleanup
            \\                        // (needle 10), so a Shift+press that became a drag cannot leave a
            \\                        // stale flag suppressing a later plain click's double-click count.
            \\                        const shift_click_release =
            \\                            self.sel_move == .shift_click or
            \\                            me.mod.shift() or
            \\                            (dvui.dataGet(null, self.data().id, "_shift_click_press", bool) orelse false);
            \\                        if (me.button.pointer() and !shift_click_release) {
            \\                            self.click_num += 1;
            \\                            self.click_num_pt = me.p;
            \\                            if (self.click_num >= 3) {
            \\                                self.click_num = 0;
            \\                            }
            \\
            ,
        },
        .{
            // 10. release cleanup — consume the persisted `_shift_click_press` flag here on
            //     ANY pointer/middle release that ends the capture, not just the
            //     click-without-drag arm (needle 9). A Shift+press that became a drag never
            //     enters needle 9's arm, so without this the flag would persist and suppress
            //     the next plain click's double-click count exactly once (adversarial round-5
            //     Nit L1). The read for suppression lives in needle 9 (the click arm); this
            //     consumption runs after it and on every other release too. dataRemove on an
            //     absent key is a no-op, so it is safe when the press was never a Shift+click.
            .needle =
            \\                        dvui.refresh(null, @src(), self.data().id);
            \\                    }
            \\
            \\                    dvui.captureMouse(null, e.num);
            \\                    dvui.dragEnd();
            \\                }
            \\
            ,
            .replacement =
            \\                        dvui.refresh(null, @src(), self.data().id);
            \\                    }
            \\
            \\                    // invincible: consume the `_shift_click_press` flag on ANY release that
            \\                    // ends the capture. The click-without-drag arm (needle 9) already read
            \\                    // it for suppression; a drag release never entered that arm. Without
            \\                    // this consume, a Shift+press that became a drag would leave a stale flag
            \\                    // that suppresses the next plain click's double-click count exactly once
            \\                    // (adversarial round-5 Nit L1). dataRemove on an absent key is a no-op,
            \\                    // so this is safe when the press was never a Shift+click.
            \\                    dvui.dataRemove(null, self.data().id, "_shift_click_press");
            \\                    dvui.captureMouse(null, e.num);
            \\                    dvui.dragEnd();
            \\                }
            \\
        },
    };

    var new_src = src;
    for (patches) |patch| {
        const occurrences = countOccurrences(new_src, patch.needle);
        if (occurrences != 1) {
            @panic("plan #752: shift-click needle must match exactly once in TextLayoutWidget.zig — dvui pin may have drifted; update applyInvincibleShiftClickPatch");
        }
        const idx = std.mem.indexOf(u8, new_src, patch.needle) orelse unreachable;
        new_src = std.mem.concat(b.allocator, u8, &.{ new_src[0..idx], patch.replacement, new_src[idx + patch.needle.len ..] }) catch
            @panic("plan #752: OOM concatenating shift-click patch");
    }

    var file = widget_parent_dir.createFile(io, widget_basename, .{}) catch |err| {
        std.debug.panic("plan #752: createFile {s} failed: {}", .{ widget, err });
    };
    defer file.close(io);
    file.writeStreamingAll(io, new_src) catch |err| {
        std.debug.panic("plan #752: writeStreamingAll {s} failed: {}", .{ widget, err });
    };
}

/// Count non-overlapping occurrences of `needle` in `haystack`.
fn countOccurrences(haystack: []const u8, needle: []const u8) usize {
    if (needle.len == 0) return 0;
    var count: usize = 0;
    var rest = haystack;
    while (std.mem.indexOf(u8, rest, needle)) |idx| {
        count += 1;
        rest = rest[idx + needle.len ..];
    }
    return count;
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
