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

export function getTurnFromQuery() {
    try {
        const params = new URLSearchParams(window.location?.search || '');
        const urls = params.get('turn');
        if (!urls) return null;
        return {
            urls: urls.split(',').map((s) => s.trim()).filter(Boolean),
            username: params.get('turnUser') || params.get('turnUsername') || '',
            credential: params.get('turnPass') || params.get('turnPassword') || params.get('turnCredential') || '',
        };
    } catch {}
    return null;
}

export const DEFAULT_STUN_URLS = [
    'stun:stun.miwifi.com:3478',
    'stun:stun.qq.com:3478',
    'stun:stun.chat.bilibili.com:3478',
];

export function expandStunServers(urls) {
    const list = (urls && urls.length ? urls : DEFAULT_STUN_URLS)
        .map((s) => String(s).trim()).filter(Boolean);
    return [...new Set(list)];
}

export function expandIceServers(opts = {}) {
    const stuns = expandStunServers(opts.stunUrls);
    const servers = stuns.map((u) => ({ urls: u }));
    const turns = opts.turnUrls && opts.turnUrls.length ? opts.turnUrls : [];
    for (const u of turns) {
        const entry = { urls: u };
        if (opts.turnUsername) entry.username = opts.turnUsername;
        if (opts.turnCredential) entry.credential = opts.turnCredential;
        servers.push(entry);
    }
    return servers;
}

export async function fetchIceServers(url = '/ice-servers', timeoutMs = 4000) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin' });
        clearTimeout(timer);
        if (!res.ok) return null;
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
            return data.iceServers;
        }
        return null;
    } catch {
        return null;
    }
}

export class RtcMediaTransport {
    constructor(signaling, opts = {}) {
        this._signaling = signaling;
        this._route = 'rtc';
        this._background = !!opts.background;
        this._iceServers = opts.iceServers && opts.iceServers.length
            ? opts.iceServers
            : expandIceServers(opts);
        this._offerSeq = 0;
        this._pendingOfferId = null;
        this._answerApplying = false;
        this._iceQueue = [];
        this._kpWait = null;
        this.oncontrol = null;
        const firstStun = (opts.stunUrls && opts.stunUrls[0])
            || (opts.stunUrl)
            || (this._iceServers.find((s) => String(s.urls || '').startsWith('stun:')) || {}).urls
            || DEFAULT_STUN_URLS[0];
        this._stunUrl = firstStun;
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
    get stunUrl() {
        return this._stunUrl;
    }
    async start() {
        if (this._pc) throw new Error('RTC already started');
        if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC unsupported');
        this._closed = false;
        const pcConfig = { iceServers: this._iceServers };
        const pc = new RTCPeerConnection(pcConfig);
        this._pc = pc;
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                try {
                    this._signaling.sendJson({
                        type: 'rtc-ice',
                        route: this._route,
                        offerId: this._pendingOfferId,
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
        control.onmessage = (ev) => this._onControlMessage(ev);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._offerSeq += 1;
        this._pendingOfferId = this._offerSeq;
        try {
            this._signaling.sendJson({
                type: 'rtc-offer', sdp: pc.localDescription.sdp,
                route: this._route, offerId: this._pendingOfferId,
            });
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
    async handleAnswer(sdp, offerId = null) {
        try {
            if (!this._pc || this._closed) return;
            if (this._answerApplying) return;
            if (offerId !== null && offerId !== this._pendingOfferId) return;
            if (this._pc.signalingState !== 'have-local-offer') return;
            this._answerApplying = true;
            try {
                await this._pc.setRemoteDescription({ type: 'answer', sdp });
            } finally {
                this._answerApplying = false;
            }
            this._pendingOfferId = null;
            for (const c of this._iceQueue.splice(0)) {
                try { await this._pc.addIceCandidate(c); } catch {}
            }
        } catch {}
    }
    async handleRemoteIce(candidate) {
        if (!this._pc || !candidate) return;
        if (this._pc.remoteDescription === null) {
            this._iceQueue.push(candidate);
            if (this._iceQueue.length > 100) this._iceQueue.shift();
            return;
        }
        try {
            await this._pc.addIceCandidate(candidate);
        } catch {}
    }
    _onControlMessage(ev) {
        const data = ev?.data;
        if (!(data instanceof ArrayBuffer)) {
            this.oncontrol?.(data);
            return;
        }
        if (data.byteLength === 12) {
            const v = new DataView(data);
            if (v.getUint8(0) === 0x52 && v.getUint8(1) === 0x50
                && v.getUint8(2) === 0x4E && v.getUint8(3) === 0x47) {
                if (this._kpWait !== null) {
                    const rtt = performance.now() - this._kpWait.t0;
                    this._kpWait.resolve({ rttMs: Math.round(rtt) });
                    this._kpWait = null;
                }
                return;
            }
        }
        this.oncontrol?.(data);
    }
    pingKeepalive(timeoutMs = 3000) {
        if (!this.isControlOpen() || this._kpWait !== null) return Promise.resolve(null);
        return new Promise((resolve) => {
            const buf = new ArrayBuffer(12);
            const v = new DataView(buf);
            v.setUint8(0, 0x52); v.setUint8(1, 0x50); v.setUint8(2, 0x4E); v.setUint8(3, 0x47);
            v.setUint32(4, Math.floor(performance.now()) >>> 0);
            v.setUint32(8, (Math.random() * 0xFFFFFFFF) >>> 0);
            const timer = setTimeout(() => {
                if (this._kpWait) {
                    this._kpWait = null;
                    resolve(null);
                }
            }, timeoutMs);
            this._kpWait = { t0: performance.now(), resolve: (r) => { clearTimeout(timer); resolve(r); } };
            try {
                this._controlDc.send(buf);
            } catch {
                this._kpWait = null;
                clearTimeout(timer);
                resolve(null);
            }
        });
    }
    startKeepalive(intervalMs = 20000) {
        this.stopKeepalive();
        this._kpTimer = setInterval(() => { this.pingKeepalive(); }, intervalMs);
    }
    stopKeepalive() {
        if (this._kpTimer) {
            clearInterval(this._kpTimer);
            this._kpTimer = null;
        }
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
            const locals = new Map();
            stats.forEach((r) => {
                if (r.type === 'remote-candidate') remotes.set(r.id, r);
                else if (r.type === 'local-candidate') locals.set(r.id, r);
                else if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
            });
            if (!pair) stats.forEach((r) => {
                if (!pair && r.type === 'candidate-pair' && (r.nominated || (r.selected && r.state === 'succeeded'))) pair = r;
            });
            if (!pair) stats.forEach((r) => {
                if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r;
            });
            if (!pair) return null;
            const remote = remotes.get(pair.remoteCandidateId);
            const local = locals.get(pair.localCandidateId);
            const type = remote?.candidateType || local?.candidateType || null;
            const sent = typeof pair.packetsSent === 'number' ? pair.packetsSent : null;
            const lost = typeof pair.packetsLost === 'number' ? pair.packetsLost : null;
            let lossPct = null;
            if (sent !== null && lost !== null && (sent + lost) > 0) {
                lossPct = (lost / (sent + lost)) * 100;
            }
            return {
                candidateType: type,
                localType: local?.candidateType || null,
                remoteType: remote?.candidateType || null,
                rttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
                jitterMs: typeof pair.jitter === 'number' ? Math.round(pair.jitter * 1000) : null,
                packetsSent: sent,
                packetsLost: lost,
                lossPct,
            };
        } catch {
            return null;
        }
    }
    close() {
        this._closed = true;
        this.stopKeepalive?.();
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
