"""
WebRTC DataChannel transport for RDP sessions.

Signaling runs over the existing WebSocket connection:
  client -> server: {type:'rtc-offer', sdp}
  server -> client: {type:'rtc-answer', sdp}
  both ways:       {type:'rtc-ice', candidate | null}

After the peer connection is established, the server opens two
DataChannels multiplexed over the same PeerConnection:
  - 'media'   : server -> client binary wire-format frames (SURF/H264/OPUS/...)
  - 'control' : client -> server binary backchannel (FACK)

JSON control (connect/mouse/key/...) stays on WebSocket. Only the
binary media path migrates to DataChannel, so the frontend keeps
using wire-format.js / gfx-worker.js unchanged.
"""

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Union

logger = logging.getLogger('rdp-webrtc')

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
    from aiortc import RTCDataChannel, RTCConfiguration, RTCIceServer
    try:
        from aiortc.sdp import candidate_from_sdp  # type: ignore
    except Exception:
        candidate_from_sdp = None  # type: ignore
    AIORTC_AVAILABLE = True
except Exception as e:  # pragma: no cover - import guard
    RTCPeerConnection = None  # type: ignore
    RTCSessionDescription = None  # type: ignore
    RTCIceCandidate = None  # type: ignore
    RTCDataChannel = None  # type: ignore
    RTCConfiguration = None  # type: ignore
    RTCIceServer = None  # type: ignore
    candidate_from_sdp = None  # type: ignore
    AIORTC_AVAILABLE = False
    _AIORTC_IMPORT_ERROR = str(e)


def is_available() -> bool:
    return AIORTC_AVAILABLE


def get_stun_servers() -> list:
    raw = os.getenv('RTC_STUN_URLS', 'stun:stun.miwifi.com:3478,stun:stun.l.google.com:19302')
    urls = [u.strip() for u in raw.split(',') if u.strip()]
    return urls


@dataclass
class RtcPendingSession:
    pc: Any
    media_channel: Optional[Any] = None
    ready: asyncio.Event = None  # type: ignore
    created_at: float = 0.0

    def __post_init__(self):
        if self.ready is None:
            self.ready = asyncio.Event()
        if not self.created_at:
            import time
            self.created_at = time.monotonic()


class DataChannelSender:
    """SessionSender backed by an aiortc DataChannel ('media')."""

    name = 'rtc'

    def __init__(self, get_channel):
        self._get_channel = get_channel

    def _ch(self):
        try:
            return self._get_channel()
        except Exception:
            return None

    async def send_text(self, text: str) -> None:
        ch = self._ch()
        if ch is not None and getattr(ch, 'readyState', '') == 'open':
            ch.send(text)

    async def send_bytes(self, data: Union[bytes, bytearray, memoryview]) -> None:
        ch = self._ch()
        if ch is not None and getattr(ch, 'readyState', '') == 'open':
            ch.send(bytes(data) if not isinstance(data, bytes) else data)

    async def close(self, code: int = 1000, reason: str = '') -> None:
        ch = self._ch()
        try:
            if ch is not None:
                ch.close()
        except Exception as e:
            logger.debug(f"DC close error: {e}")

    def is_open(self) -> bool:
        ch = self._ch()
        return ch is not None and getattr(ch, 'readyState', '') == 'open'


class WebRTCManager:
    """Owns one RTCPeerConnection per signaling WebSocket."""

    def __init__(self):
        self._sessions: Dict[int, RtcPendingSession] = {}

    def has_session(self, client_id: int) -> bool:
        sess = self._sessions.get(client_id)
        return sess is not None and sess.media_channel is not None and sess.ready.is_set()

    def get_media_sender(self, client_id: int):
        sess = self._sessions.get(client_id)
        if sess is None:
            return None
        return DataChannelSender(lambda: sess.media_channel)

    def get_session(self, client_id: int) -> Optional[RtcPendingSession]:
        return self._sessions.get(client_id)

    async def handle_offer(self, client_id: int, sdp: str, websocket) -> Optional[str]:
        if not AIORTC_AVAILABLE:
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'WebRTC unavailable: {_AIORTC_IMPORT_ERROR}',
            }))
            return None
        import time
        now = time.monotonic()
        debounce_s = float(os.getenv('RTC_OFFER_DEBOUNCE_S', '10'))
        existing = self._sessions.get(client_id)
        if existing is not None and (now - (existing.created_at or 0)) < debounce_s:
            logger.info(f"Client {client_id}: duplicate offer ignored (debounce {debounce_s}s)")
            try:
                local = existing.pc.localDescription
                if local is not None:
                    return local.sdp
            except Exception:
                pass
            return None
        await self._close_session(client_id)
        stun_urls = get_stun_servers()
        logger.info(f"Client {client_id}: RTC offer, STUN={stun_urls}")
        if RTCConfiguration is not None:
            config = RTCConfiguration([RTCIceServer(urls=u) for u in stun_urls])
            pc = RTCPeerConnection(config)
        else:
            pc = RTCPeerConnection()
        sess = RtcPendingSession(pc=pc)
        self._sessions[client_id] = sess

        @pc.on('datachannel')
        def on_datachannel(channel):
            logger.info(f"Client {client_id}: remote datachannel '{channel.label}'")
            if channel.label == 'control':
                channel.on('message', lambda msg: asyncio.ensure_future(
                    self._on_control_message(client_id, msg)))
            elif channel.label == 'media':
                sess.media_channel = channel
                sess.ready.set()

        @pc.on('connectionstatechange')
        async def on_state():
            logger.info(f"Client {client_id}: RTC state={pc.connectionState}")
            if pc.connectionState in ('failed', 'closed', 'disconnected'):
                sess.ready.clear()

        # Server creates the 'media' channel proactively so the client
        # gets ondatachannel even before it creates 'control'.
        media = pc.createDataChannel('media', ordered=True)
        sess.media_channel = media

        @media.on('open')
        def on_open():
            logger.info(f"Client {client_id}: RTC media channel open")
            sess.ready.set()

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type='offer'))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        # Non-trickle answer: aiortc has no per-candidate 'icecandidate'
        # event, so wait for gathering and embed candidates in the SDP.
        # (The browser side still trickles its candidates to us.)
        gather_timeout = float(os.getenv('RTC_GATHER_TIMEOUT', '5'))
        try:
            waited = 0.0
            while getattr(pc, 'iceGatheringState', 'complete') != 'complete' and waited < gather_timeout:
                await asyncio.sleep(0.1)
                waited += 0.1
        except Exception:
            pass
        return pc.localDescription.sdp

    async def handle_remote_ice(self, client_id: int, candidate) -> None:
        sess = self._sessions.get(client_id)
        if sess is None or not AIORTC_AVAILABLE:
            return
        if candidate is None:
            try:
                await sess.pc.addIceCandidate(None)
            except Exception:
                pass
            return
        try:
            if isinstance(candidate, dict):
                cand_str = candidate.get('candidate', '')
                if not cand_str:
                    return
                if candidate_from_sdp is not None:
                    try:
                        ice = candidate_from_sdp(cand_str)
                        ice.sdpMid = candidate.get('sdpMid')
                        ice.sdpMLineIndex = candidate.get('sdpMLineIndex')
                        await sess.pc.addIceCandidate(ice)
                        return
                    except Exception:
                        pass
                await sess.pc.addIceCandidate(candidate)
            else:
                await sess.pc.addIceCandidate(candidate)
        except Exception as e:
            logger.debug(f"Client {client_id}: addIceCandidate error: {e}")

    async def _on_control_message(self, client_id: int, msg) -> None:
        # Filled in by server.py: routes FACK bytes to RDPBridge.
        handler = getattr(self, 'on_control_bytes', None)
        if handler is None:
            return
        try:
            if isinstance(msg, str):
                data = msg.encode()
            else:
                data = bytes(msg)
            await handler(client_id, data)
        except Exception as e:
            logger.debug(f"Client {client_id}: control msg error: {e}")

    async def wait_ready(self, client_id: int, timeout: float = 10.0) -> bool:
        sess = self._sessions.get(client_id)
        if sess is None:
            return False
        try:
            await asyncio.wait_for(sess.ready.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _close_session(self, client_id: int) -> None:
        sess = self._sessions.pop(client_id, None)
        if sess is None:
            return
        try:
            await sess.pc.close()
        except Exception:
            pass

    async def close(self, client_id: int) -> None:
        await self._close_session(client_id)
