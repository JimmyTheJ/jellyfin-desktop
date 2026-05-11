(function() {
    console.log('[Media] Installing native shim...');

    // Fullscreen state tracking via HTML5 Fullscreen API
    window._isFullscreen = false;

    document.addEventListener('fullscreenchange', () => {
        const fullscreen = !!document.fullscreenElement;
        if (window._isFullscreen === fullscreen) return;
        window._isFullscreen = fullscreen;
        console.log('[Media] Fullscreen changed:', fullscreen);
        // Notify player so UI updates (jellyfin-web listens for this)
        const player = window._mpvVideoPlayerInstance;
        if (player && player.events) {
            player.events.trigger(player, 'fullscreenchange');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && window._isFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    });

    // Double-click on video area toggles fullscreen.
    // Detected in JS because Wayland doesn't provide click count natively.
    (function() {
        let lastTime = 0, lastX = 0, lastY = 0;
        document.addEventListener('mousedown', (e) => {
            // left button only and only if clicked on main content (not header,
            // or controls)
            if (e.button !== 0 || !e.target.classList.contains("mainAnimatedPage")) return;
            const now = Date.now();
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            if ((now - lastTime) < 500 && (dx * dx + dy * dy) < 25) {
                if (document.querySelector('.videoPlayerContainer')) {
                    if (window.jmpNative) window.jmpNative.toggleFullscreen();
                }
                lastTime = 0;
            } else {
                lastTime = now;
                lastX = e.clientX;
                lastY = e.clientY;
            }
        }, true);  // capture phase — before jellyfin-web can stopPropagation
    })();

    // Buffered ranges storage (updated by native code)
    window._bufferedRanges = [];
    window._nativeUpdateBufferedRanges = function(ranges) {
        window._bufferedRanges = ranges || [];
    };

    // Signal emulation (Qt-style connect/disconnect)
    function createSignal(name) {
        const callbacks = [];
        const signal = function(...args) {
            for (const cb of callbacks) {
                try { cb(...args); } catch(e) { console.error('[Media] [Signal] ' + name + ' error:', e); }
            }
        };
        signal.connect = (cb) => {
            callbacks.push(cb);
            console.log('[Media] [Signal] ' + name + ' connected, now has', callbacks.length, 'listeners');
        };
        signal.disconnect = (cb) => {
            const idx = callbacks.indexOf(cb);
            if (idx >= 0) callbacks.splice(idx, 1);
            console.log('[Media] [Signal] ' + name + ' disconnected, now has', callbacks.length, 'listeners');
        };
        return signal;
    }

    // Saved settings from native (injected as placeholder, replaced at load time)
    const _savedSettings = JSON.parse('__SETTINGS_JSON__');

    // window.jmpInfo - settings and device info
    window.jmpInfo = {
        version: '1.0.0',
        deviceName: 'Jellyfin Desktop',
        mode: 'desktop',
        userAgent: navigator.userAgent,
        scriptPath: '',
        sections: [
            { key: 'playback', order: 0 },
            { key: 'audio', order: 1 },
            { key: 'advanced', order: 2 }
        ],
        settings: {
            main: { enableMPV: true, fullscreen: false, userWebClient: '__SERVER_URL__' },
            playback: {
                hwdec: _savedSettings.hwdec || 'auto'
            },
            audio: {
                audioPassthrough: _savedSettings.audioPassthrough || '',
                audioExclusive: _savedSettings.audioExclusive || false,
                audioChannels: _savedSettings.audioChannels || '',
                audioNormalization: _savedSettings.audioNormalization || ''
            },
            advanced: {
                transparentTitlebar: _savedSettings.transparentTitlebar !== false,
                logLevel: _savedSettings.logLevel || ''
            }
        },
        settingsDescriptions: {
            playback: [
                { key: 'hwdec', displayName: 'Hardware Decoding', help: 'Hardware video decoding mode. Use "auto" for automatic detection or "no" to disable.', options: _savedSettings.hwdecOptions }
            ],
            audio: [
                { key: 'audioPassthrough', displayName: 'Audio Passthrough', help: 'Comma-separated list of codecs to pass through to the audio device (e.g. ac3,eac3,dts-hd,truehd). Leave empty to disable.', inputType: 'textarea' },
                { key: 'audioExclusive', displayName: 'Exclusive Audio Output', help: 'Take exclusive control of the audio device during playback. May reduce latency but prevents other apps from playing audio.' },
                { key: 'audioChannels', displayName: 'Audio Channel Layout', help: 'Force a specific channel layout. Leave empty for auto-detection.', options: [
                    { value: '', title: 'Auto' },
                    { value: 'stereo', title: 'Stereo' },
                    { value: '5.1', title: '5.1 Surround' },
                    { value: '7.1', title: '7.1 Surround' }
                ]},
                { key: 'audioNormalization', displayName: 'Audio Normalization', help: 'Normalize loudness so quiet scenes stay audible and loud scenes don\'t peak. When the server has analyzed a file\'s loudness, a precise static gain is applied automatically. Otherwise falls back to real-time normalization. Requires audio decoding — disables bitstream passthrough.', options: [
                    { value: '', title: 'Off' },
                    { value: 'lavfi=[loudnorm=I=-18:TP=-1.5:LRA=20:linear=true]', title: 'Light (Loudness Leveling)' },
                    { value: 'lavfi=[loudnorm=I=-18:TP=-1.5:LRA=11,acompressor=threshold=0.125:ratio=4:attack=300:release=1500:makeup=2]', title: 'TV & Movies (Dynamic Range Compression)' },
                    { value: 'lavfi=[loudnorm=I=-18:TP=-1.5:LRA=11,acompressor=threshold=0.063:ratio=8:attack=200:release=1000:makeup=3.16]', title: 'Night Mode (Maximum Compression)' }
                ]}
            ],
            advanced: [
                { key: 'logLevel', displayName: 'Log Level', help: 'Set the application log verbosity level.', options: [
                    { value: '', title: 'Default (Info)' },
                    { value: 'verbose', title: 'Verbose' },
                    { value: 'debug', title: 'Debug' },
                    { value: 'warn', title: 'Warning' },
                    { value: 'error', title: 'Error' }
                ]}
            ]
        },
        settingsUpdate: [],
        settingsDescriptionsUpdate: []
    };

    // macOS-only: transparent titlebar toggle (shown first in Advanced section)
    if (navigator.platform.startsWith('Mac')) {
        jmpInfo.settingsDescriptions.advanced.unshift({
            key: 'transparentTitlebar',
            displayName: 'Transparent Titlebar',
            help: 'Overlay traffic light buttons on the window content instead of a separate titlebar. Requires restart.'
        });
    }

    // Player state
    const playerState = {
        position: 0,
        duration: 0,
        volume: 100,
        muted: false,
        paused: false
    };

    // window.api.player - MPV control API
    window.api = {
        player: {
            // Signals (Qt-style)
            playing: createSignal('playing'),
            paused: createSignal('paused'),
            finished: createSignal('finished'),
            stopped: createSignal('stopped'),
            canceled: createSignal('canceled'),
            error: createSignal('error'),
            buffering: createSignal('buffering'),
            seeking: createSignal('seeking'),
            positionUpdate: createSignal('positionUpdate'),
            updateDuration: createSignal('updateDuration'),
            stateChanged: createSignal('stateChanged'),
            videoPlaybackActive: createSignal('videoPlaybackActive'),
            windowVisible: createSignal('windowVisible'),
            onVideoRecangleChanged: createSignal('onVideoRecangleChanged'),
            onMetaData: createSignal('onMetaData'),

            // Methods
            load(url, options, streamdata, audioStream, subtitleStream, callback) {
                console.log('[Media] player.load:', url);
                window._jmpVideoActive = streamdata?.type === 'video';
                if (callback) {
                    // Wait for playing signal before calling callback
                    const onPlaying = () => {
                        this.playing.disconnect(onPlaying);
                        this.error.disconnect(onError);
                        callback();
                    };
                    const onError = () => {
                        this.playing.disconnect(onPlaying);
                        this.error.disconnect(onError);
                        callback();
                    };
                    this.playing.connect(onPlaying);
                    this.error.connect(onError);
                }
                if (window.jmpNative && window.jmpNative.playerLoad) {
                    const metadataJson = streamdata?.metadata ? JSON.stringify(streamdata.metadata) : '{}';
                    window.jmpNative.playerLoad(url, options.startMilliseconds, audioStream, subtitleStream, metadataJson);
                }
            },
            stop() {
                console.log('[Media] player.stop');
                restoreThemeColor();
                if (window.jmpNative) window.jmpNative.playerStop();
            },
            pause() {
                console.log('[Media] player.pause');
                if (window.jmpNative) window.jmpNative.playerPause();
                playerState.paused = true;
            },
            play() {
                console.log('[Media] player.play');
                if (window.jmpNative) window.jmpNative.playerPlay();
                playerState.paused = false;
            },
            seekTo(ms) {
                console.log('[Media] player.seekTo:', ms);
                if (window.jmpNative) window.jmpNative.playerSeek(ms);
            },
            setVolume(vol) {
                console.log('[Media] player.setVolume:', vol);
                playerState.volume = vol;
                if (window.jmpNative) window.jmpNative.playerSetVolume(vol);
            },
            setMuted(muted) {
                console.log('[Media] player.setMuted:', muted);
                playerState.muted = muted;
                if (window.jmpNative) window.jmpNative.playerSetMuted(muted);
            },
            setPlaybackRate(rate) {
                console.log('[Media] player.setPlaybackRate:', rate);
                if (window.jmpNative) window.jmpNative.playerSetSpeed(rate);
            },
            setSubtitleStream(index) {
                console.log('[Media] player.setSubtitleStream:', index);
                if (window.jmpNative) window.jmpNative.playerSetSubtitle(index);
            },
            addSubtitleStream(url) {
                console.log('[Media] player.addSubtitleStream:', url);
                if (window.jmpNative) window.jmpNative.playerAddSubtitle(url);
            },
            setAudioStream(index) {
                console.log('[Media] player.setAudioStream:', index);
                if (window.jmpNative) window.jmpNative.playerSetAudio(index);
            },
            setSubtitleDelay(ms) {
                console.log('[Media] player.setSubtitleDelay:', ms);
            },
            setAudioDelay(ms) {
                console.log('[Media] player.setAudioDelay:', ms);
                if (window.jmpNative) window.jmpNative.playerSetAudioDelay(ms / 1000.0);
            },
            setAspectMode(mode) {
                console.log('[Media] player.setAspectMode:', mode);
                if (window.jmpNative) window.jmpNative.playerSetAspectMode(mode);
            },
            setVideoRectangle(x, y, w, h) {
                if (window.jmpNative) window.jmpNative.setVideoRect(x, y, w, h);
            },
            getPosition(callback) {
                if (callback) callback(playerState.position);
                return playerState.position;
            },
            getDuration(callback) {
                if (callback) callback(playerState.duration);
                return playerState.duration;
            },
        },
        system: {
            openExternalUrl(url) {
                window.open(url, '_blank');
            },
            exit() {
                if (window.jmpNative) window.jmpNative.appExit();
            },
            cancelServerConnectivity() {
                if (window.jmpCheckServerConnectivity && window.jmpCheckServerConnectivity.abort) {
                    window.jmpCheckServerConnectivity.abort();
                }
            }
        },
        settings: {
            setValue(section, key, value, callback) {
                if (window.jmpNative && window.jmpNative.setSettingValue) {
                    window.jmpNative.setSettingValue(section, key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
                }
                if (callback) callback();
            },
            sectionValueUpdate: createSignal('sectionValueUpdate'),
            groupUpdate: createSignal('groupUpdate')
        },
        input: {
            // Signals for media session control commands
            hostInput: createSignal('hostInput'),
            positionSeek: createSignal('positionSeek'),
            rateChanged: createSignal('rateChanged'),
            volumeChanged: createSignal('volumeChanged'),

            executeActions() {}
        },
        window: {
            setCursorVisibility(visible) {}
        }
    };

    // Expose signal emitter for native code
    window._nativeEmit = function(signal, ...args) {
        console.log('[Media] _nativeEmit called with signal:', signal, 'args:', args);
        if (signal === 'paused') playerState.paused = true;
        else if (signal === 'playing') playerState.paused = false;
        if (window.api && window.api.player && window.api.player[signal]) {
            console.log('[Media] Firing signal:', signal);
            window.api.player[signal](...args);
        } else {
            console.error('[Media] Signal not found:', signal, 'api exists:', !!window.api);
        }
    };
    window._nativeFullscreenChanged = function(fullscreen) {
        window._isFullscreen = fullscreen;
        const player = window._mpvVideoPlayerInstance;
        if (player && player.events) {
            player.events.trigger(player, 'fullscreenchange');
        }
    };
    window._nativeUpdatePosition = function(ms) {
        playerState.position = ms;
        window.api.player.positionUpdate(ms);
    };
    window._nativeUpdateDuration = function(ms) {
        playerState.duration = ms;
        window.api.player.updateDuration(ms);
    };
    // Native emitters for media session control commands
    window._nativeHostInput = function(actions) {
        console.log('[Media] _nativeHostInput:', actions);
        window.api.input.hostInput(actions);
    };
    window._nativeSetRate = function(rate) {
        console.log('[Media] _nativeSetRate:', rate);
        window.api.input.rateChanged(rate);
    };
    window._nativeSeek = function(positionMs) {
        console.log('[Media] _nativeSeek:', positionMs);
        window.api.input.positionSeek(positionMs);
    };

    // ─── PiP mini-player ─────────────────────────────────────────────────────
    window._mpvMiniPlayerActive = false;

    // ── Shared helpers ────────────────────────────────────────────────────────

    function _pipFmtTime(ms) {
        const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }

    function _pipGetItem() {
        try {
            const p = window._mpvVideoPlayerInstance;
            return (p && p._currentPlayOptions && p._currentPlayOptions.item) || null;
        } catch (_) { return null; }
    }

    function _pipUpdateVideoRect(videoArea) {
        const r = videoArea.getBoundingClientRect();
        window.api.player.setVideoRectangle(r.left, r.top, r.width, r.height);
    }

    const _PIP_BTN_CSS = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;' +
        'padding:6px 9px;border-radius:4px;line-height:1;opacity:0.8;flex-shrink:0;' +
        'transition:opacity 0.1s,background 0.1s;';
    function _pipMkBtn(icon, title) {
        const b = document.createElement('button');
        b.style.cssText = _PIP_BTN_CSS;
        b.textContent = icon;
        b.title = title;
        b.setAttribute('tabindex', '-1');
        b.addEventListener('mouseenter', () => { b.style.opacity = '1'; b.style.background = 'rgba(255,255,255,0.12)'; });
        b.addEventListener('mouseleave', () => { b.style.opacity = '0.8'; b.style.background = 'none'; });
        return b;
    }

    // Drag panel via handleEl. onMove(x,y) is RAF-throttled; onEnd() on mouseup.
    // Optional canDrag() fn: if it returns false, drag is suppressed. Returns cleanup fn.
    function _pipDrag(panel, handleEl, onStart, onMove, onEnd, canDrag) {
        let active = false, started = false, sx = 0, sy = 0, ox = 0, oy = 0, rafId = null;
        const onDown = (e) => {
            if (e.button !== 0) return;
            if (canDrag && !canDrag()) return;
            const r = panel.getBoundingClientRect();
            active = true; started = false;
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            document.addEventListener('mousemove', onMv);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        };
        const onMv = (e) => {
            if (!active) return;
            if (!started) { started = true; if (onStart) onStart(); }
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => { onMove(ox + e.clientX - sx, oy + e.clientY - sy); });
        };
        const onUp = () => {
            active = false;
            document.removeEventListener('mousemove', onMv);
            document.removeEventListener('mouseup', onUp);
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            if (started && onEnd) onEnd();
        };
        handleEl.addEventListener('mousedown', onDown);
        return () => {
            handleEl.removeEventListener('mousedown', onDown);
            document.removeEventListener('mousemove', onMv);
            document.removeEventListener('mouseup', onUp);
            if (rafId) cancelAnimationFrame(rafId);
        };
    }

    // Attach 4-corner resize handles to panel. onMove() called each RAF frame during resize;
    // onEnd() called after each resize gesture. Returns cleanup fn.
    function _pipResize(panel, minW, minH, onMove, onEnd) {
        const SZ = 14;
        const dirs = ['nw', 'ne', 'sw', 'se'];
        const cursors = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize' };
        const stops = [];
        for (const dir of dirs) {
            const h = document.createElement('div');
            h.style.cssText = 'position:absolute;width:' + SZ + 'px;height:' + SZ + 'px;' +
                'cursor:' + cursors[dir] + ';z-index:2;' +
                (dir[0] === 'n' ? 'top:0;' : 'bottom:0;') +
                (dir[1] === 'w' ? 'left:0;' : 'right:0;');
            panel.appendChild(h);
            let sx, sy, sr, rafId = null;
            const onDown = (e) => {
                if (e.button !== 0) return;
                e.preventDefault(); e.stopPropagation();
                sx = e.clientX; sy = e.clientY;
                sr = panel.getBoundingClientRect();
                document.addEventListener('mousemove', onMv);
                document.addEventListener('mouseup', onUp);
            };
            const onMv = (e) => {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    const dx = e.clientX - sx, dy = e.clientY - sy;
                    let l = sr.left, t = sr.top, w = sr.width, ht = sr.height;
                    if (dir[1] === 'e') w  = Math.max(minW, w + dx);
                    if (dir[0] === 's') ht = Math.max(minH, ht + dy);
                    if (dir[1] === 'w') { w = Math.max(minW, w - dx); l = sr.right - w; }
                    if (dir[0] === 'n') { ht = Math.max(minH, ht - dy); t = sr.bottom - ht; }
                    panel.style.left = l + 'px'; panel.style.top = t + 'px';
                    panel.style.width = w + 'px'; panel.style.height = ht + 'px';
                    panel.style.right = 'auto'; panel.style.bottom = 'auto';
                    if (onMove) onMove();
                });
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMv);
                document.removeEventListener('mouseup', onUp);
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                if (onEnd) onEnd();
            };
            h.addEventListener('mousedown', onDown);
            stops.push(() => {
                h.removeEventListener('mousedown', onDown);
                document.removeEventListener('mousemove', onMv);
                document.removeEventListener('mouseup', onUp);
            });
        }
        return () => stops.forEach(fn => fn());
    }

    // Returns snapped {x,y} if within threshold of any corner, else null.
    function _pipCornerSnap(x, y, w, h) {
        const THR = 80, M = 16, ww = window.innerWidth, wh = window.innerHeight;
        const corners = [
            { x: M, y: M }, { x: ww - w - M, y: M },
            { x: M, y: wh - h - M }, { x: ww - w - M, y: wh - h - M },
        ];
        for (const c of corners) {
            if (Math.abs(x - c.x) < THR && Math.abs(y - c.y) < THR) return c;
        }
        return null;
    }

    function _pipSavePos(key, x, y, w, h) {
        try { localStorage.setItem(key, JSON.stringify({ x, y, w, h })); } catch (_) {}
    }
    function _pipLoadPos(key) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    }

    function _pipPopulateItem(panel, titleEl, subtitleEl) {
        const item = _pipGetItem();
        if (!item) return;
        if (item.SeriesName) {
            if (titleEl) titleEl.textContent = item.SeriesName;
            let ep = '';
            if (item.ParentIndexNumber != null) ep += 'S' + item.ParentIndexNumber;
            if (item.IndexNumber != null) ep += (ep ? ' ' : '') + 'E' + item.IndexNumber;
            const full = ep + (item.Name ? (ep ? '  ·  ' : '') + item.Name : '');
            panel._episodeLabel = full;
            if (subtitleEl) subtitleEl.textContent = full;
        } else {
            if (titleEl) titleEl.textContent = item.Name || '';
            panel._episodeLabel = '';
        }
    }

    // Wire playback signals onto panel. progressFill and timeEl may be null.
    function _pipWireSignals(panel, progressFill, timeEl, pauseBtnId) {
        const onPaused  = () => { const b = document.getElementById(pauseBtnId); if (b) b.textContent = '\u25B6'; };
        const onPlaying = () => { const b = document.getElementById(pauseBtnId); if (b) b.textContent = '\u23F8'; };
        const onTimePos = (posMs) => {
            const durMs = panel._duration || 0;
            if (durMs <= 0) return;
            if (progressFill) progressFill.style.width = Math.min(100, (posMs / durMs) * 100) + '%';
            if (timeEl) timeEl.textContent = _pipFmtTime(posMs) + ' / ' + _pipFmtTime(durMs);
        };
        const onDuration = (durMs) => { panel._duration = durMs; };
        window.api.player.paused.connect(onPaused);
        window.api.player.playing.connect(onPlaying);
        window.api.player.positionUpdate.connect(onTimePos);
        window.api.player.updateDuration.connect(onDuration);
        panel._onPaused   = onPaused;
        panel._onPlaying  = onPlaying;
        panel._onTimePos  = onTimePos;
        panel._onDuration = onDuration;
        panel._duration   = playerState.duration;
    }

    function _pipUnwireSignals(panel) {
        if (panel._onPaused)   window.api.player.paused.disconnect(panel._onPaused);
        if (panel._onPlaying)  window.api.player.playing.disconnect(panel._onPlaying);
        if (panel._onTimePos)  window.api.player.positionUpdate.disconnect(panel._onTimePos);
        if (panel._onDuration) window.api.player.updateDuration.disconnect(panel._onDuration);
    }

    // Shared expand action used by all modes.
    function _pipDoExpand() {
        window._nativeExitMiniPlayer();
        const pl = window._mpvVideoPlayerInstance;
        const router = pl && pl.appRouter;
        if (router && typeof router.showVideoOsd === 'function') router.showVideoOsd();
        else if (router && typeof router.back === 'function') router.back();
        else window.history.back();
    }

    // Shared cleanup before appending any mode's panel.
    function _pipCleanupPage() {
        const vcDlg = document.querySelector('.videoPlayerContainer');
        if (vcDlg && vcDlg.parentNode) vcDlg.parentNode.removeChild(vcDlg);
        document.body.classList.remove('hide-scroll');
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
    }

    // Mode picker popover — opened by the gear button in any mode.
    function _showModePicker(anchorEl) {
        const existing = document.getElementById('jmp-pip-modepicker');
        if (existing) { if (existing.parentNode) existing.parentNode.removeChild(existing); return; }

        const MODES = [
            { key: 'bar',     icon: '▬', label: 'Bottom Bar',     desc: 'Full-width bar with live video' },
            { key: 'float',   icon: '⧉', label: 'Floating Panel',  desc: 'Draggable, resizable panel' },
            { key: 'minimal', icon: '⊡', label: 'Minimal Overlay', desc: 'Video only, controls on hover' },
        ];
        const cur = localStorage.getItem('jmp_pip_mode') || 'bar';

        const pop = document.createElement('div');
        pop.id = 'jmp-pip-modepicker';
        pop.style.cssText = [
            'position:fixed', 'z-index:10002',
            'background:rgba(18,18,18,0.97)',
            'border:1px solid rgba(255,255,255,0.12)',
            'border-radius:8px', 'padding:6px', 'min-width:220px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        ].join(';');

        const ar  = anchorEl.getBoundingClientRect();
        const POP_H = 150; // conservative estimate of popover height

        // The ClearView hole sits inside the PiP panel, so the popover must land
        // OUTSIDE the panel bounds to avoid being alpha-zeroed by ClearView.
        // Bar mode: hole is bottom-left; opening upward puts us in the safe main
        //   content area — keep the existing behavior.
        // Float/minimal: hole is inside the panel; open BELOW the panel if there
        //   is room, otherwise open ABOVE the panel top edge.
        const mode = localStorage.getItem('jmp_pip_mode') || 'bar';
        if (mode !== 'bar') {
            const panel = document.getElementById('jmp-pip-panel');
            const pr    = panel ? panel.getBoundingClientRect() : ar;
            if (pr.bottom + POP_H + 12 <= window.innerHeight) {
                // Enough room below the panel — safe, no hole here.
                pop.style.top = (pr.bottom + 8) + 'px';
            } else {
                // Open above the panel top — also outside the hole.
                pop.style.bottom = (window.innerHeight - pr.top + 8) + 'px';
            }
        } else {
            // Bar mode: open upward into the main content area (no hole there).
            pop.style.bottom = (window.innerHeight - ar.top + 8) + 'px';
        }
        pop.style.right = Math.max(4, window.innerWidth - ar.right) + 'px';

        for (const m of MODES) {
            const active = m.key === cur;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;' +
                'border-radius:6px;cursor:pointer;transition:background 0.1s;' +
                (active ? 'background:rgba(0,164,220,0.22);' : '');
            row.addEventListener('mouseenter', () => { if (!active) row.style.background = 'rgba(255,255,255,0.07)'; });
            row.addEventListener('mouseleave', () => { if (!active) row.style.background = ''; });

            const ic = document.createElement('span');
            ic.style.cssText = 'font-size:15px;width:22px;text-align:center;color:' +
                (active ? '#00a4dc' : 'rgba(255,255,255,0.55)') + ';';
            ic.textContent = m.icon;

            const lb = document.createElement('div');
            lb.style.cssText = 'font-size:12px;font-weight:600;color:#fff;';
            lb.textContent = m.label;
            const ds = document.createElement('div');
            ds.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);margin-top:1px;';
            ds.textContent = m.desc;
            const tx = document.createElement('div');
            tx.appendChild(lb); tx.appendChild(ds);

            row.appendChild(ic); row.appendChild(tx);
            pop.appendChild(row);

            row.addEventListener('click', () => {
                if (pop.parentNode) pop.parentNode.removeChild(pop);
                if (m.key === cur) return;
                localStorage.setItem('jmp_pip_mode', m.key);
                window._nativeExitMiniPlayer();
                window._nativeEnterMiniPlayer();
            });
        }

        document.body.appendChild(pop);
        setTimeout(() => {
            const onOutside = (e) => {
                if (!pop.contains(e.target)) {
                    if (pop.parentNode) pop.parentNode.removeChild(pop);
                    document.removeEventListener('click', onOutside, true);
                }
            };
            document.addEventListener('click', onOutside, true);
        }, 0);
    }

    // ── Bottom bar mode ───────────────────────────────────────────────────────
    function _enterBarMode() {
        const BAR_H = 96, VID_HOLE_W = 152, VID_HOLE_H = 84, VID_PAD_X = 8, VID_PAD_Y = 6;
        const WRAPPER_W = VID_HOLE_W + VID_PAD_X * 2;

        const panel = document.createElement('div');
        panel.id = 'jmp-pip-panel';
        panel.style.cssText = [
            'position:fixed', 'bottom:0', 'left:0', 'right:0', 'height:' + BAR_H + 'px',
            'background:rgba(10,10,10,0.93)',
            'border-top:1px solid rgba(255,255,255,0.10)',
            'z-index:10000', 'display:flex', 'align-items:center',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'box-sizing:border-box',
        ].join(';');

        // Full-width progress bar at very bottom — below ClearView zone.
        const progressBg = document.createElement('div');
        progressBg.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:3px;' +
            'background:rgba(255,255,255,0.15);overflow:hidden;cursor:pointer;z-index:1;';
        const progressFill = document.createElement('div');
        progressFill.style.cssText = 'height:100%;background:#00a4dc;width:0%;pointer-events:none;' +
            'transition:width 0.8s linear;';
        progressBg.appendChild(progressFill);
        panel.appendChild(progressBg);
        progressBg.addEventListener('click', (e) => {
            const r = progressBg.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            const dur = panel._duration || 0;
            if (dur > 0) window.api.input.positionSeek(frac * dur);
        });

        // Video wrapper with padding — inner div is the transparent ClearView hole.
        const videoWrapper = document.createElement('div');
        videoWrapper.style.cssText = [
            'width:' + WRAPPER_W + 'px', 'height:' + BAR_H + 'px', 'flex-shrink:0',
            'display:flex', 'align-items:center', 'justify-content:center',
            'border-right:1px solid rgba(255,255,255,0.08)',
            'box-sizing:border-box', 'cursor:pointer',
            'padding:' + VID_PAD_Y + 'px ' + VID_PAD_X + 'px',
        ].join(';');
        videoWrapper.title = 'Click to restore player';
        const videoArea = document.createElement('div');
        videoArea.style.cssText = 'width:' + VID_HOLE_W + 'px;height:' + VID_HOLE_H + 'px;' +
            'background:transparent;flex-shrink:0;';
        videoWrapper.appendChild(videoArea);
        panel.appendChild(videoWrapper);
        panel._videoArea = videoArea;

        // Info: three stacked rows (show name / episode / time).
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;padding:0 16px;overflow:hidden;min-width:0;' +
            'display:flex;flex-direction:column;justify-content:center;gap:3px;';
        const titleEl    = document.createElement('div');
        titleEl.style.cssText    = 'color:#fff;font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const subtitleEl = document.createElement('div');
        subtitleEl.style.cssText = 'color:rgba(255,255,255,0.70);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const timeEl     = document.createElement('div');
        timeEl.style.cssText     = 'color:rgba(255,255,255,0.45);font-size:11px;white-space:nowrap;';
        info.appendChild(titleEl); info.appendChild(subtitleEl); info.appendChild(timeEl);
        panel.appendChild(info);
        _pipPopulateItem(panel, titleEl, subtitleEl);

        // Controls.
        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:0;padding:0 12px;flex-shrink:0;';

        const pauseBtn = _pipMkBtn(playerState.paused ? '\u25B6' : '\u23F8', 'Play/Pause');
        pauseBtn.id = 'jmp-pip-pause';
        pauseBtn.style.fontSize = '22px';

        const volWrap = document.createElement('div');
        volWrap.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 6px;';
        const volIcon = document.createElement('span');
        volIcon.style.cssText = 'color:rgba(255,255,255,0.7);font-size:15px;cursor:default;';
        volIcon.textContent = '\uD83D\uDD0A';
        const volSlider = document.createElement('input');
        volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '100';
        volSlider.style.cssText = 'width:64px;height:3px;cursor:pointer;accent-color:#00a4dc;' +
            'outline:none;border:none;background:rgba(255,255,255,0.2);border-radius:2px;';
        volSlider.value = String(Math.round(playerState.volume));
        volSlider.addEventListener('input', () => window.api.player.setVolume(Number(volSlider.value)));
        volWrap.appendChild(volIcon); volWrap.appendChild(volSlider);

        const expandBtn = _pipMkBtn('\u26F6', 'Restore full player');
        const stopBtn   = _pipMkBtn('\u2715', 'Stop playback');
        const gearBtn   = _pipMkBtn('\u2699', 'PiP mode');
        gearBtn.style.fontSize = '15px';

        controls.appendChild(pauseBtn);
        controls.appendChild(volWrap);
        controls.appendChild(expandBtn);
        controls.appendChild(stopBtn);
        controls.appendChild(gearBtn);
        panel.appendChild(controls);

        _pipWireSignals(panel, progressFill, timeEl, 'jmp-pip-pause');

        pauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (playerState.paused) window.api.player.play(); else window.api.player.pause();
        });
        videoWrapper.addEventListener('click', (e) => { e.stopPropagation(); _pipDoExpand(); });
        expandBtn.addEventListener('click',    (e) => { e.stopPropagation(); _pipDoExpand(); });
        stopBtn.addEventListener('click',      (e) => { e.stopPropagation(); window._nativeExitMiniPlayer(); window.api.player.stop(); });
        gearBtn.addEventListener('click',      (e) => { e.stopPropagation(); _showModePicker(gearBtn); });

        const updateRect = () => _pipUpdateVideoRect(videoArea);
        window.addEventListener('resize', updateRect);
        panel._onResize = updateRect;

        // Inject body padding so page content isn't hidden behind the bar.
        if (!document.getElementById('jmp-pip-style')) {
            const st = document.createElement('style');
            st.id = 'jmp-pip-style';
            st.textContent = 'body{padding-bottom:' + BAR_H + 'px!important}';
            document.head.appendChild(st);
        }

        _pipCleanupPage();
        document.body.appendChild(panel);
        window._mpvMiniPlayerActive = true;
        updateRect();
    }

    // ── Floating panel mode ───────────────────────────────────────────────────
    function _enterFloatMode() {
        const TITLE_H = 34, CTRL_H = 36, MIN_W = 220, MIN_H = 180;
        const saved = _pipLoadPos('jmp_pip_float_pos');
        const W  = saved ? saved.w : 320;
        const H  = saved ? saved.h : 260;
        const px = saved ? saved.x : window.innerWidth  - W - 16;
        const py = saved ? saved.y : window.innerHeight - H - 16;

        const panel = document.createElement('div');
        panel.id = 'jmp-pip-panel';
        panel.style.cssText = [
            'position:fixed',
            'left:' + px + 'px', 'top:' + py + 'px',
            'width:' + W + 'px', 'height:' + H + 'px',
            'background:rgba(12,12,12,0.95)',
            'border:1px solid rgba(255,255,255,0.12)',
            'border-radius:10px', 'overflow:hidden',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
            'z-index:10000', 'display:flex', 'flex-direction:column',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'box-sizing:border-box',
        ].join(';');

        // Title bar is the drag handle. position:relative;z-index:3 keeps it above resize handles.
        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'height:' + TITLE_H + 'px;flex-shrink:0;display:flex;' +
            'align-items:center;padding:0 10px;cursor:move;gap:6px;overflow:hidden;' +
            'border-bottom:1px solid rgba(255,255,255,0.07);user-select:none;' +
            'position:relative;z-index:3;background:rgba(12,12,12,0.95);';
        const titleEl    = document.createElement('div');
        titleEl.style.cssText    = 'flex:1;font-size:12px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const subtitleEl = document.createElement('div');
        subtitleEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;max-width:45%;';
        titleBar.appendChild(titleEl); titleBar.appendChild(subtitleEl);
        panel.appendChild(titleBar);
        _pipPopulateItem(panel, titleEl, subtitleEl);

        // Transparent video hole.
        const videoArea = document.createElement('div');
        videoArea.style.cssText = 'flex:1;background:transparent;min-height:0;';
        panel.appendChild(videoArea);
        panel._videoArea = videoArea;

        // Controls bar — position:relative;z-index:3 ensures clicks land on buttons, not resize handles.
        const controls = document.createElement('div');
        controls.style.cssText = 'height:' + CTRL_H + 'px;flex-shrink:0;display:flex;' +
            'align-items:center;padding:0 4px;border-top:1px solid rgba(255,255,255,0.07);gap:0;' +
            'position:relative;z-index:3;background:rgba(12,12,12,0.95);';

        const pauseBtn = _pipMkBtn(playerState.paused ? '\u25B6' : '\u23F8', 'Play/Pause');
        pauseBtn.id = 'jmp-pip-pause';
        pauseBtn.style.fontSize = '16px'; pauseBtn.style.padding = '4px 8px';

        const timeEl = document.createElement('div');
        timeEl.style.cssText = 'flex:1;font-size:10px;color:rgba(255,255,255,0.4);padding:0 4px;white-space:nowrap;';

        const expandBtn = _pipMkBtn('\u26F6', 'Restore full player');
        expandBtn.style.fontSize = '14px'; expandBtn.style.padding = '4px 7px';

        // Corner button: cycles br → bl → tr → tl → br.
        const CORNERS      = ['br', 'bl', 'tr', 'tl'];
        const CORNER_ICONS = { br: '\u2198', bl: '\u2199', tr: '\u2197', tl: '\u2196' };
        const CORNER_TIPS  = { br: 'Corner: bottom-right', bl: 'Corner: bottom-left', tr: 'Corner: top-right', tl: 'Corner: top-left' };
        panel._corner = 'br';
        const cornerBtn = _pipMkBtn(CORNER_ICONS.br, CORNER_TIPS.br + ' (Ctrl+Shift+C)');
        cornerBtn.style.fontSize = '15px'; cornerBtn.style.padding = '4px 7px';
        panel._pipCornerBtn = cornerBtn;

        // Pin button: toggles locked-to-corner. When pinned, drag is disabled.
        panel._isPinned = false;
        const pinBtn = _pipMkBtn('\uD83D\uDCCC', 'Pin to corner (Ctrl+Shift+L)');
        pinBtn.style.fontSize = '13px'; pinBtn.style.padding = '4px 7px';
        panel._pipPinBtn = pinBtn;

        const stopBtn = _pipMkBtn('\u2715', 'Stop playback');
        stopBtn.style.fontSize = '13px'; stopBtn.style.padding = '4px 7px';
        const gearBtn = _pipMkBtn('\u2699', 'PiP mode (Ctrl+Shift+M)');
        gearBtn.style.fontSize = '13px'; gearBtn.style.padding = '4px 7px';

        controls.appendChild(pauseBtn);
        controls.appendChild(timeEl);
        controls.appendChild(expandBtn);
        controls.appendChild(cornerBtn);
        controls.appendChild(pinBtn);
        controls.appendChild(stopBtn);
        controls.appendChild(gearBtn);
        panel.appendChild(controls);

        // Apply the current corner position when pinned.
        const applyPinPos = () => {
            const M = 16, pw = panel.offsetWidth, ph = panel.offsetHeight;
            const ww = window.innerWidth, wh = window.innerHeight;
            const P = {
                br: { l: ww - pw - M, t: wh - ph - M },
                bl: { l: M,           t: wh - ph - M },
                tr: { l: ww - pw - M, t: M },
                tl: { l: M,           t: M },
            };
            const p = P[panel._corner] || P.br;
            panel.style.left = p.l + 'px'; panel.style.top = p.t + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            _pipUpdateVideoRect(videoArea);
        };

        const applyCorner = (corner) => {
            panel._corner = corner;
            cornerBtn.textContent = CORNER_ICONS[corner];
            cornerBtn.title = CORNER_TIPS[corner] + ' (Ctrl+Shift+C)';
            if (panel._isPinned) applyPinPos();
        };

        const applyPin = (pinned) => {
            panel._isPinned = pinned;
            pinBtn.textContent = pinned ? '\uD83D\uDD12' : '\uD83D\uDCCC';
            pinBtn.title = (pinned ? 'Unpin' : 'Pin to corner') + ' (Ctrl+Shift+L)';
            pinBtn.style.color = pinned ? '#00a4dc' : '';
            titleBar.style.cursor = pinned ? 'default' : 'move';
            if (pinned) applyPinPos();
        };

        // Drag — live video rect update on every frame; gated by !panel._isPinned.
        const stopDrag = _pipDrag(
            panel, titleBar,
            null,
            (nx, ny) => {
                nx = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  nx));
                ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, ny));
                panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
                panel.style.right = 'auto'; panel.style.bottom = 'auto';
                _pipUpdateVideoRect(videoArea);
            },
            () => {
                const r = panel.getBoundingClientRect();
                const snap = _pipCornerSnap(r.left, r.top, r.width, r.height);
                if (snap) { panel.style.left = snap.x + 'px'; panel.style.top = snap.y + 'px'; }
                _pipSavePos('jmp_pip_float_pos', parseFloat(panel.style.left), parseFloat(panel.style.top), r.width, r.height);
                _pipUpdateVideoRect(videoArea);
            },
            () => !panel._isPinned
        );
        panel._stopDrag = stopDrag;

        // Resize — live update during resize too.
        const stopResize = _pipResize(panel, MIN_W, MIN_H,
            () => { _pipUpdateVideoRect(videoArea); },
            () => {
                const r = panel.getBoundingClientRect();
                _pipSavePos('jmp_pip_float_pos', r.left, r.top, r.width, r.height);
                _pipUpdateVideoRect(videoArea);
            }
        );
        panel._stopResize = stopResize;

        videoArea.addEventListener('mousedown', (e) => { e.stopPropagation(); });

        _pipWireSignals(panel, null, timeEl, 'jmp-pip-pause');

        pauseBtn.addEventListener('click',  (e) => { e.stopPropagation(); if (playerState.paused) window.api.player.play(); else window.api.player.pause(); });
        expandBtn.addEventListener('click', (e) => { e.stopPropagation(); _pipDoExpand(); });
        stopBtn.addEventListener('click',   (e) => { e.stopPropagation(); window._nativeExitMiniPlayer(); window.api.player.stop(); });
        gearBtn.addEventListener('click',   (e) => { e.stopPropagation(); _showModePicker(gearBtn); });
        cornerBtn.addEventListener('click', (e) => { e.stopPropagation(); applyCorner(CORNERS[(CORNERS.indexOf(panel._corner) + 1) % CORNERS.length]); });
        pinBtn.addEventListener('click',    (e) => { e.stopPropagation(); applyPin(!panel._isPinned); });

        const updateRect = () => {
            if (panel._isPinned) applyPinPos(); else _pipUpdateVideoRect(videoArea);
        };
        window.addEventListener('resize', updateRect);
        panel._onResize = updateRect;

        _pipCleanupPage();
        document.body.appendChild(panel);
        window._mpvMiniPlayerActive = true;
        _pipUpdateVideoRect(videoArea);
    }

    // ── Minimal overlay mode ──────────────────────────────────────────────────
    function _enterMinimalMode() {
        // Fixed 16:9 video hole; 36px controls strip below (outside ClearView zone).
        const CTRL_H = 36, VID_W = 320, VID_H = 180;
        const PANEL_H = VID_H + CTRL_H;
        const saved = _pipLoadPos('jmp_pip_minimal_pos');
        const px = saved ? saved.x : window.innerWidth  - VID_W - 16;
        const py = saved ? saved.y : window.innerHeight - PANEL_H - 16;

        const panel = document.createElement('div');
        panel.id = 'jmp-pip-panel';
        panel.style.cssText = [
            'position:fixed',
            'left:' + px + 'px', 'top:' + py + 'px',
            'width:' + VID_W + 'px', 'height:' + PANEL_H + 'px',
            'z-index:10000',
            'border-radius:6px', 'overflow:hidden',
            'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'background:#000',
        ].join(';');

        // Transparent video hole — top VID_H px of panel.
        const videoArea = document.createElement('div');
        videoArea.style.cssText = 'position:absolute;left:0;top:0;width:' + VID_W + 'px;height:' + VID_H + 'px;background:transparent;';
        panel.appendChild(videoArea);

        // Controls strip below the video hole — always opaque, so ClearView doesn't touch it.
        const ctrlStrip = document.createElement('div');
        ctrlStrip.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:' + CTRL_H + 'px;' +
            'background:rgba(10,10,10,0.93);display:flex;align-items:center;padding:0 4px;gap:0;' +
            'border-top:1px solid rgba(255,255,255,0.08);';

        const pauseBtn  = _pipMkBtn(playerState.paused ? '\u25B6' : '\u23F8', 'Play/Pause');
        pauseBtn.id = 'jmp-pip-pause';
        pauseBtn.style.fontSize = '15px'; pauseBtn.style.padding = '4px 8px';

        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex:1;';

        const expandBtn = _pipMkBtn('\u26F6', 'Restore full player');
        expandBtn.style.fontSize = '13px'; expandBtn.style.padding = '4px 7px';
        const stopBtn = _pipMkBtn('\u2715', 'Stop playback');
        stopBtn.style.fontSize = '12px'; stopBtn.style.padding = '4px 7px';
        const gearBtn = _pipMkBtn('\u2699', 'PiP mode');
        gearBtn.style.fontSize = '12px'; gearBtn.style.padding = '4px 7px';

        ctrlStrip.appendChild(pauseBtn);
        ctrlStrip.appendChild(spacer);
        ctrlStrip.appendChild(expandBtn);
        ctrlStrip.appendChild(stopBtn);
        ctrlStrip.appendChild(gearBtn);
        panel.appendChild(ctrlStrip);

        // Hover: fade controls overlay on the video area in/out.
        const hoverOverlay = document.createElement('div');
        hoverOverlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:' + VID_H + 'px;' +
            'background:linear-gradient(transparent 60%,rgba(0,0,0,0.55));' +
            'opacity:0;transition:opacity 0.2s;pointer-events:none;';
        panel.appendChild(hoverOverlay);

        let hideTimer = null;
        const showCtrl = () => { clearTimeout(hideTimer); hoverOverlay.style.opacity = '1'; };
        const scheduleHide = () => {
            hideTimer = setTimeout(() => { hoverOverlay.style.opacity = '0'; }, 1500);
        };
        panel.addEventListener('mouseenter', showCtrl);
        panel.addEventListener('mousemove',  showCtrl);
        panel.addEventListener('mouseleave', scheduleHide);

        panel._videoArea = videoArea;

        // Drag — only the video area is the drag handle so ctrlStrip buttons get clean clicks.
        videoArea.style.cursor = 'move';
        const stopDrag = _pipDrag(
            panel, videoArea,
            null,
            (nx, ny) => {
                nx = Math.max(0, Math.min(window.innerWidth  - VID_W,    nx));
                ny = Math.max(0, Math.min(window.innerHeight - PANEL_H, ny));
                panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
                _pipUpdateVideoRect(videoArea);
            },
            () => {
                const snap = _pipCornerSnap(parseFloat(panel.style.left), parseFloat(panel.style.top), VID_W, PANEL_H);
                if (snap) { panel.style.left = snap.x + 'px'; panel.style.top = snap.y + 'px'; }
                _pipSavePos('jmp_pip_minimal_pos', parseFloat(panel.style.left), parseFloat(panel.style.top), VID_W, PANEL_H);
                _pipUpdateVideoRect(videoArea);
            }
        );
        panel._stopDrag = stopDrag;

        _pipWireSignals(panel, null, null, 'jmp-pip-pause');

        pauseBtn.addEventListener('click',  (e) => { e.stopPropagation(); if (playerState.paused) window.api.player.play(); else window.api.player.pause(); });
        expandBtn.addEventListener('click', (e) => { e.stopPropagation(); _pipDoExpand(); });
        stopBtn.addEventListener('click',   (e) => { e.stopPropagation(); window._nativeExitMiniPlayer(); window.api.player.stop(); });
        gearBtn.addEventListener('click',   (e) => { e.stopPropagation(); _showModePicker(gearBtn); });

        const updateRect = () => _pipUpdateVideoRect(videoArea);
        window.addEventListener('resize', updateRect);
        panel._onResize = updateRect;

        _pipCleanupPage();
        document.body.appendChild(panel);
        window._mpvMiniPlayerActive = true;
        _pipUpdateVideoRect(videoArea);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window._nativeEnterMiniPlayer = function() {
        if (document.getElementById('jmp-pip-panel')) return;
        const mode = localStorage.getItem('jmp_pip_mode') || 'bar';
        if (mode === 'float')        _enterFloatMode();
        else if (mode === 'minimal') _enterMinimalMode();
        else                         _enterBarMode();
    };

    window._nativeExitMiniPlayer = function() {
        const panel = document.getElementById('jmp-pip-panel');
        if (!panel) { window._mpvMiniPlayerActive = false; return; }
        _pipUnwireSignals(panel);
        if (panel._onResize)   window.removeEventListener('resize', panel._onResize);
        if (panel._stopDrag)   panel._stopDrag();
        if (panel._stopResize) panel._stopResize();
        if (panel.parentNode)  panel.parentNode.removeChild(panel);
        const st  = document.getElementById('jmp-pip-style');
        if (st && st.parentNode) st.parentNode.removeChild(st);
        const pop = document.getElementById('jmp-pip-modepicker');
        if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
        window._mpvMiniPlayerActive = false;
        const player = window._mpvVideoPlayerInstance;
        if (player) player._isMiniPlayer = false;
        window.api.player.setVideoRectangle(0, 0, 0, 0);
    };

    // ── Global PiP hotkeys ────────────────────────────────────────────────────
    // All use Ctrl+Shift to avoid conflicts with normal app or OS shortcuts.
    //   Ctrl+Shift+P     – toggle PiP on/off
    //   Ctrl+Shift+M     – cycle PiP mode (bar → float → minimal → bar)
    //   Ctrl+Shift+L     – toggle pin lock (float mode)
    //   Ctrl+Shift+C     – cycle corner (float mode)
    //   Ctrl+Shift+Arrow – move floating/minimal panel 20 px
    (function() {
        const MOVE_PX = 20;
        const PIP_MODES = ['bar', 'float', 'minimal'];
        document.addEventListener('keydown', function(e) {
            if (!e.ctrlKey || !e.shiftKey) return;
            const tgt = e.target;
            if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return;

            const panel = document.getElementById('jmp-pip-panel');
            const k = e.key;

            if (k === 'P' || k === 'p') {
                e.preventDefault();
                if (window._mpvMiniPlayerActive) {
                    window._nativeExitMiniPlayer();
                } else {
                    const pl = window._mpvVideoPlayerInstance;
                    if (pl && typeof pl.togglePictureInPicture === 'function') pl.togglePictureInPicture();
                    else window._nativeEnterMiniPlayer();
                }
                return;
            }
            if (k === 'M' || k === 'm') {
                if (!panel) return;
                e.preventDefault();
                const cur = localStorage.getItem('jmp_pip_mode') || 'bar';
                const next = PIP_MODES[(PIP_MODES.indexOf(cur) + 1) % PIP_MODES.length];
                localStorage.setItem('jmp_pip_mode', next);
                window._nativeExitMiniPlayer();
                window._nativeEnterMiniPlayer();
                return;
            }
            if (k === 'L' || k === 'l') {
                if (panel && panel._pipPinBtn) { e.preventDefault(); panel._pipPinBtn.click(); }
                return;
            }
            if (k === 'C' || k === 'c') {
                if (panel && panel._pipCornerBtn) { e.preventDefault(); panel._pipCornerBtn.click(); }
                return;
            }
            if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
                if (!panel || panel._isPinned) return;
                const mode = localStorage.getItem('jmp_pip_mode') || 'bar';
                if (mode === 'bar') return;
                e.preventDefault();
                const va = panel._videoArea;
                const cl = parseFloat(panel.style.left) || 0;
                const ct = parseFloat(panel.style.top)  || 0;
                const pw = panel.offsetWidth, ph = panel.offsetHeight;
                if (k === 'ArrowLeft')  panel.style.left = Math.max(0, cl - MOVE_PX) + 'px';
                if (k === 'ArrowRight') panel.style.left = Math.min(window.innerWidth  - pw, cl + MOVE_PX) + 'px';
                if (k === 'ArrowUp')    panel.style.top  = Math.max(0, ct - MOVE_PX) + 'px';
                if (k === 'ArrowDown')  panel.style.top  = Math.min(window.innerHeight - ph, ct + MOVE_PX) + 'px';
                if (va) _pipUpdateVideoRect(va);
            }
        });
    })();

    // window.NativeShell - app info and plugins
    const plugins = ['mpvVideoPlayer', 'mpvAudioPlayer', 'inputPlugin'];
    for (const plugin of plugins) {
        window[plugin] = () => window['_' + plugin];
    }

    window.NativeShell = {
        openUrl(url, target) {
            window.api.system.openExternalUrl(url);
        },
        downloadFile(info) {
            window.api.system.openExternalUrl(info.url);
        },
        openClientSettings() {
            window._openClientSettings();
        },
        getPlugins() {
            return plugins;
        }
    };

    // Device profile for direct play
    function getDeviceProfile() {
        return {
            Name: 'Jellyfin Desktop',
            MaxStaticBitrate: 1000000000,
            MusicStreamingTranscodingBitrate: 1280000,
            TimelineOffsetSeconds: 5,
            TranscodingProfiles: [
                { Type: 'Audio' },
                {
                    Container: 'ts',
                    Type: 'Video',
                    Protocol: 'hls',
                    AudioCodec: 'aac,mp3,ac3,opus,vorbis',
                    VideoCodec: 'h264,h265,hevc,mpeg4,mpeg2video',
                    MaxAudioChannels: '6'
                },
                { Container: 'jpeg', Type: 'Photo' }
            ],
            DirectPlayProfiles: [
                { Type: 'Video' },
                { Type: 'Audio' },
                { Type: 'Photo' }
            ],
            ResponseProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: [
                { Format: 'srt', Method: 'External' },
                { Format: 'srt', Method: 'Embed' },
                { Format: 'ass', Method: 'External' },
                { Format: 'ass', Method: 'Embed' },
                { Format: 'sub', Method: 'Embed' },
                { Format: 'ssa', Method: 'Embed' },
                { Format: 'pgssub', Method: 'Embed' },
                { Format: 'dvdsub', Method: 'Embed' }
            ]
        };
    }

    window.NativeShell.AppHost = {
        init() {
            return Promise.resolve({
                deviceName: jmpInfo.deviceName,
                appName: 'Jellyfin Desktop',
                appVersion: jmpInfo.version
            });
        },
        getDefaultLayout() {
            return jmpInfo.mode;
        },
        supports(command) {
            const features = [
                'filedownload', 'displaylanguage', 'htmlaudioautoplay',
                'htmlvideoautoplay', 'externallinks', 'multiserver',
                'fullscreenchange', 'remotevideo', 'displaymode',
                'exitmenu', 'clientsettings'
            ];
            return features.includes(command.toLowerCase());
        },
        getDeviceProfile,
        getSyncProfile: getDeviceProfile,
        appName() { return 'Jellyfin Desktop'; },
        appVersion() { return jmpInfo.version; },
        deviceName() { return jmpInfo.deviceName; },
        exit() { window.api.system.exit(); }
    };

    window.initCompleted = Promise.resolve();
    window.apiPromise = Promise.resolve(window.api);

    // Observe <meta name="theme-color"> for titlebar color sync.
    // jellyfin-web's themeManager.js updates this tag when the user switches themes.
    function sendThemeColor(color) {
        if (color && window.jmpNative && window.jmpNative.themeColor) {
            window.jmpNative.themeColor(color);
        }
    }

    function restoreThemeColor() {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) sendThemeColor(meta.content);
    }

    function observeThemeColorMeta(meta) {
        sendThemeColor(meta.content);
        new MutationObserver(() => sendThemeColor(meta.content))
            .observe(meta, { attributes: true, attributeFilter: ['content'] });
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Inject CSS to hide cursor when jellyfin-web signals mouse idle.
        // jellyfin-web adds 'mouseIdle' to body after inactivity during video playback.
        // This CSS makes CEF report CT_NONE so the native side can hide the OS cursor.
        const style = document.createElement('style');
        let css = 'body.mouseIdle, body.mouseIdle * { cursor: none !important; }';

        // macOS: offset UI elements so traffic lights don't overlap content
        if (navigator.platform.startsWith('Mac') && jmpInfo.settings.advanced.transparentTitlebar) {
            css += '\n:root { --mac-titlebar-height: 28px; }';
            css += '\n.skinHeader { padding-top: var(--mac-titlebar-height) !important; }';
            css += '\n.mainAnimatedPage { top: var(--mac-titlebar-height) !important; }';
            css += '\n.touch-menu-la { padding-top: var(--mac-titlebar-height); }';
            // Dashboard uses MUI AppBar + Drawer instead of .skinHeader
            css += '\n.MuiAppBar-positionFixed { padding-top: var(--mac-titlebar-height) !important; }';
            css += '\n.MuiDrawer-paper { padding-top: var(--mac-titlebar-height) !important; }';
            // Dialog headers (e.g. client settings modal)
            css += '\n.formDialogHeader { padding-top: var(--mac-titlebar-height) !important; }';

            // Hide/show traffic lights with the video OSD.
            // jellyfin-web uses an internal Events.trigger() system (obj._callbacks),
            // not DOM events. Register directly on that callback structure.
            document._callbacks = document._callbacks || {};
            document._callbacks['SHOW_VIDEO_OSD'] = document._callbacks['SHOW_VIDEO_OSD'] || [];
            document._callbacks['SHOW_VIDEO_OSD'].push((_e, visible) => {
                if (window.jmpNative && window.jmpNative.setOsdVisible) {
                    window.jmpNative.setOsdVisible(!!visible);
                }
            });
        }

        style.textContent = css;
        document.head.appendChild(style);

        // Titlebar black during video playback, restore theme color when done
        window.api.player.playing.connect(() => {
            if (window._jmpVideoActive) sendThemeColor('#000000');
        });
        window.api.player.finished.connect(() => { window._jmpVideoActive = false; restoreThemeColor(); });
        window.api.player.stopped.connect(() => { window._jmpVideoActive = false; restoreThemeColor(); });
        window.api.player.canceled.connect(() => { window._jmpVideoActive = false; restoreThemeColor(); });
        window.api.player.error.connect(() => { window._jmpVideoActive = false; restoreThemeColor(); });

        // Watch for mouseIdle class on body and tell native to hide/show cursor.
        // Direct IPC is more reliable than CSS cursor:none → OnCursorChange in OSR mode.
        new MutationObserver(() => {
            const idle = document.body.classList.contains('mouseIdle');
            window.jmpNative.setCursorVisible(!idle);
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // Sync titlebar color with theme-color meta tag
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            observeThemeColorMeta(meta);
        } else {
            // Tag may be added dynamically — watch for it
            new MutationObserver((mutations, obs) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeName === 'META' && node.name === 'theme-color') {
                            obs.disconnect();
                            observeThemeColorMeta(node);
                            return;
                        }
                    }
                }
            }).observe(document.head, { childList: true });
        }
    });

    console.log('[Media] Native shim installed');
})();
