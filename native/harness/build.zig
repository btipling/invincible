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
    exe.entry = .disabled;
    exe.root_module.addImport("dvui", dvui_dep.module("dvui_web"));
    exe.root_module.addImport("web-backend", dvui_dep.module("web"));

    // Zig 0.16 wasm: only names listed here (plus those on dependency modules)
    // appear in the export section. dvui's web backend lists dvui_* / gpa_*;
    // we must list inv_* or the bridge is invisible to JS.
    exe.root_module.export_symbol_names = &.{
        "inv_protocol_version",
        "inv_ping",
        "inv_set_lifecycle",
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
