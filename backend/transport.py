"""
Transport abstraction for RDP sessions.

WS and WebRTC DataChannel are interchangeable senders.
RDPBridge must only depend on SessionSender, never on websocket directly.
"""

import logging
from typing import Protocol, Union

logger = logging.getLogger('rdp-transport')


class SessionSender(Protocol):
    name: str

    async def send_text(self, text: str) -> None: ...
    async def send_bytes(self, data: Union[bytes, bytearray, memoryview]) -> None: ...
    async def close(self, code: int = 1000, reason: str = '') -> None: ...
    def is_open(self) -> bool: ...


class WebSocketSender:
    """SessionSender backed by a websockets ServerConnection."""

    name = 'ws'

    def __init__(self, websocket):
        self._ws = websocket

    async def send_text(self, text: str) -> None:
        await self._ws.send(text)

    async def send_bytes(self, data: Union[bytes, bytearray, memoryview]) -> None:
        await self._ws.send(bytes(data) if not isinstance(data, bytes) else data)

    async def close(self, code: int = 1000, reason: str = '') -> None:
        try:
            await self._ws.close(code, reason[:120] if reason else '')
        except Exception as e:
            logger.debug(f"WS close error: {e}")

    def is_open(self) -> bool:
        try:
            from websockets.protocol import State
            return self._ws.state == State.OPEN
        except Exception:
            return True
