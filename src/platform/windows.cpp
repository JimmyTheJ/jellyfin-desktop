#ifdef _WIN32
// platform_windows.cpp — Windows platform layer.
// D3D11 + DirectComposition composites CEF shared textures (main + overlay)
// onto mpv's HWND. A transparent child HWND captures input for CEF.

#include "platform/platform.h"
#include "common.h"
#include "cef/cef_client.h"
#include "browser/browsers.h"
#include "browser/web_browser.h"
#include "browser/overlay_browser.h"
#include "browser/about_browser.h"
#include "input/input_windows.h"
#include "logging.h"
#include "mpv/event.h"
#include "mpv/renderer.h"
#include "settings.h"
#include "wake_event.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <dcomp.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <GL/gl.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <future>
#include <mutex>
#include <thread>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "shell32.lib")

// =====================================================================
// Windows state (file-static)
// =====================================================================

struct WinState {
    std::mutex surface_mtx;  // protects swap chain ops during transitions

    HWND mpv_hwnd = nullptr;

    // D3D11
    ID3D11Device1* d3d_device = nullptr;
    ID3D11DeviceContext* d3d_context = nullptr;
    ID3D11DeviceContext1* d3d_context1 = nullptr;  // for ClearView (mini-player hole)
    IDXGIFactory2* dxgi_factory = nullptr;

    // Mini-player hole rect in physical pixels (w=0 means inactive)
    struct { int x = 0, y = 0, w = 0, h = 0; } mini_hole;

    // Last PiP rect in CSS logical pixels + video AR; enables immediate
    // reapply of mpv zoom/align on window resize without a JS round-trip.
    struct PipParams {
        bool   active = false;
        double x = 0, y = 0, w = 0, h = 0;  // CSS logical pixels
        double ar = 0;                         // video display AR (dw/dh)
    } pip_params;

    // DirectComposition
    IDCompositionDevice* dcomp_device = nullptr;
    IDCompositionTarget* dcomp_target = nullptr;
    IDCompositionVisual* dcomp_root = nullptr;
    IDCompositionVisual* dcomp_video_visual = nullptr;  // bottom: mpv video layer
    IDCompositionVisual* dcomp_main_visual = nullptr;
    IDCompositionVisual* dcomp_overlay_visual = nullptr;
    IDCompositionEffectGroup* dcomp_overlay_effect = nullptr;
    IDCompositionVisual* dcomp_about_visual = nullptr;

    // Main browser swap chain
    IDXGISwapChain1* main_swap_chain = nullptr;
    int main_sw = 0, main_sh = 0;

    // Overlay browser swap chain
    IDXGISwapChain1* overlay_swap_chain = nullptr;
    int overlay_sw = 0, overlay_sh = 0;
    bool overlay_visible = false;

    // About browser swap chain (above overlay)
    IDXGISwapChain1* about_swap_chain = nullptr;
    int about_sw = 0, about_sh = 0;
    bool about_visible = false;

    // Video swap chain for mpv render-to-texture output (protected by surface_mtx)
    IDXGISwapChain1* video_swap_chain = nullptr;
    int video_sw = 0, video_sh = 0;

    // Window state
    float cached_scale = 1.0f;
    int mpv_pw = 0, mpv_ph = 0;  // mpv's current physical size

    // Fullscreen transition
    int expected_w = 0, expected_h = 0;
    int transition_pw = 0, transition_ph = 0;
    int pending_lw = 0, pending_lh = 0;
    bool transitioning = false;
    bool was_fullscreen = false;
    bool was_maximized = false;  // for skipping stale reapply on restore-from-maximize

    // Win32 fullscreen state (set before applying Win32 changes to guard WM_SIZE)
    bool win_is_fullscreen  = false;
    RECT saved_window_rect  = {};
    LONG saved_window_style = 0;

    // GL render context (created in win_init, used by render_thread)
    HWND  gl_hwnd  = nullptr;
    HDC   gl_hdc   = nullptr;
    HGLRC gl_hglrc = nullptr;

    // mpv render API context
    MpvRenderer renderer;

    // Render thread + wake events
    std::thread render_thread;
    WakeEvent   render_wake;
    WakeEvent   render_stop;

    // Pending FBO size (written from our_wndproc WM_SIZE, read by render thread)
    std::atomic<int> pending_fbo_w{0};
    std::atomic<int> pending_fbo_h{0};

    // GL FBO + color texture (render thread only — no lock needed)
    GLuint gl_fbo       = 0;
    GLuint gl_color_tex = 0;
    int    fbo_w = 0, fbo_h = 0;

    // CPU readback pixel buffer (render thread only)
    std::vector<uint8_t> pixel_buf;

    // Main window thread (owns mpv_hwnd message loop)
    std::thread main_window_thread;
    DWORD       main_window_tid = 0;

    // Input thread (body lives in input::windows::run_input_thread)
    std::thread input_thread;

    // ── Detached PiP window ──────────────────────────────────────────────────
    // pip_phase: 0=Main (render to main swap chain),
    //            1=Active (render to pip swap chain),
    //            2=Closing (render thread tears down pip resources)
    std::atomic<int> pip_phase{0};
    std::mutex       pip_op_mtx;  // serializes open/close; held for entire close sequence

    HWND             pip_hwnd        = nullptr;
    std::thread      pip_window_thread;
    DWORD            pip_window_tid  = 0;

    // pip swap chain (created/destroyed by render thread under surface_mtx)
    IDXGISwapChain1* pip_swap_chain = nullptr;
    int              pip_sw = 0, pip_sh = 0;

    // Pending pip window client size (written by pip_wndproc, read by render thread)
    std::atomic<int> pending_pip_w{0};
    std::atomic<int> pending_pip_h{0};

    // Close acknowledgement (a promise on the stack of win_close_detached_pip,
    // protected by surface_mtx; render thread fulfills it after pip teardown)
    std::promise<void>* pip_close_ack = nullptr;

    // Pip GL FBO (render thread only — no lock needed)
    GLuint pip_gl_fbo       = 0;
    GLuint pip_gl_color_tex = 0;
    int    pip_fbo_w = 0, pip_fbo_h = 0;
    std::vector<uint8_t> pip_pixel_buf;
};

static WinState g_win;

// Custom WM_APP messages
static const UINT WM_APP_PIP_CLOSED  = WM_APP + 1; // pip_wndproc → mpv_hwnd: user closed pip
static const UINT WM_APP_PIP_DESTROY = WM_APP + 2; // win_close_detached_pip → pip_hwnd: C++ close

// =====================================================================
// GL extension constants (not in Windows SDK <GL/gl.h>)
// =====================================================================
#ifndef GL_BGRA
#  define GL_BGRA 0x80E1
#endif
#ifndef GL_RGBA8
#  define GL_RGBA8 0x8058
#endif
#ifndef GL_FRAMEBUFFER
#  define GL_FRAMEBUFFER 0x8D40
#endif
#ifndef GL_COLOR_ATTACHMENT0
#  define GL_COLOR_ATTACHMENT0 0x8CE0
#endif
#ifndef GL_FRAMEBUFFER_COMPLETE
#  define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#endif

// GL extension function pointers (loaded once in render thread via wglGetProcAddress)
static void (APIENTRY* gl_GenFramebuffers_)(GLsizei, GLuint*)           = nullptr;
static void (APIENTRY* gl_DeleteFramebuffers_)(GLsizei, const GLuint*)  = nullptr;
static void (APIENTRY* gl_BindFramebuffer_)(GLenum, GLuint)             = nullptr;
static void (APIENTRY* gl_FramebufferTexture2D_)(GLenum, GLenum, GLenum, GLuint, GLint) = nullptr;
static GLenum (APIENTRY* gl_CheckFramebufferStatus_)(GLenum)            = nullptr;

static void win_begin_transition_locked();
static void win_end_transition_locked();
static void win_clamp_window_geometry(int* w, int* h, int* x, int* y);
static void win_close_detached_pip(bool restore_main_video);
static void win_refresh_main_surface_size();

// =====================================================================
// D3D11 / DXGI / DComp initialization
// =====================================================================

static bool init_d3d() {
    // Create D3D11 device
    D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    ID3D11Device* base_device = nullptr;
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
        levels, 2, D3D11_SDK_VERSION, &base_device, nullptr, &g_win.d3d_context);
    if (FAILED(hr) || !base_device) {
        LOG_ERROR(LOG_PLATFORM, "D3D11CreateDevice failed: 0x{:08x}", hr);
        return false;
    }
    hr = base_device->QueryInterface(__uuidof(ID3D11Device1), (void**)&g_win.d3d_device);
    base_device->Release();
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "QueryInterface for ID3D11Device1 failed: 0x{:08x}", hr);
        return false;
    }

    // QI for ID3D11DeviceContext1 (needed for ClearView to punch mini-player hole)
    g_win.d3d_context->QueryInterface(__uuidof(ID3D11DeviceContext1),
                                      (void**)&g_win.d3d_context1);

    // Get DXGI factory
    IDXGIDevice* dxgi_device = nullptr;
    g_win.d3d_device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgi_device);
    IDXGIAdapter* adapter = nullptr;
    dxgi_device->GetAdapter(&adapter);
    adapter->GetParent(__uuidof(IDXGIFactory2), (void**)&g_win.dxgi_factory);
    adapter->Release();
    dxgi_device->Release();

    return true;
}

static bool init_dcomp() {
    HRESULT hr = DCompositionCreateDevice(nullptr, __uuidof(IDCompositionDevice),
        (void**)&g_win.dcomp_device);
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "DCompositionCreateDevice failed: 0x{:08x}", hr);
        return false;
    }

    hr = g_win.dcomp_device->CreateTargetForHwnd(g_win.mpv_hwnd, FALSE, &g_win.dcomp_target);
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "CreateTargetForHwnd failed: 0x{:08x}", hr);
        return false;
    }

    // Visual tree (bottom to top): root → video → main → overlay → about
    g_win.dcomp_device->CreateVisual(&g_win.dcomp_root);
    g_win.dcomp_device->CreateVisual(&g_win.dcomp_video_visual);
    g_win.dcomp_device->CreateVisual(&g_win.dcomp_main_visual);
    g_win.dcomp_device->CreateVisual(&g_win.dcomp_overlay_visual);
    g_win.dcomp_device->CreateEffectGroup(&g_win.dcomp_overlay_effect);
    g_win.dcomp_overlay_visual->SetEffect(g_win.dcomp_overlay_effect);

    g_win.dcomp_root->AddVisual(g_win.dcomp_video_visual,   TRUE, nullptr);
    g_win.dcomp_root->AddVisual(g_win.dcomp_main_visual,    TRUE, g_win.dcomp_video_visual);
    g_win.dcomp_root->AddVisual(g_win.dcomp_overlay_visual, TRUE, g_win.dcomp_main_visual);
    g_win.dcomp_device->CreateVisual(&g_win.dcomp_about_visual);
    g_win.dcomp_root->AddVisual(g_win.dcomp_about_visual, TRUE, g_win.dcomp_overlay_visual);
    g_win.dcomp_target->SetRoot(g_win.dcomp_root);
    g_win.dcomp_device->Commit();

    return true;
}

static IDXGISwapChain1* create_swap_chain(int width, int height) {
    if (width <= 0 || height <= 0) return nullptr;

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;

    IDXGISwapChain1* sc = nullptr;
    HRESULT hr = g_win.dxgi_factory->CreateSwapChainForComposition(
        g_win.d3d_device, &desc, nullptr, &sc);
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "CreateSwapChainForComposition failed: 0x{:08x}", hr);
        return nullptr;
    }
    return sc;
}

static void ensure_swap_chain(IDXGISwapChain1*& sc, int& sw, int& sh,
                              IDCompositionVisual* visual, int w, int h) {
    if (w <= 0 || h <= 0) return;
    if (sc && sw == w && sh == h) return;

    if (sc) {
        // Try resize first
        HRESULT hr = sc->ResizeBuffers(2, w, h, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (SUCCEEDED(hr)) {
            sw = w; sh = h;
            return;
        }
        // Resize failed, recreate
        visual->SetContent(nullptr);
        sc->Release();
        sc = nullptr;
    }

    sc = create_swap_chain(w, h);
    if (sc) {
        visual->SetContent(sc);
        sw = w; sh = h;
    }
}

// Create or resize the video swap chain (ALPHA_IGNORE — video has no alpha).
// Must be called under surface_mtx. Commits DComp when content changes.
static void ensure_video_swap_chain(int w, int h) {
    if (w <= 0 || h <= 0) return;
    auto& sc = g_win.video_swap_chain;
    auto& sw = g_win.video_sw;
    auto& sh = g_win.video_sh;
    if (sc && sw == w && sh == h) return;

    if (sc) {
        HRESULT hr = sc->ResizeBuffers(2, w, h, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (SUCCEEDED(hr)) { sw = w; sh = h; return; }
        g_win.dcomp_video_visual->SetContent(nullptr);
        sc->Release(); sc = nullptr;
    }

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width       = static_cast<UINT>(w);
    desc.Height      = static_cast<UINT>(h);
    desc.Format      = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.SwapEffect  = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode   = DXGI_ALPHA_MODE_IGNORE;
    HRESULT hr = g_win.dxgi_factory->CreateSwapChainForComposition(
        g_win.d3d_device, &desc, nullptr, &sc);
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "CreateSwapChainForComposition (video) failed: 0x{:08x}", hr);
        return;
    }
    g_win.dcomp_video_visual->SetContent(sc);
    g_win.dcomp_device->Commit();
    sw = w; sh = h;
}

// Create or resize the pip window's swap chain (HWND-bound, no DComp).
// Must be called under surface_mtx from the render thread.
static void ensure_pip_swap_chain(int w, int h) {
    if (w <= 0 || h <= 0 || !g_win.pip_hwnd) return;
    auto& sc = g_win.pip_swap_chain;
    auto& sw = g_win.pip_sw;
    auto& sh = g_win.pip_sh;
    if (sc && sw == w && sh == h) return;

    if (sc) {
        HRESULT hr = sc->ResizeBuffers(2, w, h, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (SUCCEEDED(hr)) { sw = w; sh = h; return; }
        sc->Release(); sc = nullptr;
    }

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width            = static_cast<UINT>(w);
    desc.Height           = static_cast<UINT>(h);
    desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage      = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount      = 2;
    desc.SwapEffect       = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode        = DXGI_ALPHA_MODE_IGNORE;
    desc.Scaling          = DXGI_SCALING_NONE;  // 1:1 pixel mapping, no stretching
    HRESULT hr = g_win.dxgi_factory->CreateSwapChainForHwnd(
        g_win.d3d_device, g_win.pip_hwnd, &desc, nullptr, nullptr, &sc);
    if (FAILED(hr)) {
        LOG_ERROR(LOG_PLATFORM, "CreateSwapChainForHwnd (pip) failed: 0x{:08x}", hr);
        return;
    }
    // Prevent DXGI from intercepting Alt+Enter on the pip window
    g_win.dxgi_factory->MakeWindowAssociation(g_win.pip_hwnd, DXGI_MWA_NO_ALT_ENTER);
    sw = w; sh = h;
}

static void win_present(const CefAcceleratedPaintInfo& info) {
    HANDLE handle = info.shared_texture_handle;
    if (!handle) return;

    // Open shared texture to query dimensions
    ID3D11Texture2D* src = nullptr;
    HRESULT hr = g_win.d3d_device->OpenSharedResource1(handle,
        __uuidof(ID3D11Texture2D), (void**)&src);
    if (FAILED(hr) || !src) return;

    D3D11_TEXTURE2D_DESC td;
    src->GetDesc(&td);
    int w = static_cast<int>(td.Width);
    int h = static_cast<int>(td.Height);

    std::lock_guard<std::mutex> lock(g_win.surface_mtx);

    // Drop frames during transition (same logic as Wayland)
    if (g_win.transitioning) {
        if (g_win.expected_w <= 0 || (w == g_win.transition_pw && h == g_win.transition_ph)) {
            src->Release();
            return;
        }
        // New frame matches expected size -- end transition
        win_end_transition_locked();
    }

    // Drop oversized buffers
    if (g_win.mpv_pw > 0 && (w > g_win.mpv_pw + 2 || h > g_win.mpv_ph + 2)) {
        src->Release();
        return;
    }

    // 1:1 pixel mapping: swap chain matches CEF buffer size (never stretch)
    ensure_swap_chain(g_win.main_swap_chain, g_win.main_sw, g_win.main_sh,
                      g_win.dcomp_main_visual, w, h);
    if (!g_win.main_swap_chain) { src->Release(); return; }

    ID3D11Texture2D* bb = nullptr;
    g_win.main_swap_chain->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g_win.d3d_context->CopyResource(bb, src);

    // Punch an alpha=0 hole for the mini-player so the mpv video layer shows through
    if (g_win.d3d_context1 && g_win.mini_hole.w > 0) {
        D3D11_RENDER_TARGET_VIEW_DESC rtvDesc = {};
        rtvDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        rtvDesc.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
        ID3D11RenderTargetView* rtv = nullptr;
        if (SUCCEEDED(g_win.d3d_device->CreateRenderTargetView(bb, &rtvDesc, &rtv))) {
            const float clear[4] = {0.0f, 0.0f, 0.0f, 0.0f};
            D3D11_RECT rect = {
                static_cast<LONG>(std::max(0, g_win.mini_hole.x)),
                static_cast<LONG>(std::max(0, g_win.mini_hole.y)),
                static_cast<LONG>(std::min(w, g_win.mini_hole.x + g_win.mini_hole.w)),
                static_cast<LONG>(std::min(h, g_win.mini_hole.y + g_win.mini_hole.h))
            };
            if (rect.right > rect.left && rect.bottom > rect.top)
                g_win.d3d_context1->ClearView(rtv, clear, &rect, 1);
            rtv->Release();
        }
    }

    bb->Release();
    src->Release();

    g_win.main_swap_chain->Present(0, 0);
    g_win.dcomp_device->Commit();
}

static void win_set_mini_player_hole(int x, int y, int w, int h) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    g_win.mini_hole = {x, y, w, h};
}

static void win_store_pip_params(double x, double y, double w, double h, double ar) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (w > 0 && h > 0)
        g_win.pip_params = {true, x, y, w, h, ar};
    else
        g_win.pip_params.active = false;
}

// Recompute and reapply mpv video-zoom / align for the given logical window
// size. Called outside surface_mtx (mpv setters are async and thread-safe).
static void win_reapply_pip_video_pos(const WinState::PipParams& pip,
                                       double win_lw, double win_lh) {
    double video_ar = pip.ar > 0 ? pip.ar
                    : (pip.h > 1e-6 ? pip.w / pip.h : win_lw / win_lh);
    double win_ar   = win_lh > 1e-6 ? win_lw / win_lh : 1.0;

    double natural_lw, natural_lh;
    if (video_ar <= win_ar) { natural_lw = win_lh * video_ar; natural_lh = win_lh; }
    else                    { natural_lw = win_lw; natural_lh = win_lw / video_ar; }

    double scale = std::min(
        natural_lw > 1e-6 ? pip.w / natural_lw : 0.25,
        natural_lh > 1e-6 ? pip.h / natural_lh : 0.25
    );
    g_mpv.SetVideoZoom(std::log2(scale));

    double cx      = pip.x + pip.w / 2.0;
    double cy      = pip.y + pip.h / 2.0;
    double video_lw = natural_lw * scale;
    double video_lh = natural_lh * scale;
    double denom_x  = win_lw - video_lw;
    double denom_y  = win_lh - video_lh;
    double ax = denom_x > 1e-6 ? 2.0 * (cx - win_lw / 2.0) / denom_x : 0.0;
    double ay = denom_y > 1e-6 ? 2.0 * (cy - win_lh / 2.0) / denom_y : 0.0;
    g_mpv.SetVideoAlignX(std::max(-1.0, std::min(1.0, ax)));
    g_mpv.SetVideoAlignY(std::max(-1.0, std::min(1.0, ay)));
}

static void win_present_software(const CefRenderHandler::RectList&, const void*, int, int) {
    // Software fallback not implemented for Windows
}

// =====================================================================
// Present CEF shared texture -- overlay browser
// =====================================================================

static void win_overlay_present(const CefAcceleratedPaintInfo& info) {
    HANDLE handle = info.shared_texture_handle;
    if (!handle) return;

    ID3D11Texture2D* src = nullptr;
    HRESULT hr = g_win.d3d_device->OpenSharedResource1(handle,
        __uuidof(ID3D11Texture2D), (void**)&src);
    if (FAILED(hr) || !src) return;

    D3D11_TEXTURE2D_DESC td;
    src->GetDesc(&td);
    int w = static_cast<int>(td.Width);
    int h = static_cast<int>(td.Height);

    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (!g_win.overlay_visible) { src->Release(); return; }

    ensure_swap_chain(g_win.overlay_swap_chain, g_win.overlay_sw, g_win.overlay_sh,
                      g_win.dcomp_overlay_visual, w, h);
    if (!g_win.overlay_swap_chain) { src->Release(); return; }

    ID3D11Texture2D* bb = nullptr;
    g_win.overlay_swap_chain->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g_win.d3d_context->CopyResource(bb, src);
    bb->Release();
    src->Release();

    g_win.overlay_swap_chain->Present(0, 0);
    g_win.dcomp_device->Commit();
}

static void win_overlay_present_software(const CefRenderHandler::RectList&, const void*, int, int) {}

static void win_overlay_resize(int, int, int pw, int ph) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (!g_win.overlay_swap_chain) return;
    ensure_swap_chain(g_win.overlay_swap_chain, g_win.overlay_sw, g_win.overlay_sh,
                      g_win.dcomp_overlay_visual, pw, ph);
    g_win.dcomp_device->Commit();
}

// =====================================================================
// Overlay visibility + fade
// =====================================================================

static void win_set_overlay_visible(bool visible) {
    {
        std::lock_guard<std::mutex> lock(g_win.surface_mtx);
        g_win.overlay_visible = visible;
        if (!visible && g_win.dcomp_overlay_visual) {
            g_win.dcomp_overlay_visual->SetContent(nullptr);
            if (g_win.overlay_swap_chain) {
                g_win.overlay_swap_chain->Release();
                g_win.overlay_swap_chain = nullptr;
                g_win.overlay_sw = 0;
                g_win.overlay_sh = 0;
            }
            g_win.dcomp_device->Commit();
        }
    }

    // Route keyboard focus to the newly-active browser. Without this, CEF
    // thinks the just-activated browser has no window focus, so text inputs
    // don't show a caret and focus rings don't render. Matches the "active
    // tab" semantics: only one browser at a time holds focus.
    auto main = g_web_browser ? g_web_browser->browser() : nullptr;
    auto ovl  = g_overlay_browser ? g_overlay_browser->browser() : nullptr;
    if (visible) {
        if (main) main->GetHost()->SetFocus(false);
        if (ovl)  ovl->GetHost()->SetFocus(true);
    } else {
        if (ovl)  ovl->GetHost()->SetFocus(false);
        if (main) main->GetHost()->SetFocus(true);
    }
}

// =====================================================================
// Present CEF shared texture -- about browser
// =====================================================================

static void win_about_present(const CefAcceleratedPaintInfo& info) {
    HANDLE handle = info.shared_texture_handle;
    if (!handle) return;

    ID3D11Texture2D* src = nullptr;
    HRESULT hr = g_win.d3d_device->OpenSharedResource1(handle,
        __uuidof(ID3D11Texture2D), (void**)&src);
    if (FAILED(hr) || !src) return;

    D3D11_TEXTURE2D_DESC td;
    src->GetDesc(&td);
    int w = static_cast<int>(td.Width);
    int h = static_cast<int>(td.Height);

    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (!g_win.about_visible) { src->Release(); return; }

    ensure_swap_chain(g_win.about_swap_chain, g_win.about_sw, g_win.about_sh,
                      g_win.dcomp_about_visual, w, h);
    if (!g_win.about_swap_chain) { src->Release(); return; }

    ID3D11Texture2D* bb = nullptr;
    g_win.about_swap_chain->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g_win.d3d_context->CopyResource(bb, src);
    bb->Release();
    src->Release();

    g_win.about_swap_chain->Present(0, 0);
    g_win.dcomp_device->Commit();
}

static void win_about_present_software(const CefRenderHandler::RectList&, const void*, int, int) {}

static void win_about_resize(int, int, int pw, int ph) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (!g_win.about_swap_chain) return;
    ensure_swap_chain(g_win.about_swap_chain, g_win.about_sw, g_win.about_sh,
                      g_win.dcomp_about_visual, pw, ph);
    g_win.dcomp_device->Commit();
}

static void win_set_about_visible(bool visible) {
    {
        std::lock_guard<std::mutex> lock(g_win.surface_mtx);
        g_win.about_visible = visible;
        if (!visible && g_win.dcomp_about_visual) {
            g_win.dcomp_about_visual->SetContent(nullptr);
            if (g_win.about_swap_chain) {
                g_win.about_swap_chain->Release();
                g_win.about_swap_chain = nullptr;
                g_win.about_sw = 0;
                g_win.about_sh = 0;
            }
            g_win.dcomp_device->Commit();
        }
    }

    if (visible) {
        auto main = g_web_browser ? g_web_browser->browser() : nullptr;
        auto ovl  = g_overlay_browser ? g_overlay_browser->browser() : nullptr;
        if (main) main->GetHost()->SetFocus(false);
        if (ovl)  ovl->GetHost()->SetFocus(false);
    }
}

// Animate overlay opacity from 1.0 to 0.0 over fade_sec, then hide.
// Runs on a detached thread -- finite UI animation.
static void win_fade_overlay(float fade_sec,
                             std::function<void()> on_fade_start,
                             std::function<void()> on_complete) {
    if (!g_win.dcomp_overlay_visual) {
        win_set_overlay_visible(false);
        if (on_fade_start) on_fade_start();
        if (on_complete) on_complete();
        return;
    }

    std::thread([fade_sec,
                 on_fade_start = std::move(on_fade_start),
                 on_complete = std::move(on_complete)]() {
        if (on_fade_start) on_fade_start();

        int fps = g_display_hz.load(std::memory_order_relaxed);
        int total_frames = static_cast<int>(fade_sec * fps);
        if (total_frames < 1) total_frames = 1;
        auto frame_duration = std::chrono::microseconds(1000000 / fps);

        for (int i = 1; i <= total_frames; i++) {
            float t = static_cast<float>(i) / total_frames;
            float opacity = 1.0f - t;

            {
                std::lock_guard<std::mutex> lock(g_win.surface_mtx);
                if (!g_win.overlay_visible || !g_win.dcomp_overlay_visual) break;
                g_win.dcomp_overlay_effect->SetOpacity(opacity);
                g_win.dcomp_device->Commit();
            }
            std::this_thread::sleep_for(frame_duration);
        }

        win_set_overlay_visible(false);

        // Reset opacity for next show
        {
            std::lock_guard<std::mutex> lock(g_win.surface_mtx);
            if (g_win.dcomp_overlay_visual) {
                g_win.dcomp_overlay_effect->SetOpacity(1.0f);
                g_win.dcomp_device->Commit();
            }
        }
        if (on_complete) on_complete();
    }).detach();
}

// =====================================================================
// Resize + fullscreen transitions
// =====================================================================

static void update_surface_size_locked(int lw, int lh, int pw, int ph) {
    if (g_win.transitioning) {
        g_win.pending_lw = lw;
        g_win.pending_lh = lh;
    }
    // For DComp, the swap chain sizes to match CEF's buffer, not the window.
    // We just track mpv's physical size for oversized-buffer rejection.
    g_win.mpv_pw = pw;
    g_win.mpv_ph = ph;
}

static void win_resize(int lw, int lh, int pw, int ph) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    update_surface_size_locked(lw, lh, pw, ph);
}

static void win_begin_transition_locked() {
    g_win.transitioning = true;
    g_win.transition_pw = g_win.mpv_pw;
    g_win.transition_ph = g_win.mpv_ph;
    g_win.pending_lw = 0;
    g_win.pending_lh = 0;

    // Detach main visual content to avoid stale frames
    if (g_win.dcomp_main_visual) {
        g_win.dcomp_main_visual->SetContent(nullptr);
        if (g_win.main_swap_chain) {
            g_win.main_swap_chain->Release();
            g_win.main_swap_chain = nullptr;
            g_win.main_sw = 0;
            g_win.main_sh = 0;
        }
        g_win.dcomp_device->Commit();
    }
}

static void win_end_transition_locked() {
    g_win.transitioning = false;
    g_win.expected_w = 0;
    g_win.expected_h = 0;
    g_win.pending_lw = 0;
    g_win.pending_lh = 0;
}

static void win_begin_transition() {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    win_begin_transition_locked();
}

static void win_end_transition() {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    win_end_transition_locked();
}

static bool win_in_transition() {
    return g_win.transitioning;
}

static void win_set_expected_size(int w, int h) {
    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
    if (g_win.transitioning && w == g_win.transition_pw && h == g_win.transition_ph)
        return;
    g_win.expected_w = w;
    g_win.expected_h = h;
}

// =====================================================================
// Fullscreen
// =====================================================================

static void win_set_fullscreen(bool fullscreen) {
    if (!g_mpv.IsValid()) return;
    if (g_win.win_is_fullscreen == fullscreen) return;

    { std::lock_guard<std::mutex> lock(g_win.surface_mtx); win_begin_transition_locked(); }

    g_win.win_is_fullscreen = fullscreen;

    HWND hwnd = g_win.mpv_hwnd;
    if (hwnd) {
        if (fullscreen) {
            g_win.saved_window_style = GetWindowLong(hwnd, GWL_STYLE);
            GetWindowRect(hwnd, &g_win.saved_window_rect);
            SetWindowLong(hwnd, GWL_STYLE, WS_VISIBLE);
            HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            MONITORINFO mi{}; mi.cbSize = sizeof(mi);
            GetMonitorInfo(mon, &mi);
            SetWindowPos(hwnd, HWND_TOP,
                mi.rcMonitor.left, mi.rcMonitor.top,
                mi.rcMonitor.right  - mi.rcMonitor.left,
                mi.rcMonitor.bottom - mi.rcMonitor.top,
                SWP_FRAMECHANGED | SWP_NOACTIVATE);
        } else {
            SetWindowLong(hwnd, GWL_STYLE, g_win.saved_window_style);
            RECT& r = g_win.saved_window_rect;
            SetWindowPos(hwnd, nullptr,
                r.left, r.top, r.right - r.left, r.bottom - r.top,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER);
            if (g_win.saved_window_style & WS_MAXIMIZE)
                ShowWindow(hwnd, SW_MAXIMIZE);
        }
    }
    g_mpv.SetFullscreen(fullscreen);
}

static void win_toggle_fullscreen() {
    win_set_fullscreen(!g_win.win_is_fullscreen);
}

// =====================================================================
// Scale + content size
// =====================================================================

static float win_get_scale() {
    if (g_win.mpv_hwnd) {
        UINT dpi = GetDpiForWindow(g_win.mpv_hwnd);
        if (dpi > 0) {
            g_win.cached_scale = static_cast<float>(dpi) / 96.0f;
            return g_win.cached_scale;
        }
    }
    if (g_win.cached_scale > 0) return g_win.cached_scale;
    UINT dpi = GetDpiForSystem();
    if (dpi > 0) return static_cast<float>(dpi) / 96.0f;
    return 1.0f;
}

// =====================================================================
// Input thread: transparent child HWND -> CEF events
// =====================================================================

static void win_set_idle_inhibit(IdleInhibitLevel level) {
    UINT flags = ES_CONTINUOUS;
    switch (level) {
    case IdleInhibitLevel::Display:
        flags |= ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
        break;
    case IdleInhibitLevel::System:
        flags |= ES_SYSTEM_REQUIRED;
        break;
    case IdleInhibitLevel::None:
        // ES_CONTINUOUS alone releases the inhibit
        break;
    }
    SetThreadExecutionState(flags);
}

// =====================================================================
// GL helpers: proc address, extension loading, FBO management
// =====================================================================

static void* gl_get_proc_address(void*, const char* name) {
    void* p = reinterpret_cast<void*>(wglGetProcAddress(name));
    if (p && p != reinterpret_cast<void*>(1) && p != reinterpret_cast<void*>(2) &&
        p != reinterpret_cast<void*>(3) && p != reinterpret_cast<void*>(-1))
        return p;
    static HMODULE lib = LoadLibraryA("opengl32.dll");
    return lib ? reinterpret_cast<void*>(GetProcAddress(lib, name)) : nullptr;
}

static bool load_gl_extensions() {
    gl_GenFramebuffers_      = (decltype(gl_GenFramebuffers_))     wglGetProcAddress("glGenFramebuffers");
    gl_DeleteFramebuffers_   = (decltype(gl_DeleteFramebuffers_))  wglGetProcAddress("glDeleteFramebuffers");
    gl_BindFramebuffer_      = (decltype(gl_BindFramebuffer_))     wglGetProcAddress("glBindFramebuffer");
    gl_FramebufferTexture2D_ = (decltype(gl_FramebufferTexture2D_))wglGetProcAddress("glFramebufferTexture2D");
    gl_CheckFramebufferStatus_ = (decltype(gl_CheckFramebufferStatus_))wglGetProcAddress("glCheckFramebufferStatus");
    if (!gl_GenFramebuffers_ || !gl_DeleteFramebuffers_ || !gl_BindFramebuffer_ ||
        !gl_FramebufferTexture2D_ || !gl_CheckFramebufferStatus_) {
        LOG_ERROR(LOG_PLATFORM, "Failed to load GL FBO extensions");
        return false;
    }
    return true;
}

// Destroy and recreate the GL FBO + color texture at the given size.
// Call with w=0,h=0 to just destroy. Render-thread-only, no lock needed.
static void recreate_fbo(int w, int h) {
    if (gl_BindFramebuffer_) gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);
    if (g_win.gl_fbo) {
        gl_DeleteFramebuffers_(1, &g_win.gl_fbo);
        g_win.gl_fbo = 0;
    }
    if (g_win.gl_color_tex) {
        glDeleteTextures(1, &g_win.gl_color_tex);
        g_win.gl_color_tex = 0;
    }
    g_win.fbo_w = 0;
    g_win.fbo_h = 0;
    if (w <= 0 || h <= 0) return;

    glGenTextures(1, &g_win.gl_color_tex);
    glBindTexture(GL_TEXTURE_2D, g_win.gl_color_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glBindTexture(GL_TEXTURE_2D, 0);

    gl_GenFramebuffers_(1, &g_win.gl_fbo);
    gl_BindFramebuffer_(GL_FRAMEBUFFER, g_win.gl_fbo);
    gl_FramebufferTexture2D_(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                             GL_TEXTURE_2D, g_win.gl_color_tex, 0);
    GLenum status = gl_CheckFramebufferStatus_(GL_FRAMEBUFFER);
    gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);

    if (status != GL_FRAMEBUFFER_COMPLETE) {
        LOG_ERROR(LOG_PLATFORM, "FBO incomplete (status=0x{:04x})", status);
        recreate_fbo(0, 0);
        return;
    }
    g_win.fbo_w = w;
    g_win.fbo_h = h;
    g_win.pixel_buf.resize(static_cast<size_t>(w) * h * 4);
}

// Same as recreate_fbo but for the pip GL FBO. Render-thread-only.
static void recreate_pip_fbo(int w, int h) {
    if (gl_BindFramebuffer_) gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);
    if (g_win.pip_gl_fbo) {
        gl_DeleteFramebuffers_(1, &g_win.pip_gl_fbo);
        g_win.pip_gl_fbo = 0;
    }
    if (g_win.pip_gl_color_tex) {
        glDeleteTextures(1, &g_win.pip_gl_color_tex);
        g_win.pip_gl_color_tex = 0;
    }
    g_win.pip_fbo_w = 0;
    g_win.pip_fbo_h = 0;
    if (w <= 0 || h <= 0) return;

    glGenTextures(1, &g_win.pip_gl_color_tex);
    glBindTexture(GL_TEXTURE_2D, g_win.pip_gl_color_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glBindTexture(GL_TEXTURE_2D, 0);

    gl_GenFramebuffers_(1, &g_win.pip_gl_fbo);
    gl_BindFramebuffer_(GL_FRAMEBUFFER, g_win.pip_gl_fbo);
    gl_FramebufferTexture2D_(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                             GL_TEXTURE_2D, g_win.pip_gl_color_tex, 0);
    GLenum status = gl_CheckFramebufferStatus_(GL_FRAMEBUFFER);
    gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);

    if (status != GL_FRAMEBUFFER_COMPLETE) {
        LOG_ERROR(LOG_PLATFORM, "Pip FBO incomplete (status=0x{:04x})", status);
        recreate_pip_fbo(0, 0);
        return;
    }
    g_win.pip_fbo_w = w;
    g_win.pip_fbo_h = h;
    g_win.pip_pixel_buf.resize(static_cast<size_t>(w) * h * 4);
}

static void render_thread_func(std::promise<bool> init_promise) {
    if (!wglMakeCurrent(g_win.gl_hdc, g_win.gl_hglrc)) {
        LOG_ERROR(LOG_PLATFORM, "render thread: wglMakeCurrent failed (0x{:08x})", GetLastError());
        init_promise.set_value(false);
        return;
    }

    if (!load_gl_extensions()) {
        init_promise.set_value(false);
        return;
    }

    mpv_opengl_init_params gl_init{};
    gl_init.get_proc_address = gl_get_proc_address;

    if (!g_win.renderer.init(g_mpv.Get(), &gl_init)) {
        init_promise.set_value(false);
        return;
    }

    // Set update callback — signal render_wake whenever mpv has a new frame.
    g_win.renderer.set_update_callback([](void*) {
        g_win.render_wake.signal();
    }, nullptr);

    init_promise.set_value(true);

    HANDLE handles[2] = {
        static_cast<HANDLE>(g_win.render_wake.handle()),
        static_cast<HANDLE>(g_win.render_stop.handle())
    };

    while (true) {
        WaitForMultipleObjects(2, handles, FALSE, INFINITE);
        g_win.render_wake.drain();

        // Check for stop signal
        if (WaitForSingleObject(static_cast<HANDLE>(g_win.render_stop.handle()), 0) == WAIT_OBJECT_0)
            break;

        // ── Phase 2: Closing — tear down pip resources then ack ───────────────
        if (g_win.pip_phase.load(std::memory_order_acquire) == 2) {
            recreate_pip_fbo(0, 0);
            std::lock_guard<std::mutex> lock(g_win.surface_mtx);
            if (g_win.pip_swap_chain) {
                g_win.pip_swap_chain->Release();
                g_win.pip_swap_chain = nullptr;
            }
            g_win.pip_sw = 0; g_win.pip_sh = 0;
            g_win.pip_phase.store(0, std::memory_order_release);
            if (g_win.pip_close_ack) {
                g_win.pip_close_ack->set_value();
                g_win.pip_close_ack = nullptr;
            }
            continue;
        }

        // ── Phase 1: Active — render to pip swap chain ───────────────────────
        if (g_win.pip_phase.load(std::memory_order_acquire) == 1) {
            int pw = g_win.pending_pip_w.load(std::memory_order_relaxed);
            int ph = g_win.pending_pip_h.load(std::memory_order_relaxed);
            if (pw > 0 && ph > 0 && (pw != g_win.pip_fbo_w || ph != g_win.pip_fbo_h))
                recreate_pip_fbo(pw, ph);

            if (g_win.pip_fbo_w <= 0 || g_win.pip_fbo_h <= 0) continue;

            int fw = g_win.pip_fbo_w, fh = g_win.pip_fbo_h;
            if (!g_win.renderer.render(static_cast<int>(g_win.pip_gl_fbo), fw, fh))
                continue;

            gl_BindFramebuffer_(GL_FRAMEBUFFER, g_win.pip_gl_fbo);
            glReadPixels(0, 0, fw, fh, GL_BGRA, GL_UNSIGNED_BYTE, g_win.pip_pixel_buf.data());
            gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);

            // HWND swap chains use Y-down (screen) coordinates, so row 0 maps
            // to the top of the window. CreateSwapChainForComposition (DComp)
            // uses Y-up internally, so the flip_y=1 pre-flip that mpv applies
            // corrects for that. For a plain HWND swap chain we need to reverse
            // row order after readback to undo the unwanted pre-flip.
            {
                const size_t stride = static_cast<size_t>(fw) * 4;
                uint8_t* buf = g_win.pip_pixel_buf.data();
                for (int row = 0; row < fh / 2; ++row) {
                    std::swap_ranges(buf + row * stride,
                                     buf + row * stride + stride,
                                     buf + (fh - 1 - row) * stride);
                }
            }

            g_win.renderer.report_swap();

            {
                std::lock_guard<std::mutex> lock(g_win.surface_mtx);
                ensure_pip_swap_chain(fw, fh);
                if (!g_win.pip_swap_chain) continue;

                ID3D11Texture2D* bb = nullptr;
                HRESULT hr = g_win.pip_swap_chain->GetBuffer(
                    0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&bb));
                if (SUCCEEDED(hr) && bb) {
                    g_win.d3d_context->UpdateSubresource(
                        bb, 0, nullptr,
                        g_win.pip_pixel_buf.data(), static_cast<UINT>(fw * 4), 0);
                    bb->Release();
                }
                g_win.pip_swap_chain->Present(0, 0);
            }
            continue;
        }

        // ── Phase 0: Main — render to main swap chain (DComp) ────────────────

        // Resize FBO if window changed size
        int fw = g_win.pending_fbo_w.load(std::memory_order_relaxed);
        int fh = g_win.pending_fbo_h.load(std::memory_order_relaxed);
        if (fw != g_win.fbo_w || fh != g_win.fbo_h) {
            if (fw > 0 && fh > 0)
                recreate_fbo(fw, fh);
        }

        if (g_win.fbo_w <= 0 || g_win.fbo_h <= 0) continue;

        fw = g_win.fbo_w;
        fh = g_win.fbo_h;

        if (!g_win.renderer.render(static_cast<int>(g_win.gl_fbo), fw, fh))
            continue;

        // Readback. flip_y=1 causes the same double-inversion for D3D11 upload
        // as for the HWND swap chain (see pip path above), so reverse row order.
        gl_BindFramebuffer_(GL_FRAMEBUFFER, g_win.gl_fbo);
        glReadPixels(0, 0, fw, fh, GL_BGRA, GL_UNSIGNED_BYTE, g_win.pixel_buf.data());
        gl_BindFramebuffer_(GL_FRAMEBUFFER, 0);

        {
            const size_t stride = static_cast<size_t>(fw) * 4;
            uint8_t* buf = g_win.pixel_buf.data();
            for (int row = 0; row < fh / 2; ++row) {
                std::swap_ranges(buf + row * stride,
                                 buf + row * stride + stride,
                                 buf + (fh - 1 - row) * stride);
            }
        }

        g_win.renderer.report_swap();

        // Upload to D3D11 video swap chain
        {
            std::lock_guard<std::mutex> lock(g_win.surface_mtx);
            ensure_video_swap_chain(fw, fh);
            if (!g_win.video_swap_chain) continue;

            ID3D11Texture2D* bb = nullptr;
            HRESULT hr = g_win.video_swap_chain->GetBuffer(
                0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&bb));
            if (SUCCEEDED(hr) && bb) {
                g_win.d3d_context->UpdateSubresource(
                    bb, 0, nullptr,
                    g_win.pixel_buf.data(), static_cast<UINT>(fw * 4), 0);
                bb->Release();
            }
            g_win.video_swap_chain->Present(0, 0);
            g_win.dcomp_device->Commit();
        }
    }

    // Defensive: if render_stop fires while close is still pending, fulfill the ack
    // so win_close_detached_pip doesn't deadlock (shouldn't happen in normal shutdown
    // since win_cleanup calls win_close_detached_pip first, but guard anyway).
    {
        std::lock_guard<std::mutex> lock(g_win.surface_mtx);
        if (g_win.pip_close_ack) {
            g_win.pip_close_ack->set_value();
            g_win.pip_close_ack = nullptr;
        }
        if (g_win.pip_swap_chain) {
            g_win.pip_swap_chain->Release();
            g_win.pip_swap_chain = nullptr;
        }
    }
    // Cleanup (still owns the GL context)
    recreate_pip_fbo(0, 0);
    recreate_fbo(0, 0);
    g_win.renderer.free();
    wglMakeCurrent(nullptr, nullptr);
}

// =====================================================================
// Pip window WndProc and message-pump thread
// =====================================================================

static LRESULT CALLBACK pip_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_SIZE:
        if (wParam != SIZE_MINIMIZED) {
            int pw = LOWORD(lParam), ph = HIWORD(lParam);
            if (pw > 0 && ph > 0) {
                g_win.pending_pip_w.store(pw, std::memory_order_relaxed);
                g_win.pending_pip_h.store(ph, std::memory_order_relaxed);
                g_win.render_wake.signal();
            }
        }
        return 0;

    case WM_KEYDOWN:
        switch (wParam) {
        case VK_ESCAPE:
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
            return 0;
        case VK_SPACE:
            g_mpv.TogglePause();
            return 0;
        }
        break;

    case WM_NCHITTEST: {
        // Make the entire client area draggable; borders handled by DefWindowProc.
        LRESULT hit = DefWindowProcW(hwnd, msg, wParam, lParam);
        if (hit == HTCLIENT) return HTCAPTION;
        return hit;
    }

    case WM_NCLBUTTONDBLCLK:
        // Double-click anywhere → close pip.
        PostMessageW(hwnd, WM_CLOSE, 0, 0);
        return 0;

    case WM_CLOSE:
        // User closed the window (title bar X, Alt+F4, Esc, or double-click).
        // Clear pip_hwnd/tid before notifying main window so that
        // win_close_detached_pip (which runs on a background thread) never
        // posts WM_APP_PIP_DESTROY back to an already-destroyed HWND.
        g_win.pip_hwnd = nullptr;
        g_win.pip_window_tid = 0;
        PostMessageW(g_win.mpv_hwnd, WM_APP_PIP_CLOSED, 0, 0);
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }

    // WM_APP_PIP_DESTROY: win_close_detached_pip triggers this to destroy us
    if (msg == WM_APP_PIP_DESTROY) {
        DestroyWindow(hwnd);
        return 0;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void win_pip_thread_func(int initial_w, int initial_h) {
    constexpr DWORD kPipStyle   = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME;
    constexpr DWORD kPipExStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW;

    RECT wr{0, 0, initial_w, initial_h};
    UINT dpi = GetDpiForSystem();
    AdjustWindowRectExForDpi(&wr, kPipStyle, FALSE, kPipExStyle, dpi);
    int win_w = wr.right - wr.left;
    int win_h = wr.bottom - wr.top;

    // Position bottom-right of the main window's monitor
    HMONITOR mon = MonitorFromWindow(g_win.mpv_hwnd, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi{}; mi.cbSize = sizeof(mi);
    GetMonitorInfoW(mon, &mi);
    int pos_x = mi.rcWork.right  - win_w - 20;
    int pos_y = mi.rcWork.bottom - win_h - 20;

    HWND hwnd = CreateWindowExW(
        kPipExStyle,
        L"JellyfinDesktopPip", L"Picture in Picture",
        kPipStyle,
        pos_x, pos_y, win_w, win_h,
        nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);

    if (!hwnd) {
        LOG_ERROR(LOG_PLATFORM, "CreateWindowExW (pip) failed: 0x{:08x}", GetLastError());
        return;
    }

    g_win.pip_hwnd       = hwnd;
    g_win.pip_window_tid = GetCurrentThreadId();
    g_win.pending_pip_w.store(initial_w, std::memory_order_relaxed);
    g_win.pending_pip_h.store(initial_h, std::memory_order_relaxed);

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    g_win.render_wake.signal();

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

// =====================================================================
// Main window WndProc and message-pump thread
// =====================================================================

static LRESULT CALLBACK our_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_SIZE:
        if (wParam != SIZE_MINIMIZED) {
            int pw = LOWORD(lParam);
            int ph = HIWORD(lParam);
            if (pw > 0 && ph > 0) {
                float scale = g_win.cached_scale > 0 ? g_win.cached_scale : 1.0f;
                int lw = static_cast<int>(pw / scale);
                int lh = static_cast<int>(ph / scale);

                // Detect FS change by window style
                LONG style = GetWindowLong(hwnd, GWL_STYLE);
                bool fs_by_style = !(style & WS_OVERLAPPEDWINDOW);

                bool prev_max;
                WinState::PipParams pip;
                {
                    std::lock_guard<std::mutex> lock(g_win.surface_mtx);
                    if (fs_by_style != g_win.was_fullscreen) {
                        if (!g_win.transitioning) win_begin_transition_locked();
                        else                       win_end_transition_locked();
                        g_win.was_fullscreen = fs_by_style;
                    } else if (g_win.transitioning) {
                        win_end_transition_locked();
                    }
                    update_surface_size_locked(lw, lh, pw, ph);
                    prev_max = g_win.was_maximized;
                    g_win.was_maximized = (wParam == SIZE_MAXIMIZED);
                    pip = g_win.pip_params;
                    if (pip.active && !prev_max) {
                        g_win.mini_hole = {
                            static_cast<int>(std::round(pip.x * scale)),
                            static_cast<int>(std::round(pip.y * scale)),
                            static_cast<int>(std::round(pip.w * scale)),
                            static_cast<int>(std::round(pip.h * scale))
                        };
                    }
                }

                input::windows::resize_to_parent(pw, ph);

                // Notify render thread of new size
                g_win.pending_fbo_w.store(pw, std::memory_order_relaxed);
                g_win.pending_fbo_h.store(ph, std::memory_order_relaxed);
                g_win.render_wake.signal();

                mpv::set_window_pixels(pw, ph);
                // Only update maximized state when not in win_is_fullscreen;
                // preserves pre-fullscreen state for the FULLSCREEN event handler.
                if (!g_win.win_is_fullscreen)
                    mpv::set_window_maximized(wParam == SIZE_MAXIMIZED);

                if (pip.active && !g_win.transitioning && !prev_max)
                    win_reapply_pip_video_pos(pip, lw, lh);
            }
        }
        return 0;

    case WM_DPICHANGED: {
        UINT new_dpi = HIWORD(wParam);
        g_win.cached_scale = static_cast<float>(new_dpi) / 96.0f;
        auto* r = reinterpret_cast<const RECT*>(lParam);
        SetWindowPos(hwnd, nullptr,
                     r->left, r->top, r->right - r->left, r->bottom - r->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }

    case WM_ERASEBKGND:
        return 1;  // DComp handles painting; suppress default erase

    case WM_PAINT:
        ValidateRect(hwnd, nullptr);
        return 0;

    case WM_CLOSE:
        ShowWindow(hwnd, SW_HIDE);
        initiate_shutdown();
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }

    // User closed pip window: notify JS and initiate C++ cleanup
    if (msg == WM_APP_PIP_CLOSED) {
        if (g_web_browser)
            g_web_browser->execJs("if(window._nativeOnPipWindowClosed)window._nativeOnPipWindowClosed()");
        // win_close_detached_pip blocks waiting for the render thread ack, so
        // we must not call it on the window message pump thread.
        std::thread([]() { win_close_detached_pip(false); }).detach();
        return 0;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void main_window_thread_func(std::promise<HWND> hwnd_promise,
                                    int x, int y, int w, int h, bool is_maximized) {
    g_win.main_window_tid = GetCurrentThreadId();

    HWND hwnd = CreateWindowExW(
        0, L"JellyfinDesktop", L"Jellyfin Desktop",
        WS_OVERLAPPEDWINDOW,
        x, y, w, h,
        nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);

    if (!hwnd) {
        LOG_ERROR(LOG_PLATFORM, "CreateWindowExW failed: 0x{:08x}", GetLastError());
        hwnd_promise.set_value(nullptr);
        return;
    }
    ShowWindow(hwnd, is_maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
    UpdateWindow(hwnd);
    hwnd_promise.set_value(hwnd);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

// =====================================================================
// Platform interface
// =====================================================================

static void win_early_init() {
    // Register JellyfinDesktop — the main application window class
    WNDCLASSEXW wc = {};
    wc.cbSize        = sizeof(wc);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = our_wndproc;
    wc.hInstance     = GetModuleHandleW(nullptr);
    wc.hIcon         = LoadIconW(wc.hInstance, L"IDI_ICON1");
    wc.hCursor       = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); // IDC_ARROW
    wc.hbrBackground = nullptr;
    wc.lpszClassName = L"JellyfinDesktop";
    RegisterClassExW(&wc);

    // Register JellyfinDesktopGL — hidden 1×1 window for WGL context.
    // CS_OWNDC gives each window a persistent DC (no GetDC/ReleaseDC per call).
    WNDCLASSEXW wc_gl = {};
    wc_gl.cbSize        = sizeof(wc_gl);
    wc_gl.style         = CS_OWNDC;
    wc_gl.lpfnWndProc   = DefWindowProcW;
    wc_gl.hInstance     = GetModuleHandleW(nullptr);
    wc_gl.lpszClassName = L"JellyfinDesktopGL";
    RegisterClassExW(&wc_gl);

    // Register JellyfinDesktopPip — detached always-on-top pip window.
    WNDCLASSEXW wc_pip = {};
    wc_pip.cbSize        = sizeof(wc_pip);
    wc_pip.style         = CS_HREDRAW | CS_VREDRAW;
    wc_pip.lpfnWndProc   = pip_wndproc;
    wc_pip.hInstance     = GetModuleHandleW(nullptr);
    wc_pip.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    wc_pip.lpszClassName = L"JellyfinDesktopPip";
    RegisterClassExW(&wc_pip);
}

static bool win_init(mpv_handle* /*mpv*/) {
    // Read saved window geometry
    const auto& geom = Settings::instance().windowGeometry();
    using WG = Settings::WindowGeometry;
    int pw = geom.width  > 0 ? geom.width  : WG::kDefaultPhysicalWidth;
    int ph = geom.height > 0 ? geom.height : WG::kDefaultPhysicalHeight;
    int wx = geom.x >= 0 ? geom.x : -1;
    int wy = geom.y >= 0 ? geom.y : -1;
    win_clamp_window_geometry(&pw, &ph, &wx, &wy);

    // Spin up the main window thread (owns HWND + message loop)
    std::promise<HWND> hwnd_promise;
    auto hwnd_future = hwnd_promise.get_future();
    g_win.main_window_thread = std::thread(main_window_thread_func,
        std::move(hwnd_promise), wx, wy, pw, ph, geom.maximized);
    g_win.mpv_hwnd = hwnd_future.get();
    if (!g_win.mpv_hwnd) {
        LOG_ERROR(LOG_PLATFORM, "Failed to create main window");
        return false;
    }

    // Seed scale from the window's actual DPI
    g_win.cached_scale = win_get_scale();

    // DWM transparency — required for DComp premultiplied alpha visuals
    MARGINS margins = { -1, -1, -1, -1 };
    DwmExtendFrameIntoClientArea(g_win.mpv_hwnd, &margins);

    if (!init_d3d()) return false;
    if (!init_dcomp()) return false;

    // Seed was_fullscreen and was_maximized before any WM_SIZE arrives
    {
        LONG style = GetWindowLong(g_win.mpv_hwnd, GWL_STYLE);
        g_win.was_fullscreen = !(style & WS_OVERLAPPEDWINDOW);
        WINDOWPLACEMENT wp{};
        wp.length = sizeof(wp);
        if (GetWindowPlacement(g_win.mpv_hwnd, &wp))
            g_win.was_maximized = (wp.showCmd == SW_SHOWMAXIMIZED);
    }

    // Publish initial window size so main.cpp can skip the VO wait loop
    RECT cr{};
    GetClientRect(g_win.mpv_hwnd, &cr);
    int init_pw = cr.right  > 0 ? cr.right  : pw;
    int init_ph = cr.bottom > 0 ? cr.bottom : ph;
    mpv::set_window_pixels(init_pw, init_ph);
    g_win.pending_fbo_w.store(init_pw, std::memory_order_relaxed);
    g_win.pending_fbo_h.store(init_ph, std::memory_order_relaxed);

    // Create a hidden 1×1 window for the WGL context (CS_OWNDC class)
    g_win.gl_hwnd = CreateWindowExW(0, L"JellyfinDesktopGL", nullptr,
        WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!g_win.gl_hwnd) {
        LOG_ERROR(LOG_PLATFORM, "Failed to create GL helper window: 0x{:08x}", GetLastError());
        return false;
    }
    g_win.gl_hdc = GetDC(g_win.gl_hwnd);  // CS_OWNDC: persists for lifetime of window

    // Set pixel format
    PIXELFORMATDESCRIPTOR pfd = {};
    pfd.nSize      = sizeof(pfd);
    pfd.nVersion   = 1;
    pfd.dwFlags    = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    pfd.iPixelType = PFD_TYPE_RGBA;
    pfd.cColorBits = 32;
    pfd.cDepthBits = 24;
    pfd.iLayerType = PFD_MAIN_PLANE;
    int fmt = ChoosePixelFormat(g_win.gl_hdc, &pfd);
    if (!fmt || !SetPixelFormat(g_win.gl_hdc, fmt, &pfd)) {
        LOG_ERROR(LOG_PLATFORM, "SetPixelFormat failed: 0x{:08x}", GetLastError());
        return false;
    }

    // Create legacy GL 1.x context to bootstrap wglCreateContextAttribsARB
    HGLRC legacy = wglCreateContext(g_win.gl_hdc);
    if (!legacy) {
        LOG_ERROR(LOG_PLATFORM, "wglCreateContext (legacy) failed: 0x{:08x}", GetLastError());
        return false;
    }
    wglMakeCurrent(g_win.gl_hdc, legacy);

    auto wglCreateContextAttribsARB =
        reinterpret_cast<HGLRC(*)(HDC, HGLRC, const int*)>(
            wglGetProcAddress("wglCreateContextAttribsARB"));
    if (!wglCreateContextAttribsARB) {
        LOG_ERROR(LOG_PLATFORM, "wglCreateContextAttribsARB not available");
        wglMakeCurrent(nullptr, nullptr);
        wglDeleteContext(legacy);
        return false;
    }

    // Create GL 3.3 core profile context
    const int attribs[] = {
        0x2091, 3,          // WGL_CONTEXT_MAJOR_VERSION_ARB
        0x2092, 3,          // WGL_CONTEXT_MINOR_VERSION_ARB
        0x9126, 0x00000001, // WGL_CONTEXT_PROFILE_MASK_ARB = CORE_PROFILE_BIT
        0
    };
    g_win.gl_hglrc = wglCreateContextAttribsARB(g_win.gl_hdc, nullptr, attribs);
    wglMakeCurrent(nullptr, nullptr);
    wglDeleteContext(legacy);

    if (!g_win.gl_hglrc) {
        LOG_ERROR(LOG_PLATFORM, "wglCreateContextAttribsARB (3.3 core) failed: 0x{:08x}",
                  GetLastError());
        return false;
    }

    // Start render thread — it takes ownership of the GL context
    std::promise<bool> render_init_promise;
    auto render_init_future = render_init_promise.get_future();
    g_win.render_thread = std::thread(render_thread_func, std::move(render_init_promise));
    if (!render_init_future.get()) {
        LOG_ERROR(LOG_PLATFORM, "Render thread init failed");
        g_win.render_stop.signal();
        if (g_win.render_thread.joinable()) g_win.render_thread.join();
        return false;
    }

    // Start input thread (transparent child HWND for CEF mouse/keyboard)
    HWND mpv_hwnd = g_win.mpv_hwnd;
    g_win.input_thread = std::thread([mpv_hwnd]() {
        input::windows::run_input_thread(mpv_hwnd);
    });

    LOG_INFO(LOG_PLATFORM, "Windows RTT compositor initialized ({}×{})", init_pw, init_ph);
    return true;
}

// Re-sync mpv/CEF dimensions to the main HWND client area. Called after pip
// open/close so osd-dimensions from the pip FBO cannot leave CEF at the wrong
// size or win_present rejecting full-size frames as oversized.
static void win_refresh_main_surface_size() {
    if (!g_win.mpv_hwnd) return;
    RECT cr{};
    GetClientRect(g_win.mpv_hwnd, &cr);
    int pw = cr.right, ph = cr.bottom;
    if (pw <= 0 || ph <= 0) return;
    float scale = g_win.cached_scale > 0 ? g_win.cached_scale : 1.0f;
    int lw = static_cast<int>(pw / scale);
    int lh = static_cast<int>(ph / scale);
    win_resize(lw, lh, pw, ph);
    mpv::set_window_pixels(pw, ph);
    if (g_web_browser && g_web_browser->browser())
        g_web_browser->resize(lw, lh, pw, ph);
    if (g_overlay_browser && g_overlay_browser->browser()) {
        g_overlay_browser->resize(lw, lh, pw, ph);
        g_platform.overlay_resize(lw, lh, pw, ph);
    }
    if (g_about_browser && g_about_browser->browser()) {
        g_about_browser->resize(lw, lh, pw, ph);
        g_platform.about_resize(lw, lh, pw, ph);
    }
}

static void win_close_detached_pip(bool restore_main_video) {
    std::lock_guard<std::mutex> op_lock(g_win.pip_op_mtx);

    if (g_win.pip_phase.load(std::memory_order_acquire) == 1) {
        // Ask render thread to tear down pip resources and report back
        std::promise<void> ack;
        std::future<void>  ack_future = ack.get_future();
        {
            std::lock_guard<std::mutex> lock(g_win.surface_mtx);
            g_win.pip_close_ack = &ack;
            g_win.pip_phase.store(2, std::memory_order_release);
        }
        g_win.render_wake.signal();
        ack_future.wait();

        // pip_phase is now 0; save pip_hwnd then tell the pip thread to exit
        HWND pip_hwnd = g_win.pip_hwnd;
        g_win.pip_hwnd = nullptr;
        g_win.pending_pip_w.store(0, std::memory_order_relaxed);
        g_win.pending_pip_h.store(0, std::memory_order_relaxed);

        if (pip_hwnd && g_win.pip_window_tid)
            PostMessageW(pip_hwnd, WM_APP_PIP_DESTROY, 0, 0);

        if (g_win.pip_window_thread.joinable())
            g_win.pip_window_thread.join();

        g_win.pip_window_tid = 0;
        win_refresh_main_surface_size();
    }

    // Reattach the main video layer only when exiting detached mode entirely
    // (expand/stop). When the user merely closed the pop-out HWND, keep video
    // hidden so frames do not bleed through the home screen CEF layer.
    if (restore_main_video) {
        std::lock_guard<std::mutex> lock(g_win.surface_mtx);
        if (g_win.dcomp_video_visual && g_win.dcomp_device && g_win.video_swap_chain) {
            g_win.dcomp_video_visual->SetContent(g_win.video_swap_chain);
            g_win.dcomp_device->Commit();
        }
    }
}

static void win_open_detached_pip() {
    std::lock_guard<std::mutex> op_lock(g_win.pip_op_mtx);
    if (g_win.pip_phase.load(std::memory_order_acquire) != 0) return;

    constexpr int kInitW = 480, kInitH = 270;
    g_win.pip_window_thread = std::thread(win_pip_thread_func, kInitW, kInitH);

    // Spin briefly until the pip window thread has created the HWND
    for (int i = 0; i < 200 && !g_win.pip_hwnd; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));

    if (!g_win.pip_hwnd) {
        LOG_ERROR(LOG_PLATFORM, "Pip window failed to create");
        if (g_win.pip_window_thread.joinable()) g_win.pip_window_thread.join();
        return;
    }

    // Hide the main DComp video visual so the stale frame doesn't show through
    // the CEF overlay while pip is active.
    {
        std::lock_guard<std::mutex> lock(g_win.surface_mtx);
        if (g_win.dcomp_video_visual && g_win.dcomp_device) {
            g_win.dcomp_video_visual->SetContent(nullptr);
            g_win.dcomp_device->Commit();
        }
    }

    // Seed initial dimensions before making phase=1 visible to render thread,
    // so it can create the FBO on the very first wake even if WM_SIZE hasn't fired.
    g_win.pending_pip_w.store(kInitW, std::memory_order_relaxed);
    g_win.pending_pip_h.store(kInitH, std::memory_order_relaxed);
    g_win.pip_phase.store(1, std::memory_order_release);
    g_win.render_wake.signal();
    win_refresh_main_surface_size();
}

static void win_cleanup() {
    // Tear down pip window first, BEFORE signalling render_stop
    win_close_detached_pip(true);

    // Stop render thread first (it holds the GL context)
    g_win.render_stop.signal();
    g_win.render_wake.signal();  // unblock in case it's waiting
    if (g_win.render_thread.joinable()) g_win.render_thread.join();

    // Stop input thread
    input::windows::stop_input_thread();
    if (g_win.input_thread.joinable()) g_win.input_thread.join();

    // Stop main window thread
    if (g_win.main_window_tid)
        PostThreadMessageW(g_win.main_window_tid, WM_QUIT, 0, 0);
    if (g_win.main_window_thread.joinable()) g_win.main_window_thread.join();

    // Destroy WGL context and GL helper window
    if (g_win.gl_hglrc) { wglDeleteContext(g_win.gl_hglrc); g_win.gl_hglrc = nullptr; }
    if (g_win.gl_hwnd)  { ReleaseDC(g_win.gl_hwnd, g_win.gl_hdc); g_win.gl_hdc = nullptr;
                          DestroyWindow(g_win.gl_hwnd); g_win.gl_hwnd = nullptr; }

    // Release video swap chain
    if (g_win.video_swap_chain) { g_win.video_swap_chain->Release(); g_win.video_swap_chain = nullptr; }

    // Release CEF swap chains
    if (g_win.main_swap_chain)    { g_win.main_swap_chain->Release();    g_win.main_swap_chain    = nullptr; }
    if (g_win.overlay_swap_chain) { g_win.overlay_swap_chain->Release(); g_win.overlay_swap_chain = nullptr; }
    if (g_win.about_swap_chain)   { g_win.about_swap_chain->Release();   g_win.about_swap_chain   = nullptr; }

    // Release DComp
    if (g_win.dcomp_overlay_effect)  { g_win.dcomp_overlay_effect->Release();  g_win.dcomp_overlay_effect  = nullptr; }
    if (g_win.dcomp_about_visual)    { g_win.dcomp_about_visual->Release();    g_win.dcomp_about_visual    = nullptr; }
    if (g_win.dcomp_overlay_visual)  { g_win.dcomp_overlay_visual->Release();  g_win.dcomp_overlay_visual  = nullptr; }
    if (g_win.dcomp_main_visual)     { g_win.dcomp_main_visual->Release();     g_win.dcomp_main_visual     = nullptr; }
    if (g_win.dcomp_video_visual)    { g_win.dcomp_video_visual->Release();    g_win.dcomp_video_visual    = nullptr; }
    if (g_win.dcomp_root)            { g_win.dcomp_root->Release();            g_win.dcomp_root            = nullptr; }
    if (g_win.dcomp_target)          { g_win.dcomp_target->Release();          g_win.dcomp_target          = nullptr; }
    if (g_win.dcomp_device)          { g_win.dcomp_device->Release();          g_win.dcomp_device          = nullptr; }

    // Release D3D11
    if (g_win.dxgi_factory) { g_win.dxgi_factory->Release(); g_win.dxgi_factory = nullptr; }
    if (g_win.d3d_context1) { g_win.d3d_context1->Release(); g_win.d3d_context1 = nullptr; }
    if (g_win.d3d_context)  { g_win.d3d_context->Release();  g_win.d3d_context  = nullptr; }
    if (g_win.d3d_device)   { g_win.d3d_device->Release();   g_win.d3d_device   = nullptr; }

    g_win.mpv_hwnd = nullptr;
}

static void win_pump() {
    // Input is handled by the dedicated input thread's message loop
}

static void win_set_titlebar_color(uint8_t, uint8_t, uint8_t) {
    // No-op on Windows (DWM handles titlebar appearance)
}

// =====================================================================
// Clipboard (Win32 CF_UNICODETEXT) — read only; writes go through CEF's
// own frame->Copy() path which works correctly on Windows.
// =====================================================================

static void win_clipboard_read_text_async(std::function<void(std::string)> on_done) {
    if (!on_done) return;
    // Win32 clipboard is synchronous; fire the callback inline.
    std::string result;
    if (OpenClipboard(nullptr)) {
        HANDLE h = GetClipboardData(CF_UNICODETEXT);
        if (h) {
            auto* wbuf = static_cast<const wchar_t*>(GlobalLock(h));
            if (wbuf) {
                int bytes = WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, nullptr, 0, nullptr, nullptr);
                if (bytes > 1) {  // includes terminator
                    result.resize(bytes - 1);
                    WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, result.data(), bytes, nullptr, nullptr);
                }
                GlobalUnlock(h);
            }
        }
        CloseClipboard();
    }
    on_done(std::move(result));
}

static void win_open_external_url(const std::string& url) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, url.data(), (int)url.size(), nullptr, 0);
    if (wlen <= 0) return;
    std::wstring wurl(wlen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, url.data(), (int)url.size(), wurl.data(), wlen);
    HINSTANCE r = ShellExecuteW(nullptr, L"open", wurl.c_str(),
                                nullptr, nullptr, SW_SHOWNORMAL);
    if ((INT_PTR)r <= 32)
        LOG_ERROR(LOG_PLATFORM, "ShellExecuteW failed ({}): {}", (INT_PTR)r, url);
}

// Query window position relative to the monitor's working area (excludes
// taskbar), in physical pixels. Matches mpv's --geometry +X+Y coordinate
// system on Windows (vo_calc_window_geometry uses the working area).
static bool win_query_window_position(int* x, int* y) {
    if (!g_win.mpv_hwnd) return false;
    RECT wr;
    if (!GetWindowRect(g_win.mpv_hwnd, &wr)) return false;
    HMONITOR mon = MonitorFromWindow(g_win.mpv_hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfo(mon, &mi)) return false;
    *x = wr.left - mi.rcWork.left;
    *y = wr.top - mi.rcWork.top;
    return true;
}

// Resolve saved geometry against the primary monitor's working area so the
// window never opens larger than the screen or off-screen, and center any
// unset axis (mpv's own centering misbehaves when we override --geometry's
// wh but leave xy unset).
static void win_clamp_window_geometry(int* w, int* h, int* x, int* y) {
    RECT work;
    if (!SystemParametersInfo(SPI_GETWORKAREA, 0, &work, 0)) return;
    int vw = work.right - work.left;
    int vh = work.bottom - work.top;
    if (*w > vw) *w = vw;
    if (*h > vh) *h = vh;
    if (*x < 0) *x = (vw - *w) / 2;
    if (*y < 0) *y = (vh - *h) / 2;
    if (*x + *w > vw) *x = vw - *w;
    if (*y + *h > vh) *y = vh - *h;
    if (*x < 0) *x = 0;
    if (*y < 0) *y = 0;
}

static void win_raise_window() {
    HWND hwnd = g_win.mpv_hwnd;
    if (!hwnd) return;
    if (IsIconic(hwnd))
        ShowWindow(hwnd, SW_RESTORE);
    // SetForegroundWindow is subject to Windows focus-steal restrictions.
    // If this process lacks permission it will flash the taskbar instead,
    // which is still better than a silent no-op.
    SetForegroundWindow(hwnd);
}

// =====================================================================
// make_windows_platform
// =====================================================================

Platform make_windows_platform() {
    return Platform{
        .display = DisplayBackend::Windows,
        .early_init = win_early_init,
        .init = win_init,
        .cleanup = win_cleanup,
        .present = win_present,
        .present_software = win_present_software,
        .resize = win_resize,
        .overlay_present = win_overlay_present,
        .overlay_present_software = win_overlay_present_software,
        .overlay_resize = win_overlay_resize,
        .set_overlay_visible = win_set_overlay_visible,
        .about_present = win_about_present,
        .about_present_software = win_about_present_software,
        .about_resize = win_about_resize,
        .set_about_visible = win_set_about_visible,
        .popup_show = [](int, int, int, int) {},
        .popup_hide = []() {},
        .popup_present = [](const CefAcceleratedPaintInfo&, int, int) {},
        .popup_present_software = [](const void*, int, int, int, int) {},
        .try_native_popup_menu = [](int, int, int, int,
                                    const std::vector<std::string>&, int,
                                    std::function<void(int)>) { return false; },
        .fade_overlay = win_fade_overlay,
        .set_fullscreen = win_set_fullscreen,
        .toggle_fullscreen = win_toggle_fullscreen,
        .begin_transition = win_begin_transition,
        .end_transition = win_end_transition,
        .in_transition = win_in_transition,
        .set_expected_size = win_set_expected_size,
        .get_scale = win_get_scale,
        .query_window_position = win_query_window_position,
        .clamp_window_geometry = win_clamp_window_geometry,
        .pump = win_pump,
        .raise_window = win_raise_window,
        .set_cursor = input::windows::set_cursor,
        .set_idle_inhibit = win_set_idle_inhibit,
        .set_titlebar_color = win_set_titlebar_color,
        .set_mini_player_hole = win_set_mini_player_hole,
        .store_pip_params = win_store_pip_params,
        .open_detached_pip = win_open_detached_pip,
        .close_detached_pip = win_close_detached_pip,
        .pip_detached_active = []() { return g_win.pip_phase.load(std::memory_order_relaxed) == 1; },
        .clipboard_read_text_async = win_clipboard_read_text_async,
        .open_external_url = win_open_external_url,
    };
}

#endif // _WIN32
