#pragma once
#ifdef _WIN32

#include <mpv/render_gl.h>

// Wraps mpv_render_context lifecycle + frame rendering for the OpenGL backend.
class MpvRenderer {
public:
    bool init(mpv_handle* mpv, mpv_opengl_init_params* gl_params);
    void set_update_callback(mpv_render_update_fn fn, void* ctx);
    // Renders one frame into fbo_id if a new frame is available.
    // Returns true if a frame was rendered.
    bool render(int fbo_id, int w, int h);
    void report_swap();
    void free();
    bool is_valid() const { return ctx_ != nullptr; }

private:
    mpv_render_context* ctx_ = nullptr;
};

#endif // _WIN32
