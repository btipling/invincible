const std = @import("std");

// Invincible Phase 3.1 — dvui web → wasm32-freestanding spike.
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

    const exe = b.addExecutable(.{
        .name = "web",
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

    const install_wasm = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .{ .custom = "bin" } },
    });

    const compile_step = b.step("web-app", "Compile Invincible dvui Wasm spike");
    compile_step.dependOn(&install_wasm.step);
    compile_step.dependOn(&b.addInstallFileWithDir(b.path("static/index.html"), .prefix, "bin/index.html").step);
    const web_js = dvui_dep.namedLazyPath("web.js");
    compile_step.dependOn(&b.addInstallFileWithDir(web_js, .prefix, "bin/web.js").step);

    b.getInstallStep().dependOn(compile_step);
}
