//! Host tests for composer.zig enqueue follow (plan #699 / source #696).
const std = @import("std");
const t = std.testing;
const bridge = @import("bridge.zig");
const composer = @import("ui/composer.zig");
const state = @import("ui/state.zig");
const submit_queue = @import("submit_queue.zig");

fn scrolledUpTranscript() void {
    state.transcript_scroll.virtual_size.h = 2000;
    state.transcript_scroll.viewport.h = 400;
    state.transcript_scroll.viewport.y = 0;
}

test "submitOrEnqueue: idle send does not latch queue_follow" {
    bridge.reset();
    state.resetTranscriptScroll();
    composer.submitOrEnqueue("start a turn");
    try t.expect(!state.queue_follow);
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
}

test "submitOrEnqueue: busy enqueue latches follow and scrolls transcript" {
    bridge.reset();
    state.resetTranscriptScroll();
    composer.submitOrEnqueue("start a turn");
    scrolledUpTranscript();
    state.queue_follow = false;
    composer.submitOrEnqueue("follow-up");
    try t.expectEqual(@as(u32, 1), bridge.queuedCount());
    try t.expect(state.queue_follow);
    try t.expectEqual(
        state.transcript_scroll.scrollMax(.vertical),
        state.transcript_scroll.viewport.y,
    );
    try t.expectEqual(@as(u8, 0), state.prompt_buf[0]);
}

test "submitOrEnqueue: blank does not scroll or latch" {
    bridge.reset();
    state.resetTranscriptScroll();
    composer.submitOrEnqueue("start a turn");
    scrolledUpTranscript();
    state.queue_follow = false;
    composer.submitOrEnqueue("   \n");
    try t.expectEqual(@as(u32, 0), bridge.queuedCount());
    try t.expect(!state.queue_follow);
    try t.expectEqual(@as(f32, 0), state.transcript_scroll.viewport.y);
}

test "submitOrEnqueue: full queue does not scroll or latch" {
    bridge.reset();
    state.resetTranscriptScroll();
    composer.submitOrEnqueue("start a turn");
    var i: u32 = 0;
    while (i < submit_queue.MAX_ITEMS) : (i += 1) {
        composer.submitOrEnqueue("queued");
    }
    try t.expectEqual(@as(u32, @intCast(submit_queue.MAX_ITEMS)), bridge.queuedCount());
    state.queue_follow = false;
    scrolledUpTranscript();
    @memset(&state.prompt_buf, 0);
    const keep = "should stay";
    @memcpy(state.prompt_buf[0..keep.len], keep);
    composer.submitOrEnqueue(keep);
    try t.expectEqual(@as(u32, @intCast(submit_queue.MAX_ITEMS)), bridge.queuedCount());
    try t.expect(!state.queue_follow);
    try t.expectEqual(@as(f32, 0), state.transcript_scroll.viewport.y);
    try t.expectEqualStrings(keep, state.prompt_buf[0..keep.len]);
}
