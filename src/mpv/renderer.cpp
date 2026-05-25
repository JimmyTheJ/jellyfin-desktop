#ifdef _WIN32
#include "renderer.h"
#include "../logging.h"

bool MpvRenderer::init(mpv_handle* mpv, mpv_opengl_init_params* gl_params) {
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE,           const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL) },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, gl_params },
        { MPV_RENDER_PARAM_INVALID,            nullptr }
    };
    int err = mpv_render_context_create(&ctx_, mpv, params);
    if (err < 0) {
        LOG_ERROR(LOG_PLATFORM, "mpv_render_context_create failed: {}", err);
        return false;
    }
    return true;
}

void MpvRenderer::set_update_callback(mpv_render_update_fn fn, void* ctx) {
    if (ctx_) mpv_render_context_set_update_callback(ctx_, fn, ctx);
}

bool MpvRenderer::render(int fbo_id, int w, int h) {
    if (!ctx_) return false;
    uint64_t flags = mpv_render_context_update(ctx_);
    if (!(flags & MPV_RENDER_UPDATE_FRAME)) return false;

    int flip_y = 1;
    mpv_opengl_fbo fbo{};
    fbo.fbo             = fbo_id;
    fbo.w               = w;
    fbo.h               = h;
    fbo.internal_format = 0;  // mpv picks (GL_RGBA8)

    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_OPENGL_FBO, &fbo      },
        { MPV_RENDER_PARAM_FLIP_Y,     &flip_y   },
        { MPV_RENDER_PARAM_INVALID,    nullptr   }
    };
    mpv_render_context_render(ctx_, params);
    return true;
}

void MpvRenderer::report_swap() {
    if (ctx_) mpv_render_context_report_swap(ctx_);
}

void MpvRenderer::free() {
    if (ctx_) {
        mpv_render_context_free(ctx_);
        ctx_ = nullptr;
    }
}

#endif // _WIN32
