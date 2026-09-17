"""
RDP WebSocket Proxy Server
Bridges browser clients to remote Windows VMs via FreeRDP
"""

import asyncio
import json
import logging
import os
from http import HTTPStatus
from typing import Dict, Optional

from dotenv import load_dotenv
from websockets.asyncio.server import serve, ServerConnection
from websockets.http11 import Response
from websockets.datastructures import Headers

from rdp_bridge import RDPBridge, RDPConfig, NativeLibrary
from wire_format import parse_frame_ack, get_message_type, Magic
from transport import WebSocketSender
from webrtc_transport import (
    WebRTCManager, is_available as webrtc_available, get_ice_servers,
)

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('rdp-server')

# Filter out noisy websocket errors from empty connections (TCP probes, health checks)
class WebSocketErrorFilter(logging.Filter):
    """Filter out benign WebSocket handshake errors from empty connections."""
    
    FILTERED_MESSAGES = (
        'stream ends after 0 bytes',
        'connection closed while reading HTTP request',
        'did not receive a valid HTTP request',
        'opening handshake failed',
    )
    
    def filter(self, record: logging.LogRecord) -> bool:
        # Only filter ERROR level from websockets.server
        if record.levelno < logging.ERROR:
            return True
        
        # Check main message
        message = record.getMessage()
        for filtered in self.FILTERED_MESSAGES:
            if filtered in message:
                return False
        
        # Check exception info if present
        if record.exc_info and record.exc_info[1]:
            exc_str = str(record.exc_info[1])
            for filtered in self.FILTERED_MESSAGES:
                if filtered in exc_str:
                    return False
        
        return True

# Apply filter to websockets logger (keeps other errors visible)
websockets_logger = logging.getLogger('websockets.server')
websockets_logger.addFilter(WebSocketErrorFilter())

# Active sessions: websocket -> RDPBridge
sessions: Dict[ServerConnection, RDPBridge] = {}

# One WebRTC manager for all signaling sockets (STUN only, WS fallback)
rtc_manager = WebRTCManager()

# client_id -> in-flight offer task (gathering must not block WS loop)
_rtc_offer_tasks: Dict[int, asyncio.Task] = {}

# aioice logs 'sendto on NoneType' tracebacks when a PC is closed mid-retry.
# Harmless noise: demote asyncio ERROR logs from that path.
_aioice_noise_logger = logging.getLogger('asyncio')


class _AioiceNoiseFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if 'send_stun' in msg or 'sendto' in msg or '__retry' in msg:
            return False
        if record.exc_info and record.exc_info[0] is not None:
            try:
                import traceback
                tb = ''.join(traceback.format_exception(*record.exc_info))
                if 'aioice' in tb and ('sendto' in tb or 'send_stun' in tb):
                    return False
            except Exception:
                pass
        return True


_aioice_noise_logger.addFilter(_AioiceNoiseFilter())

# client_id -> RDPBridge for DataChannel control routing
_rtc_bridges: Dict[int, RDPBridge] = {}


async def handle_control_bytes(client_id: int, route: str, data: bytes):
    """Route DataChannel 'control' binary (FACK) to the RDP bridge."""
    bridge = _rtc_bridges.get(client_id)
    if bridge is None:
        # Fall back to WS sessions lookup
        for ws, b in list(sessions.items()):
            if id(ws) == client_id:
                bridge = b
                break
    if bridge is None:
        return
    await handle_binary_message(data, bridge, client_id)


rtc_manager.on_control_bytes = handle_control_bytes

# HTML response for non-WebSocket requests
INFO_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RDP WebSocket Server</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
               max-width: 600px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d9ff; }
        code { background: #16213e; padding: 2px 8px; border-radius: 4px; }
        .info { background: #16213e; padding: 15px; border-radius: 8px; border-left: 4px solid #00d9ff; }
    </style>
</head>
<body>
    <h1>🖥️ RDP WebSocket Server</h1>
    <div class="info">
        <p>This is a <strong>WebSocket endpoint</strong> for RDP streaming.</p>
        <p>To connect, use a WebSocket client with:</p>
        <p><code>ws://hostname:8765</code></p>
    </div>
    <h2>Endpoints</h2>
    <ul>
        <li><code>GET /health</code> - Health check (returns 200 OK)</li>
        <li><code>WebSocket /</code> - RDP streaming connection</li>
    </ul>
</body>
</html>
"""


def check_native_library() -> tuple[bool, str]:
    """Check if the native RDP library can be loaded."""
    try:
        lib = NativeLibrary()
        if lib._lib is not None:
            return True, "Native library loaded"
        return False, "Native library is None"
    except Exception as e:
        return False, str(e)


def process_request(connection, request):
    """
    Handle non-WebSocket HTTP requests.
    
    Returns:
        - Response for health checks and regular HTTP requests
        - None to proceed with WebSocket handshake
    """
    # ICE servers for WebRTC (STUN + TURN credential from server env,
    # never hardcode TURN secrets in frontend). Same-origin, no auth.
    if request.path == '/ice-servers' or request.path == '/ice-servers/':
        headers = Headers([("Content-Type", "application/json")])
        body = json.dumps({"iceServers": get_ice_servers()}).encode('utf-8')
        return Response(HTTPStatus.OK.value, "OK", headers, body)

    # Health check endpoint
    if request.path == '/health' or request.path == '/healthz':
        lib_ok, lib_msg = check_native_library()
        
        if lib_ok:
            headers = Headers([("Content-Type", "application/json")])
            body = json.dumps({
                "status": "healthy",
                "native_library": lib_msg
            }).encode('utf-8')
            return Response(
                HTTPStatus.OK.value,
                "OK",
                headers,
                body
            )
        else:
            headers = Headers([("Content-Type", "application/json")])
            body = json.dumps({
                "status": "unhealthy",
                "native_library": lib_msg
            }).encode('utf-8')
            return Response(
                HTTPStatus.SERVICE_UNAVAILABLE.value,
                "Service Unavailable",
                headers,
                body
            )
    
    # Check if this is a WebSocket upgrade request
    upgrade_header = None
    for name, value in request.headers.raw_items():
        if name.lower() == 'upgrade':
            upgrade_header = value.lower()
            break
    
    # If not a WebSocket upgrade, return informational page with 426 status
    if upgrade_header != 'websocket':
        headers = Headers([
            ("Content-Type", "text/html; charset=utf-8"),
            ("Upgrade", "websocket")
        ])
        return Response(
            HTTPStatus.UPGRADE_REQUIRED.value,
            "Upgrade Required",
            headers,
            INFO_PAGE_HTML.encode('utf-8')
        )
    
    # Proceed with WebSocket handshake
    return None


async def handle_binary_message(data: bytes, rdp_bridge: Optional[RDPBridge], client_id: int):
    """Handle binary backchannel messages from browser (FACK)
    
    Args:
        data: Binary message data
        rdp_bridge: RDP bridge instance (may be None if not connected)
        client_id: Client ID for logging
    """
    if len(data) < 4:
        logger.warning(f"Client {client_id}: Binary message too short ({len(data)} bytes)")
        return
    
    msg_type = get_message_type(data)
    
    if msg_type == 'frameAck':
        # Frame acknowledgment from browser - forward to FreeRDP!
        # This is critical for proper backpressure. The browser sends FACK after
        # it has decoded and presented the frame. We forward this to FreeRDP which
        # sends FrameAcknowledge to the RDP server. This tells the server we're
        # ready for more frames - if the browser is slow, ACKs are delayed and
        # the server throttles its frame rate.
        #
        # Per MS-RDPEGFX 2.2.3.3, queueDepth enables adaptive server-side rate control:
        #   0x00000000: QUEUE_DEPTH_UNAVAILABLE
        #   0xFFFFFFFF: SUSPEND_FRAME_ACKNOWLEDGEMENT
        #   Other: Actual unprocessed frames in browser decode queue
        parsed = parse_frame_ack(data)
        if parsed and rdp_bridge:
            frame_id = parsed['frame_id']
            total_decoded = parsed['total_frames_decoded']
            queue_depth = parsed['queue_depth']
            if rdp_bridge.send_frame_ack(frame_id, total_decoded, queue_depth):
                logger.debug(f"Client {client_id}: Forwarded frame ACK for frame {frame_id} (total decoded: {total_decoded}, queue depth: {queue_depth})")
            else:
                logger.warning(f"Client {client_id}: Failed to forward frame ACK for frame {frame_id}")
        elif not rdp_bridge:
            logger.warning(f"Client {client_id}: Frame ACK received but no RDP bridge active")
            
    else:
        # Unknown binary message
        magic = data[:4].decode('latin-1', errors='replace')
        logger.warning(f"Client {client_id}: Unknown binary message type '{magic}'")


async def handle_client(websocket: ServerConnection):
    """Handle a WebSocket client connection (signaling + WS fallback transport)"""
    client_id = id(websocket)
    logger.info(f"Client {client_id} connected from {websocket.remote_address}")

    rdp_bridge: Optional[RDPBridge] = None
    
    try:
        async for message in websocket:
            try:
                # Handle binary messages (backchannel: FACK)
                if isinstance(message, bytes):
                    await handle_binary_message(message, rdp_bridge, client_id)
                    continue
                
                data = json.loads(message)
                msg_type = data.get('type')
                
                if msg_type == 'connect':
                    if not all(k in data for k in ('host', 'username', 'password')):
                        logger.info(f"Client {client_id} missing required fields for connect")
                        await websocket.send(json.dumps({
                            'type': 'error',
                            'message': 'Failed to connect to RDP host - missing required fields'
                        }))


                    # Start RDP session
                    config = RDPConfig(
                        host=data['host'],
                        port=data.get('port', 3389),
                        username=data['username'],
                        password=data['password'],
                        width=data.get('width', 1280),
                        height=data.get('height', 720)
                    )
                    
                    rdp_bridge = RDPBridge(config, websocket, sender=WebSocketSender(websocket))
                    sessions[websocket] = rdp_bridge
                    
                    # Start the RDP session (this will begin streaming frames)
                    success = await rdp_bridge.connect()
                    
                    if success:
                        await websocket.send(json.dumps({
                            'type': 'connected',
                            'width': config.width,
                            'height': config.height
                        }))
                        logger.info(f"Client {client_id} RDP session started to {config.host}")
                    else:
                        await websocket.send(json.dumps({
                            'type': 'error',
                            'message': 'Failed to connect to RDP host'
                        }))
                
                elif msg_type == 'disconnect':
                    if rdp_bridge:
                        await rdp_bridge.disconnect()
                    await websocket.send(json.dumps({'type': 'disconnected'}))
                    break
                
                elif msg_type == 'mouse':
                    if rdp_bridge:
                        await rdp_bridge.send_mouse_event(
                            action=data['action'],
                            x=data['x'],
                            y=data['y'],
                            button=data.get('button', 0),
                            delta_x=data.get('deltaX', 0),
                            delta_y=data.get('deltaY', 0)
                        )
                
                elif msg_type == 'key':
                    if rdp_bridge:
                        await rdp_bridge.send_key_event(
                            action=data['action'],
                            key=data.get('key', ''),
                            code=data.get('code', ''),
                            key_code=data.get('keyCode', 0),
                            ctrl=data.get('ctrlKey', False),
                            shift=data.get('shiftKey', False),
                            alt=data.get('altKey', False),
                            meta=data.get('metaKey', False)
                        )
                
                elif msg_type == 'keycombo':
                    if rdp_bridge:
                        await rdp_bridge.send_key_combo(data['combo'])
                
                elif msg_type == 'resize':
                    if rdp_bridge:
                        new_width = data.get('width', 1280)
                        new_height = data.get('height', 720)
                        logger.info(f"Client {client_id} requested resize to {new_width}x{new_height}")
                        success = await rdp_bridge.resize(new_width, new_height)
                        if success:
                            await websocket.send(json.dumps({
                                'type': 'resize',
                                'width': new_width,
                                'height': new_height
                            }))
                        else:
                            await websocket.send(json.dumps({
                                'type': 'error',
                                'message': 'Failed to resize session'
                            }))
                
                elif msg_type == 'ping':
                    pong = {'type': 'pong'}
                    if isinstance(data.get('seq'), int):
                        pong['seq'] = data['seq']
                    await websocket.send(json.dumps(pong))

                elif msg_type == 'clipboard':
                    if rdp_bridge:
                        text = data.get('text', '')
                        if not isinstance(text, str) or not text or len(text) > 1024 * 1024:
                            continue
                        ok = rdp_bridge.send_clipboard_text(text)
                        if not ok:
                            await websocket.send(json.dumps({
                                'type': 'error',
                                'message': 'Failed to send clipboard text'
                            }))
                
                elif msg_type == 'ack_frame':
                    # Acknowledge H.264 frame - FreeRDP handles this automatically
                    # Just log for debugging
                    frame_id = data.get('frame_id', 0)
                    logger.debug(f"Frame ack received: {frame_id}")

                elif msg_type == 'rtc-offer':
                    sdp = data.get('sdp', '')
                    offer_id = data.get('offerId')
                    if not sdp:
                        await websocket.send(json.dumps({'type': 'error', 'message': 'Missing SDP offer'}))
                    elif not webrtc_available():
                        await websocket.send(json.dumps({'type': 'rtc-unavailable', 'reason': 'aiortc not installed'}))
                    else:
                        # Run in background: gathering blocks up to 5s and must
                        # not stall mouse/keyboard/resize on the WS loop.
                        # Single PC per client: a retry replaces the old offer.
                        key = client_id
                        old = _rtc_offer_tasks.pop(key, None)
                        if old is not None and not old.done():
                            old.cancel()
                        async def _do_offer(sdp_text=sdp, cid=client_id, ws=websocket, oid=offer_id, k=key):
                            try:
                                answer = await rtc_manager.handle_offer(cid, sdp_text, ws)
                                if answer:
                                    try:
                                        await ws.send(json.dumps({
                                            'type': 'rtc-answer', 'sdp': answer,
                                            'route': 'rtc', 'offerId': oid,
                                        }))
                                    except Exception:
                                        pass
                            except asyncio.CancelledError:
                                pass
                            except Exception as e:
                                logger.debug(f"Client {cid}: offer task error: {e}")
                            finally:
                                _rtc_offer_tasks.pop(k, None)
                        _rtc_offer_tasks[key] = asyncio.create_task(_do_offer())

                elif msg_type == 'rtc-ice':
                    await rtc_manager.handle_remote_ice(client_id, data.get('candidate'))

                elif msg_type == 'rtc-upgrade':
                    # Client says DC is open: queue sender switch at next frame
                    # boundary. Session stays alive for instant re-switch.
                    if rdp_bridge and rtc_manager.has_session(client_id):
                        sender = rtc_manager.get_media_sender(client_id)
                        if sender is not None:
                            rdp_bridge.request_sender_switch(sender)
                            _rtc_bridges[client_id] = rdp_bridge
                            logger.info(f"Client {client_id}: media upgrading to rtc (frame boundary)")
                            await websocket.send(json.dumps({'type': 'rtc-active', 'transport': 'rtc', 'route': 'rtc'}))
                        else:
                            await websocket.send(json.dumps({'type': 'rtc-active', 'transport': 'ws'}))
                    else:
                        await websocket.send(json.dumps({'type': 'rtc-active', 'transport': 'ws'}))

                elif msg_type == 'rtc-downgrade':
                    # Client asks to fall back: switch back to WS but KEEP RTC
                    # session alive so re-switch is instant (no re-handshake).
                    if rdp_bridge:
                        rdp_bridge.request_sender_switch(WebSocketSender(websocket))
                        _rtc_bridges.pop(client_id, None)
                        logger.info(f"Client {client_id}: media downgrading to WS (frame boundary)")
                    await websocket.send(json.dumps({'type': 'rtc-active', 'transport': 'ws'}))

                elif msg_type == 'rtc-keepalive':
                    rtc_manager.touch(client_id)

                else:
                    logger.warning(f"Unknown message type: {msg_type}")
                    
            except json.JSONDecodeError:
                logger.error("Invalid JSON received")
            except KeyError as e:
                logger.error(f"Missing required field: {e}")
            except Exception as e:
                logger.error(f"Error handling message: {e}")
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': str(e)
                }))
    
    except Exception as e:
        logger.error(f"Client {client_id} error: {e}")
    
    finally:
        # Cleanup
        task = _rtc_offer_tasks.pop(client_id, None)
        if task is not None and not task.done():
            task.cancel()
        if rdp_bridge:
            await rdp_bridge.disconnect()
        if websocket in sessions:
            del sessions[websocket]
        _rtc_bridges.pop(client_id, None)
        try:
            await rtc_manager.close(client_id)
        except Exception:
            pass
        logger.info(f"Client {client_id} disconnected")


async def main():
    """Main server entry point"""
    host = os.getenv('WS_HOST', '0.0.0.0')
    port = int(os.getenv('WS_PORT', '8765'))
    
    logger.info(f"Starting RDP WebSocket server on ws://{host}:{port}")
    logger.info("Health check available at: http://{}:{}/health".format(host, port))
    
    async with serve(handle_client, host, port, process_request=process_request):
        logger.info("Server is running. Press Ctrl+C to stop.")
        await asyncio.Future()  # Run forever


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
