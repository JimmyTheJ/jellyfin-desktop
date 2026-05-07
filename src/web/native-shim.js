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

    // Mini player — Plex-style persistent bottom bar
    window._mpvMiniPlayerActive = false;

    window._nativeEnterMiniPlayer = function() {
        if (document.getElementById('jmp-mini-bar')) return;

        const BAR_H = 96, VID_HOLE_W = 152, VID_HOLE_H = 84, VID_PAD_X = 8, VID_PAD_Y = 6;
        const WRAPPER_W = VID_HOLE_W + VID_PAD_X * 2; // 168 — total width of video pane section

        // --- Bar shell ---
        const bar = document.createElement('div');
        bar.id = 'jmp-mini-bar';
        bar.style.cssText = [
            'position:fixed', 'bottom:0', 'left:0', 'right:0', 'height:' + BAR_H + 'px',
            'background:rgba(10,10,10,0.93)',
            'border-top:1px solid rgba(255,255,255,0.10)',
            'z-index:10000', 'display:flex', 'align-items:center',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'box-sizing:border-box'
        ].join(';');

        // Progress bar — spans only the non-video portion of the bar so it isn't
        // zeroed by ClearView (which only clears the leftmost VID_W columns).
        const progressBg = document.createElement('div');
        // Full-width progress bar at the very bottom of the bar.
        // Positioned below the ClearView zone (hole ends VID_PAD_Y px above bar bottom),
        // so it won't be zeroed by ClearView.
        progressBg.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:3px;' +
            'background:rgba(255,255,255,0.15);overflow:hidden;cursor:pointer;z-index:1;';
        const progressFill = document.createElement('div');
        progressFill.style.cssText = 'height:100%;background:#00a4dc;width:0%;pointer-events:none;' +
            'transition:width 0.8s linear;';
        progressBg.appendChild(progressFill);
        bar.appendChild(progressBg);

        // Seek on click
        progressBg.addEventListener('click', (e) => {
            const rect = progressBg.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const dur = bar._duration || 0;
            if (dur > 0) window.api.input.positionSeek(fraction * dur);
        });

        // --- Video pane: wrapper provides visual padding; inner videoArea is the transparent hole ---
        const videoWrapper = document.createElement('div');
        videoWrapper.style.cssText = [
            'width:' + WRAPPER_W + 'px', 'height:' + BAR_H + 'px', 'flex-shrink:0',
            'display:flex', 'align-items:center', 'justify-content:center',
            'border-right:1px solid rgba(255,255,255,0.08)',
            'box-sizing:border-box', 'cursor:pointer',
            'padding:' + VID_PAD_Y + 'px ' + VID_PAD_X + 'px'
        ].join(';');
        videoWrapper.title = 'Click to restore player';
        const videoArea = document.createElement('div');
        videoArea.style.cssText = 'width:' + VID_HOLE_W + 'px;height:' + VID_HOLE_H + 'px;' +
            'background:transparent;flex-shrink:0;';
        videoWrapper.appendChild(videoArea);
        bar.appendChild(videoWrapper);

        // --- Info (show name / episode / time — three stacked rows) ---
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;padding:0 16px;overflow:hidden;min-width:0;' +
            'display:flex;flex-direction:column;justify-content:center;gap:3px;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'color:#fff;font-size:14px;font-weight:700;white-space:nowrap;' +
            'overflow:hidden;text-overflow:ellipsis;';
        titleEl.textContent = '';

        const subtitleEl = document.createElement('div');
        subtitleEl.style.cssText = 'color:rgba(255,255,255,0.70);font-size:11px;white-space:nowrap;' +
            'overflow:hidden;text-overflow:ellipsis;';
        subtitleEl.textContent = '';

        const timeEl = document.createElement('div');
        timeEl.style.cssText = 'color:rgba(255,255,255,0.45);font-size:11px;white-space:nowrap;';
        timeEl.textContent = '';

        info.appendChild(titleEl);
        info.appendChild(subtitleEl);
        info.appendChild(timeEl);
        bar.appendChild(info);

        // Populate title/episode from the current play options stored on the player instance.
        // This is more reliable than playbackManager.currentItem() which can return null.
        try {
            const player = window._mpvVideoPlayerInstance;
            const item = player && player._currentPlayOptions && player._currentPlayOptions.item;
            if (item) {
                if (item.SeriesName) {
                    titleEl.textContent = item.SeriesName;
                    let ep = '';
                    if (item.ParentIndexNumber != null) ep += 'S' + item.ParentIndexNumber;
                    if (item.IndexNumber != null) ep += (ep ? ' ' : '') + 'E' + item.IndexNumber;
                    const fullEp = ep + (item.Name ? (ep ? '  ·  ' : '') + item.Name : '');
                    bar._episodeLabel = fullEp;
                    subtitleEl.textContent = fullEp;
                } else {
                        titleEl.textContent = item.Name || 'Playing';
                        bar._episodeLabel = '';
                    }
                }
            }
        } catch (_) {}

        // --- Controls ---
        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:0;padding:0 12px;flex-shrink:0;';

        const btnCss = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;' +
            'padding:6px 9px;border-radius:4px;line-height:1;opacity:0.8;transition:opacity 0.1s,' +
            'background 0.1s;';
        const mkBtn = (icon, title) => {
            const b = document.createElement('button');
            b.style.cssText = btnCss;
            b.textContent = icon;
            b.title = title;
            b.setAttribute('tabindex', '-1');
            b.addEventListener('mouseenter', () => { b.style.opacity = '1'; b.style.background = 'rgba(255,255,255,0.1)'; });
            b.addEventListener('mouseleave', () => { b.style.opacity = '0.8'; b.style.background = 'none'; });
            return b;
        };

        const pauseBtn = mkBtn(playerState.paused ? '\u25B6' : '\u23F8', 'Play/Pause');
        pauseBtn.id = 'jmp-mini-pause';
        pauseBtn.style.fontSize = '22px';

        const expandBtn = mkBtn('\u26F6', 'Restore full player'); // ⛶
        const stopBtn   = mkBtn('\u2715', 'Stop playback');       // ✕

        // Volume: icon + range slider
        const volWrap = document.createElement('div');
        volWrap.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 6px;';
        const volIcon = document.createElement('span');
        volIcon.style.cssText = 'color:rgba(255,255,255,0.7);font-size:15px;cursor:default;';
        volIcon.textContent = '\uD83D\uDD0A'; // 🔊
        const volSlider = document.createElement('input');
        volSlider.type = 'range';
        volSlider.min = '0'; volSlider.max = '100';
        volSlider.style.cssText = 'width:64px;height:3px;cursor:pointer;accent-color:#00a4dc;' +
            'outline:none;border:none;background:rgba(255,255,255,0.2);border-radius:2px;';
        volSlider.value = String(Math.round((window.api.player.volume || 100)));
        volWrap.appendChild(volIcon);
        volWrap.appendChild(volSlider);

        controls.appendChild(pauseBtn);
        controls.appendChild(volWrap);
        controls.appendChild(expandBtn);
        controls.appendChild(stopBtn);
        bar.appendChild(controls);

        // --- Signal connections ---
        const onPaused  = () => { const b = document.getElementById('jmp-mini-pause'); if (b) b.textContent = '\u25B6'; };
        const onPlaying = () => { const b = document.getElementById('jmp-mini-pause'); if (b) b.textContent = '\u23F8'; };
        window.api.player.paused.connect(onPaused);
        window.api.player.playing.connect(onPlaying);
        bar._onPaused  = onPaused;
        bar._onPlaying = onPlaying;

        // Progress + time updates
        const fmtTime = (ms) => {
            const s = Math.floor(ms / 1000);
            const m = Math.floor(s / 60), sec = s % 60;
            return m + ':' + String(sec).padStart(2, '0');
        };
        const onTimePos = (posMs) => {
            const durMs = bar._duration || 0;
            if (durMs > 0) {
                progressFill.style.width = Math.min(100, (posMs / durMs) * 100) + '%';
                timeEl.textContent = fmtTime(posMs) + ' / ' + fmtTime(durMs);
            }
        };
        const onDuration = (durMs) => { bar._duration = durMs; };
        window.api.player.positionUpdate.connect(onTimePos);
        window.api.player.updateDuration.connect(onDuration);
        bar._onTimePos  = onTimePos;
        bar._onDuration = onDuration;

        // Seed duration from current playerState if already known
        bar._duration = playerState.duration;

        // Volume slider (no live signal — seed from playerState, update on user input)
        volSlider.value = String(Math.round(playerState.volume));
        volSlider.addEventListener('input', () => window.api.player.setVolume(Number(volSlider.value)));

        // --- Button actions ---
        pauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (playerState.paused) window.api.player.play();
            else window.api.player.pause();
        });

        const doExpand = (e) => {
            if (e) e.stopPropagation();
            window._nativeExitMiniPlayer();
            const player = window._mpvVideoPlayerInstance;
            const router = player && player.appRouter;
            if (router && typeof router.showVideoOsd === 'function') router.showVideoOsd();
            else if (router && typeof router.back === 'function') router.back();
            else window.history.back();
        };
        videoWrapper.addEventListener('click', doExpand);
        expandBtn.addEventListener('click', doExpand);

        stopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window._nativeExitMiniPlayer();
            window.api.player.stop();
        });

        // --- Window resize: keep the video hole in sync ---
        const updateVideoRect = () => {
            const r = videoArea.getBoundingClientRect();
            window.api.player.setVideoRectangle(r.left, r.top, r.width, r.height);
        };
        window.addEventListener('resize', updateVideoRect);
        bar._onResize = updateVideoRect;

        // --- Inject page padding so content isn't hidden behind the bar ---
        if (!document.getElementById('jmp-mini-bar-style')) {
            const st = document.createElement('style');
            st.id = 'jmp-mini-bar-style';
            st.textContent = 'body { padding-bottom: ' + BAR_H + 'px !important; }';
            document.head.appendChild(st);
        }

        // Remove any lingering full-screen video overlay before appending the bar.
        const vcDlg = document.querySelector('.videoPlayerContainer');
        if (vcDlg && vcDlg.parentNode) vcDlg.parentNode.removeChild(vcDlg);
        document.body.classList.remove('hide-scroll');
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';

        document.body.appendChild(bar);
        window._mpvMiniPlayerActive = true;

        // Position mpv video into the transparent hole (bottom-left of bar).
        updateVideoRect();
    };

    window._nativeExitMiniPlayer = function() {
        const bar = document.getElementById('jmp-mini-bar');
        if (!bar) {
            window._mpvMiniPlayerActive = false;
            return;
        }
        if (bar._onPaused)   window.api.player.paused.disconnect(bar._onPaused);
        if (bar._onPlaying)  window.api.player.playing.disconnect(bar._onPlaying);
        if (bar._onTimePos)  window.api.player.positionUpdate.disconnect(bar._onTimePos);
        if (bar._onDuration) window.api.player.updateDuration.disconnect(bar._onDuration);
        if (bar._onResize)   window.removeEventListener('resize', bar._onResize);
        if (bar.parentNode)  bar.parentNode.removeChild(bar);
        const st = document.getElementById('jmp-mini-bar-style');
        if (st && st.parentNode) st.parentNode.removeChild(st);
        window._mpvMiniPlayerActive = false;
        const player = window._mpvVideoPlayerInstance;
        if (player) player._isMiniPlayer = false;
        window.api.player.setVideoRectangle(0, 0, 0, 0);
    };

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
