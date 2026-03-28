"""Zigbee2HASS — WebSocket client for the Zigbee2HASS add-on.

Handles:
- Connection and automatic reconnection
- Message dispatching to registered callbacks
- Request/response correlation (id-based)
- State snapshot on (re)connect
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

_LOGGER = logging.getLogger(__name__)

RECONNECT_DELAY_MIN = 2    # seconds
RECONNECT_DELAY_MAX = 60   # seconds


class Zigbee2HASSClient:
    """Async WebSocket client for the Zigbee2HASS add-on."""

    def __init__(
        self,
        host: str,
        port: int,
        on_message: Callable[[str, dict], None],
        on_connected: Callable[[], None] | None = None,
        on_disconnected: Callable[[], None] | None = None,
    ) -> None:
        self._host           = host
        self._port           = port
        self._on_message     = on_message
        self._on_connected   = on_connected
        self._on_disconnected = on_disconnected

        self._ws: Any        = None
        self._task: asyncio.Task | None = None
        self._running        = False
        self._connected      = False

        # Pending requests waiting for response: id → asyncio.Future
        self._pending: dict[str, asyncio.Future] = {}

    # ── Public API ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the connection loop in the background."""
        self._running = True
        self._task = asyncio.create_task(self._connection_loop())

    async def stop(self) -> None:
        """Disconnect and stop the client."""
        self._running = False
        if self._ws:
            await self._ws.close()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @property
    def connected(self) -> bool:
        return self._connected

    async def request(self, msg_type: str, payload: dict | None = None, timeout: float = 10.0) -> dict:
        """Send a request and await its response by correlation id."""
        if not self._connected or not self._ws:
            raise ConnectionError("Not connected to Zigbee2HASS add-on")

        req_id  = str(uuid.uuid4())
        future  = asyncio.get_event_loop().create_future()
        self._pending[req_id] = future

        try:
            await self._ws.send(json.dumps({
                "id":      req_id,
                "type":    msg_type,
                "payload": payload or {},
            }))
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise TimeoutError(f"Request '{msg_type}' timed out after {timeout}s")
        except Exception:
            self._pending.pop(req_id, None)
            raise

    async def send(self, msg_type: str, payload: dict | None = None) -> None:
        """Fire-and-forget send (no response expected)."""
        if not self._connected or not self._ws:
            raise ConnectionError("Not connected to Zigbee2HASS add-on")
        await self._ws.send(json.dumps({
            "id":      str(uuid.uuid4()),
            "type":    msg_type,
            "payload": payload or {},
        }))

    # ── Connection loop ────────────────────────────────────────────────────

    async def _connection_loop(self) -> None:
        delay = RECONNECT_DELAY_MIN

        while self._running:
            uri = f"ws://{self._host}:{self._port}"
            try:
                _LOGGER.debug("Connecting to %s", uri)
                async with websockets.connect(uri, ping_interval=20, ping_timeout=10) as ws:
                    self._ws        = ws
                    self._connected = True
                    delay           = RECONNECT_DELAY_MIN
                    _LOGGER.info("Connected to Zigbee2HASS add-on at %s", uri)

                    if self._on_connected:
                        self._on_connected()

                    await self._receive_loop(ws)

            except (ConnectionClosed, WebSocketException, OSError) as exc:
                _LOGGER.warning("Zigbee2HASS connection lost: %s", exc)
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("Unexpected error in connection loop: %s", exc)
            finally:
                self._connected = False
                self._ws        = None
                # Reject all pending requests
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError("Disconnected"))
                self._pending.clear()

                if self._on_disconnected:
                    self._on_disconnected()

            if self._running:
                _LOGGER.info("Reconnecting in %ds...", delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_DELAY_MAX)

    async def _receive_loop(self, ws) -> None:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                _LOGGER.warning("Received invalid JSON from add-on")
                continue

            topic   = data.get("topic", "")
            payload = data.get("payload", {})

            # Response to a pending request
            if topic == "zigbee2hass/response":
                req_id = payload.get("id")
                future = self._pending.pop(req_id, None)
                if future and not future.done():
                    if "error" in payload:
                        future.set_exception(RuntimeError(payload["error"]))
                    else:
                        future.set_result(payload.get("result", {}))
                continue

            # Regular event — dispatch to integration
            try:
                self._on_message(topic, payload)
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("Message handler error for topic '%s': %s", topic, exc)
