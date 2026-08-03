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

    const strip = switch (optimize) {
        .ReleaseFast, .ReleaseSmall => true,
        else => false,
    };

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
}
