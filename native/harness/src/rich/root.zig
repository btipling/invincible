//! Public rich-transcript API for the harness UI.
const paint = @import("paint.zig");
const cache = @import("cache.zig");
const style_mod = @import("style.zig");
const kinds = @import("kinds.zig");
const link_url = @import("link_url.zig");
const image_cache = @import("image_cache.zig");
const math_cache = @import("math_cache.zig");

pub const paintMessageBody = paint.paintMessageBody;
pub const paintDocument = paint.paintDocument;
pub const MessagePaintOpts = paint.MessagePaintOpts;
pub const shouldPaintMarkdown = kinds.shouldPaintMarkdown;
pub const KIND_USER = kinds.KIND_USER;
pub const KIND_ASSISTANT = kinds.KIND_ASSISTANT;
pub const KIND_SYSTEM = kinds.KIND_SYSTEM;
pub const KIND_ERROR = kinds.KIND_ERROR;

pub const setAllocator = cache.setAllocator;
pub const clearCache = cache.clear;
pub const parseCached = cache.parseCached;
pub const fingerprint = cache.fingerprint;

pub const isSafeLinkUrl = link_url.isSafeLinkUrl;
pub const StyleMap = style_mod.StyleMap;
pub const defaultStyle = style_mod.defaultStyle;

// Re-export parse for main force-link / smoke
pub const parse = @import("parse.zig");

pub const imageCacheGet = image_cache.get;
pub const imageCacheClear = image_cache.clear;
pub const imageCacheSetAllocator = image_cache.setAllocator;

pub const mathCacheGet = math_cache.get;
pub const mathCacheClear = math_cache.clear;
pub const mathCacheSetAllocator = math_cache.setAllocator;
