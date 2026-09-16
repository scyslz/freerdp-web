export function getTransportModeFromQuery() {
    try {
        const params = new URLSearchParams(window.location?.search || '');
        const mode = params.get('transport');
        if (mode === 'ws' || mode === 'rtc' || mode === 'auto') return mode;
    } catch {}
    return null;
}

export function getStunUrlsFromQuery() {
    try {
        const params = new URLSearchParams(window.location?.search || '');
        const stun = params.get('stun');
        if (stun) return stun.split(',').map((s) => s.trim()).filter(Boolean);
    } catch {}
    return null;
}

export const DEFAULT_STUN_URLS = ['stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'];

export class RtcMediaTransport {
    constructor(signaling, opts = {}) {
        this._signaling = signaling;
        this._stunUrls = opts.stunUrls && opts.stunUrls.length ? opts.stunUrls : DEFAULT_STUN_URLS;
        this._timeoutMs = opts.timeoutMs || 10000;
        this._pc = null;
        this._controlDc = null;
        this._mediaDc = null;
        this._closed = false;
        this._timeoutTimer = null;
        this.onmedia = null;
        this.onstate = null;
        this.onerror = null;
    }
    isControlOpen() {
        return !!this._controlDc && this._controlDc.readyState === 'open';
    }
    isMediaOpen() {
        return !!this._mediaDc && this._mediaDc.readyState === 'open';
    }
    isOpen() {
        return this.isControlOpen() && this.isMediaOpen();
    }
    async start() {
        if (this._pc) throw new Error('RTC already started');
        if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC unsupported');
        this._closed = false;
        const pc = new RTCPeerConnection({ iceServers: [{ urls: this._stunUrls }] });
        this._pc = pc;
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                try {
                    this._signaling.sendJson({
                        type: 'rtc-ice',
                        candidate: {
                            candidate: e.candidate.candidate,
                            sdpMid: e.candidate.sdpMid,
                            sdpMLineIndex: e.candidate.sdpMLineIndex
                        }
                    });
                } catch {}
            }
        };
        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            if (st === 'failed') this._fail(new Error('RTC connection failed'));
            else if (st === 'disconnected') this.onstate?.('disconnected');
            else if (st === 'closed') this.onstate?.('closed');
            else if (st === 'connected') this._checkOpen();
        };
        pc.ondatachannel = (e) => {
            const ch = e.channel;
            if (ch.label === 'media') {
                this._mediaDc = ch;
                ch.binaryType = 'arraybuffer';
                ch.onmessage = (ev) => this.onmedia?.({ data: ev.data });
                ch.onopen = () => this._checkOpen();
                ch.onclose = () => this.onstate?.('media-closed');
            }
        };
        const control = pc.createDataChannel('control', { ordered: true });
        this._controlDc = control;
        control.binaryType = 'arraybuffer';
        control.onopen = () => this._checkOpen();
        control.onclose = () => this.onstate?.('control-closed');
        control.onerror = (e) => this.onerror?.(e);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        try {
            this._signaling.sendJson({ type: 'rtc-offer', sdp: pc.localDescription.sdp });
        } catch (e) {
            throw e;
        }
        this._timeoutTimer = setTimeout(() => {
            if (!this.isOpen() && !this._closed) this._fail(new Error('RTC timeout'));
        }, this._timeoutMs);
        return true;
    }
    _checkOpen() {
        if (this._closed) return;
        if (this.isOpen()) {
            if (this._timeoutTimer) {
                clearTimeout(this._timeoutTimer);
                this._timeoutTimer = null;
            }
            this.onstate?.('open');
        }
    }
    _fail(err) {
        if (this._closed) return;
        if (this._timeoutTimer) {
            clearTimeout(this._timeoutTimer);
            this._timeoutTimer = null;
        }
        this.onerror?.(err);
        this.onstate?.('failed');
    }
    async handleAnswer(sdp) {
        if (!this._pc) return;
        await this._pc.setRemoteDescription({ type: 'answer', sdp });
    }
    async handleRemoteIce(candidate) {
        if (!this._pc || !candidate) return;
        try {
            await this._pc.addIceCandidate(candidate);
        } catch {}
    }
    sendControl(data) {
        if (this.isControlOpen() && data) {
            try {
                this._controlDc.send(data);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }
    async getRttMs() {
        const info = await this.getSelectedCandidateInfo();
        return info?.rttMs ?? null;
    }
    async getSelectedCandidateInfo() {
        try {
            if (!this._pc) return null;
            const stats = await this._pc.getStats();
            let pair = null;
            const remotes = new Map();
            stats.forEach((r) => {
                if (r.type === 'remote-candidate') remotes.set(r.id, r);
                else if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
            });
            if (!pair) stats.forEach((r) => {
                if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r;
            });
            if (!pair) return null;
            const remote = remotes.get(pair.remoteCandidateId);
            return {
                candidateType: remote?.candidateType || null,
                rttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
            };
        } catch {
            return null;
        }
    }
    close() {
        this._closed = true;
        if (this._timeoutTimer) {
            clearTimeout(this._timeoutTimer);
            this._timeoutTimer = null;
        }
        try { this._controlDc?.close(); } catch {}
        try { this._mediaDc?.close(); } catch {}
        try { this._pc?.close(); } catch {}
        this._controlDc = null;
        this._mediaDc = null;
        this._pc = null;
    }
}

export class WsTransport {
    constructor(url) {
        this.url = url;
        this.kind = 'ws';
        this._ws = null;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            ws.binaryType = 'arraybuffer';
            this._ws = ws;
            ws.onopen = (e) => { this.onopen?.(e); resolve(); };
            ws.onmessage = (e) => this.onmessage?.(e);
            ws.onerror = (e) => { this.onerror?.(e); reject(e); };
            ws.onclose = (e) => this.onclose?.(e);
        });
    }
    isOpen() {
        return !!this._ws && this._ws.readyState === WebSocket.OPEN;
    }
    isClosed() {
        return !this._ws || this._ws.readyState === WebSocket.CLOSED;
    }
    sendJson(obj) {
        if (this.isOpen()) this._ws.send(JSON.stringify(obj));
    }
    sendBytes(data) {
        if (this.isOpen() && data) this._ws.send(data);
    }
    close() {
        try { this._ws?.close(); } catch {}
        this._ws = null;
    }
}
