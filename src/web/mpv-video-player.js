(function() {
    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(s => s.Type === 'Audio');
    }

    // Convert Jellyfin global MediaStream.Index to 1-based type-relative index
    function getRelativeIndexByType(mediaStreams, jellyIndex, streamType) {
        let relIndex = 1;
        for (const source of mediaStreams) {
            if (source.Type !== streamType || source.IsExternal) continue;
            if (source.Index === jellyIndex) return relIndex;
            relIndex += 1;
        }
        return null;
    }

    function getStreamByIndex(mediaStreams, index) {
        return mediaStreams.find(s => s.Index === index) || null;
    }

    class mpvVideoPlayer extends window.MpvPlayerBase {
        constructor(args) {
            super(args);
            const { loading, appRouter, globalize, dashboard, playbackManager } = args;
            this.loading = loading;
            this.appRouter = appRouter;
            this.globalize = globalize;
            this.playbackManager = playbackManager;
            if (dashboard && dashboard.default) {
                this.setTransparency = dashboard.default.setBackdropTransparency.bind(dashboard);
            } else {
                this.setTransparency = () => {};
            }

            this.id = 'mpvvideoplayer';
            this.logTag = 'Video';
            this.name = 'MPV Video Player';
            this.syncPlayWrapAs = 'htmlvideoplayer';
            this.priority = -1;
            this.useFullSubtitleUrls = true;
            this.isLocalPlayer = true;
            this.isFetching = false;
            this._isMiniPlayer = false;

            window._mpvVideoPlayerInstance = this;

            this._videoDialog = undefined;
            this._currentSrc = undefined;
            this._timeUpdated = false;
            this._currentPlayOptions = undefined;
            this._endedPending = false;

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;

            this.handlers.onPlaying = () => {
                if (!this._started) {
                    this._started = true;
                    this.loading.hide();
                    const dlg = this._videoDialog;
                    // Remove poster so video shows through from subsurface
                    if (dlg) {
                        const poster = dlg.querySelector('.mpvPoster');
                        if (poster) poster.remove();
                    }
                    // "fullscreen" = fills entire web content area, not the actual screen
                    if (this._currentPlayOptions?.fullscreen) {
                        this.appRouter.showVideoOsd();
                        if (dlg) dlg.style.zIndex = 'unset';
                    }
                    if (!window._mpvDetachedPipActive) {
                        window.api.player.setVideoRectangle(0, 0, 0, 0);
                    }
                }
                this._emitPlaying();
            };

            this.handlers.onTimeUpdate = (time) => {
                if (time && !this._timeUpdated) this._timeUpdated = true;
                this._seeking = false;
                this._currentTime = time;
                this.events.trigger(this, 'timeupdate');
            };

            this.handlers.onEnded = () => {
                if (!this._endedPending) {
                    this._endedPending = true;
                    this.onEndedInternal();
                }
            };

            this.handlers.onError = (error) => {
                this.removeMediaDialog();
                console.error(`[Media] [${this.logTag}] media error:`, error);
                this.events.trigger(this, 'error', [{ type: 'mediadecodeerror' }]);
            };
        }

        async play(options) {
            console.debug(`[Media] [${this.logTag}] play() called with options:`, options);
            this._started = false;
            this._timeUpdated = false;
            this._currentTime = null;
            this._endedPending = false;
            if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();
            if (options.fullscreen) this.loading.show();  // fills entire web content area, not the actual screen
            await this.createMediaElement(options);
            console.debug(`[Media] [${this.logTag}] createMediaElement done, calling setCurrentSrc`);
            const result = await this.setCurrentSrc(options);

            // needed when only audio is single external
            const externalAudio = options.mediaSource?.MediaStreams?.find(s => s.Type === 'Audio' && s.IsExternal);
            if (externalAudio && options.playMethod !== 'Transcode') {
                this.setAudioStreamIndex(externalAudio.Index);
            }

            // If autoplay triggered while PiP was active, refresh the panel now that
            // _currentPlayOptions is populated with the new item's metadata.
            if (this._pipReenterAfterPlay) {
                this._pipReenterAfterPlay = false;
                window._nativeExitMiniPlayer();
                this._isMiniPlayer = true;
                window._nativeEnterMiniPlayer();
            }
            if (this._pipRefreshDetachedBar) {
                this._pipRefreshDetachedBar = false;
                if (window._nativeRefreshDetachedControlsBar) {
                    window._nativeRefreshDetachedControlsBar();
                }
            }
            return result;
        }

        get mediaType() { return 'video'; }

        _resolveTracks(options) {
            const streams = options.mediaSource?.MediaStreams || [];
            let defaultAudioIdx = options.mediaSource.DefaultAudioStreamIndex ?? -1;
            const defaultSubIdx = options.mediaSource.DefaultSubtitleStreamIndex ?? -1;

            if (defaultAudioIdx < 0) {
                const fallback = streams.find(s => s.Type === 'Audio' && !s.IsExternal)
                    ?? streams.find(s => s.Type === 'Audio');
                if (fallback) defaultAudioIdx = fallback.Index;
            }

            // Mirror jellyfin-web's UI selection exactly: feed mpv the relative
            // index for DefaultAudioStreamIndex, or TRACK_DISABLE if none is selected.
            // mpv auto track selection is completely disabled as it conflicts with
            // the fact that jellyfin-web is ultimately responsible for that.
            let audioParam = MpvPlayerBase.TRACK_DISABLE;
            let externalAudioUrl = null;
            if (options.playMethod === 'Transcode') {
                // Server bakes the chosen audio into the transcoded output
                // (single audio track in the m3u8). Source MediaStreams indexing
                // doesn't apply — see htmlVideoPlayer/plugin.js:514 for the same
                // logic. Don't audio-add either; audio is already in the stream.
                audioParam = 1;
            } else if (defaultAudioIdx >= 0) {
                const audioStream = getStreamByIndex(streams, defaultAudioIdx);
                if (audioStream && audioStream.DeliveryMethod === 'External' && audioStream.DeliveryUrl) {
                    externalAudioUrl = audioStream.DeliveryUrl;
                } else {
                    const relIdx = getRelativeIndexByType(streams, defaultAudioIdx, 'Audio');
                    audioParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                }
            }

            let subParam = MpvPlayerBase.TRACK_DISABLE;
            let externalSubUrl = null;
            if (defaultSubIdx >= 0) {
                const subStream = getStreamByIndex(streams, defaultSubIdx);
                if (subStream && subStream.DeliveryMethod === 'External' && subStream.DeliveryUrl) {
                    externalSubUrl = subStream.DeliveryUrl;
                } else {
                    const relIdx = getRelativeIndexByType(streams, defaultSubIdx, 'Subtitle');
                    subParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                }
            }

            return { videoParam: 1, audioParam, subParam, externalAudioUrl, externalSubUrl };
        }

        _beforeLoad(options) {
            window.api.player.setAspectMode(options?.aspectRatio || this.getAspectRatio());
        }

        setSubtitleStreamIndex(index) {
            if (index == null || index < 0) {
                window.api.player.setSubtitleStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                window.api.player.addSubtitleStream(stream.DeliveryUrl);
                return;
            }
            const relIdx = getRelativeIndexByType(streams, index, 'Subtitle');
            window.api.player.setSubtitleStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        setSecondarySubtitleStreamIndex(index) {}

        resetSubtitleOffset() {
            this._currentSubtitleOffset = 0;
            this._showSubtitleOffset = false;
            window.api.player.setSubtitleDelay(0);
        }

        enableShowingSubtitleOffset() { this._showSubtitleOffset = true; }
        disableShowingSubtitleOffset() { this._showSubtitleOffset = false; }
        isShowingSubtitleOffsetEnabled() { return this._showSubtitleOffset === true; }
        setSubtitleOffset(offset) {
            const v = parseFloat(offset) || 0;
            this._currentSubtitleOffset = v;
            window.api.player.setSubtitleDelay(Math.round(v * 1000));
        }
        getSubtitleOffset() { return this._currentSubtitleOffset || 0; }

        setAudioStreamIndex(index) {
            if (index == null || index < 0) {
                window.api.player.setAudioStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream?.IsExternal) {
                // External audio isn't part of the source container and the server
                // doesn't pre-publish a DeliveryUrl for it, so we can't audio-add
                // client-side. Re-enter playbackManager with canSetAudioStreamIndex
                // forced false so it routes through changeStream — the server then
                // regenerates the playback URL with the external audio attached.
                this._forceServerReload = true;
                try {
                    this.playbackManager.setAudioStreamIndex(index, this);
                } finally {
                    this._forceServerReload = false;
                }
                return;
            }
            const relIdx = getRelativeIndexByType(streams, index, 'Audio');
            window.api.player.setAudioStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        onEndedInternal() {
            // If PiP is active, flag the next createMediaElement call as autoplay so
            // the panel stays alive for the next track instead of being torn down.
            this._pipAutoplayPending = !!this._isMiniPlayer || !!window._mpvDetachedPipActive;
            super.onEndedInternal();
        }

        stop(destroyPlayer) {
            // While in mini-player mode, suppress all stops so mpv keeps playing across
            // page navigation. The stop button in the overlay calls window.api.player.stop()
            // directly (bypassing this method), so that still works correctly.
            if (this._isMiniPlayer) {
                return Promise.resolve();
            }
            if (!destroyPlayer && this._videoDialog && this._currentPlayOptions?.backdropUrl) {
                const dlg = this._videoDialog;
                const url = this._currentPlayOptions.backdropUrl;
                if (!dlg.querySelector('.mpvPoster')) {
                    const poster = document.createElement('div');
                    poster.classList.add('mpvPoster');
                    poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:#000 url('${url}') center/cover no-repeat;`;
                    dlg.appendChild(poster);
                }
            }
            window.api.player.stop();
            this.handlers.onEnded();
            if (destroyPlayer) this.destroy();
            return Promise.resolve();
        }

        removeMediaDialog() {
            window.api.player.stop();
            if (window.jmpNative) window.jmpNative.playerOsdActive(false);
            window.api.player.setVideoRectangle(-1, 0, 0, 0);
            document.body.classList.remove('hide-scroll');
            const dlg = this._videoDialog;
            if (dlg) {
                this.setTransparency(0);
                this._videoDialog = null;
                if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
            }
        }

        destroy() {
            if (this._isMiniPlayer) {
                // Keep mpv playing — only tear down the transparent full-screen overlay.
                document.body.classList.remove('hide-scroll');
                const dlg = this._videoDialog;
                if (dlg) {
                    this.setTransparency(0);
                    this._videoDialog = null;
                    if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
                }
                if (window.jmpNative) window.jmpNative.playerOsdActive(false);
            } else {
                this.removeMediaDialog();
            }
            this.disconnectSignals();

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;
        }

        createMediaElement(options) {
            // If new media starts while the mini bar is active, decide whether to
            // keep PiP or exit based on whether this is an autoplay continuation.
            if (window._mpvMiniPlayerActive) {
                if (this._pipAutoplayPending) {
                    // Autoplay next track: stay in PiP. Panel will be refreshed
                    // after setCurrentSrc() sets the new _currentPlayOptions.
                    this._pipAutoplayPending = false;
                    this._pipReenterAfterPlay = true;
                } else {
                    // User explicitly started new media from the menu — exit PiP so
                    // the new video takes over in full-screen mode.
                    window._nativeExitMiniPlayer();
                    this._isMiniPlayer = false;
                }
            }
            // Pop-out window: keep video in the pip HWND; avoid a full-screen
            // transparent overlay on the main window (that blanks CEF when sizes drift).
            if (window._mpvDetachedPipActive) {
                if (this._pipAutoplayPending) {
                    this._pipAutoplayPending = false;
                }
                this._pipRefreshDetachedBar = true;
                this.connectSignals();
                return Promise.resolve();
            }
            let dlg = document.querySelector('.videoPlayerContainer');
            const isNewDlg = !dlg;
            if (isNewDlg) {
                if (window.jmpNative) window.jmpNative.playerOsdActive(true);
                dlg = document.createElement('div');
                dlg.classList.add('videoPlayerContainer');
                dlg.style.cssText = 'position:fixed;top:0;bottom:0;left:0;right:0;display:flex;align-items:center;background:transparent;';
                if (options.fullscreen) dlg.style.zIndex = 1000;  // fills entire web content area, not the actual screen
                document.body.insertBefore(dlg, document.body.firstChild);
                this._videoDialog = dlg;

                this.connectSignals();
                if (window.jmpNative) {
                    window.jmpNative.notifyRateChange(this._playRate);
                }
            } else {
                this._videoDialog = dlg;
            }

            const existing = dlg.querySelector('.mpvPoster');
            if (existing) existing.remove();
            const poster = document.createElement('div');
            poster.classList.add('mpvPoster');
            const bg = options.backdropUrl
                ? `#000 url('${options.backdropUrl}') center/cover no-repeat`
                : '#000';
            poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:${bg};`;

            const ready = new Promise((resolve) => {
                if (isNewDlg && options.fullscreen) {
                    dlg.style.animation = 'mpv-video-zoomin 240ms ease-in normal';
                    dlg.addEventListener('animationend', resolve, { once: true });
                } else {
                    resolve();
                }
            });
            if (isNewDlg) ready.then(() => this.setTransparency(2));
            dlg.appendChild(poster);

            if (options.fullscreen) document.body.classList.add('hide-scroll');  // fills entire web content area, not the actual screen
            return ready;
        }

        canPlayMediaType(mediaType) {
            return (mediaType || '').toLowerCase() === 'video';
        }
        canPlayItem(item) { return this.canPlayMediaType(item.MediaType); }
        supportsPlayMethod() { return true; }
        static getSupportedFeatures() { return ['PlaybackRate', 'SetAspectRatio', 'PictureInPicture']; }
        supports(feature) { return mpvVideoPlayer.getSupportedFeatures().includes(feature); }
        isFullscreen() { return window._isFullscreen === true; }
        toggleFullscreen() {
            if (window.jmpNative) window.jmpNative.toggleFullscreen();
        }

        setPlaybackRate(value) {
            super.setPlaybackRate(value);
            if (window.jmpNative) window.jmpNative.notifyRateChange(value);
        }

        canSetAudioStreamIndex() { return !this._forceServerReload; }
        setPictureInPictureEnabled(enabled) { if (enabled !== this._isMiniPlayer) this.togglePictureInPicture(); }
        isPictureInPictureEnabled() { return this._isMiniPlayer; }
        isAirPlayEnabled() { return false; }
        setAirPlayEnabled() {}
        setBrightness() {}
        getBrightness() { return 100; }

        togglePictureInPicture() {
            this._isMiniPlayer = !this._isMiniPlayer;
            if (this._isMiniPlayer) {
                window._nativeEnterMiniPlayer();

                // Jellyfin's inputManager routes arrow keys as seek/volume commands
                // whenever playbackManager.isPlaying() is true. Override it to return
                // false while the pip is active so arrow keys go to the focus manager
                // for normal home page navigation instead.
                const pm = window.playbackManager;
                if (pm && typeof pm.isPlaying === 'function' && !pm._mpvPipIsPlayingOrig) {
                    pm._mpvPipIsPlayingOrig = pm.isPlaying.bind(pm);
                    pm.isPlaying = function() {
                        if (window._mpvMiniPlayerActive || window._mpvDetachedPipActive) return false;
                        return pm._mpvPipIsPlayingOrig();
                    };
                }

                // Navigate away so the user can browse the library
                if (this.appRouter && typeof this.appRouter.home === 'function') {
                    this.appRouter.home();
                } else {
                    window.history.back();
                }

                // Retry-focus the first home page item to restore arrow-key navigation.
                const tryFocusHome = (attempts) => {
                    const card = document.querySelector(
                        '.homeSections .card, .homePage .card, .homeSectionsContainer .card, ' +
                        '[data-page] .card, .section-items .card, .itemsContainer .card, ' +
                        '.itemsContainer a, .homeSections a[tabindex], .homeSections [tabindex="0"]'
                    );
                    if (card) {
                        card.focus({ preventScroll: true });
                    } else if (attempts > 0) {
                        setTimeout(() => tryFocusHome(attempts - 1), 300);
                    }
                };
                setTimeout(() => tryFocusHome(10), 500);
            } else {
                // Restore playbackManager.isPlaying() before exiting PiP.
                const pm = window.playbackManager;
                if (pm && pm._mpvPipIsPlayingOrig) {
                    pm.isPlaying = pm._mpvPipIsPlayingOrig;
                    delete pm._mpvPipIsPlayingOrig;
                }

                window._nativeExitMiniPlayer();
            }
        }
        toggleAirPlay() {}
        getStats() { return Promise.resolve({ categories: [] }); }
        getSupportedAspectRatios() {
            return [
                { id: 'auto',  name: this.globalize.translate('Auto') },
                { id: 'cover', name: this.globalize.translate('AspectRatioCover') },
                { id: 'fill',  name: this.globalize.translate('AspectRatioFill') }
            ];
        }
        getAspectRatio() {
            const aspectRatio = typeof this.appSettings.aspectRatio === 'function'
                ? this.appSettings.aspectRatio()
                // Support jellyfin-web v10.10.7
                : this._currentAspectRatio;

            return aspectRatio || 'auto';
        }
        setAspectRatio(value) {
            if (typeof this.appSettings.aspectRatio === 'function') {
                this.appSettings.aspectRatio(value);
            } else {
                // Support jellyfin-web v10.10.7
                this._currentAspectRatio = value;
            }
            window.api.player.setAspectMode(value);
        }
    }

    window._mpvVideoPlayer = mpvVideoPlayer;
    console.debug('[Media] mpvVideoPlayer class installed');
})();
