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
        "inv_begin_batch",
        "inv_end_batch",
        "inv_push_message",
        "inv_clear_messages",
        "inv_echo",
        "inv_echo_len",
        "inv_echo_copy",
        "inv_has_pending_submit",
        "inv_pending_submit_len",
        "inv_pending_submit_copy",
        "inv_ack_pending_submit",
        "inv_clear_model_catalog",
        "inv_push_model_catalog_entry",
        "inv_model_catalog_count",
        "inv_selected_model_len",
        "inv_selected_model_copy",
        "inv_cycle_selected_model",
        "inv_image_cache_put",
        "inv_image_cache_clear",
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
    const test_rich = b.step("test-rich", "Run rich/* host unit tests (parse, cache, links, kinds, image_cache, diff_lang, highlight, unicode_face, blockquote, table, thematic, footnote, deflist)");
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

    const link_tests = b.addTest(.{
        .name = "rich-link-url",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/rich/link_url.zig"),
            .target = host_target,
            .optimize = optimize,
        }),
    });
    test_rich.dependOn(&b.addRunArtifact(link_tests).step);

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

}

