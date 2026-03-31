"""Zigbee2HASS Coordinator — central hub for the integration.

Manages:
- WebSocket client lifecycle
- Device registry
- Per-device state and availability
- Listener/subscriber dispatch to platform entities
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr

from .const import (
    DOMAIN,
    TOPIC_BRIDGE_DEVICES,
    TOPIC_BRIDGE_STATE,
    TOPIC_DEVICE_AVAIL,
    TOPIC_DEVICE_INTERVIEW,
    TOPIC_DEVICE_JOINED,
    TOPIC_DEVICE_LEFT,
    TOPIC_DEVICE_READY,
    TOPIC_DEVICE_RENAMED,
    TOPIC_DEVICE_STATE,
    TOPIC_PERMIT_JOIN,
)
from .websocket_client import Zigbee2HASSClient

_LOGGER = logging.getLogger(__name__)


class Zigbee2HASSCoordinator:
    """Central coordinator for Zigbee2HASS."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        host: str,
        port: int,
    ) -> None:
        self.hass    = hass
        self.entry   = entry
        self.host    = host
        self.port    = port

        # Device data: ieee_address → dict with keys: device, definition, state, available
        self.devices: dict[str, dict[str, Any]] = {}
        self.bridge_available = False
        self.permit_join      = False

        # Subscribers: topic → list of callbacks
        self._subscribers: dict[str, list[Callable]] = defaultdict(list)
        # Device-specific state subscribers: ieee_address → list of callbacks
        self._device_subscribers: dict[str, list[Callable]] = defaultdict(list)

        # Set when the first bridge/devices snapshot arrives
        self._snapshot_event: asyncio.Event | None = None

        self._client = Zigbee2HASSClient(
            host=host,
            port=port,
            on_message=self._on_message,
            on_connected=self._on_connected,
            on_disconnected=self._on_disconnected,
        )

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def async_start(self) -> None:
        self._snapshot_event = asyncio.Event()
        await self._client.start()
        # Wait up to 30s for TCP connect
        for _ in range(120):
            if self._client.connected:
                _LOGGER.debug("Connected to Zigbee2HASS add-on at %s:%s", self.host, self.port)
                break
            await asyncio.sleep(0.25)
        else:
            raise ConnectionError(f"Timed out waiting for connection to Zigbee2HASS add-on at {self.host}:{self.port}")

        # Wait up to 30s for the device snapshot to arrive so coordinator.devices
        # is populated before platform async_setup_entry iterates it.
        try:
            await asyncio.wait_for(self._snapshot_event.wait(), timeout=30.0)
            _LOGGER.debug("Device snapshot received — %d devices", len(self.devices))
        except asyncio.TimeoutError:
            _LOGGER.warning("Device snapshot not received within 30s; continuing with empty device list")

    async def async_stop(self) -> None:
        await self._client.stop()

    # ── Subscriptions ─────────────────────────────────────────────────────

    def subscribe(self, topic: str, callback_fn: Callable) -> Callable:
        """Subscribe to a topic. Returns an unsubscribe function."""
        self._subscribers[topic].append(callback_fn)
        def unsub():
            self._subscribers[topic].remove(callback_fn)
        return unsub

    def subscribe_device(self, ieee_address: str, callback_fn: Callable) -> Callable:
        """Subscribe to state/availability changes for a specific device."""
        self._device_subscribers[ieee_address].append(callback_fn)
        def unsub():
            self._device_subscribers[ieee_address].remove(callback_fn)
        return unsub

    # ── Commands ──────────────────────────────────────────────────────────

    async def async_set_state(self, ieee_address: str, state: dict) -> dict:
        """Send a command to a device with confirmation."""
        return await self._client.request("set_state", {
            "ieee_address": ieee_address,
            "state": state,
        })

    async def async_permit_join(self, permit: bool, timeout: int = 254) -> None:
        await self._client.request("permit_join", {"permit": permit, "timeout": timeout})

    async def async_ping_device(self, ieee_address: str) -> int:
        result = await self._client.request("ping_device", {"ieee_address": ieee_address})
        return result.get("latency_ms", -1)

    async def async_backup(self) -> str:
        result = await self._client.request("backup")
        return result.get("path", "")

    async def async_get_health(self) -> dict:
        return await self._client.request("health")

    async def async_remove_device(self, ieee_address: str, force: bool = False) -> None:
        await self._client.request("remove_device", {"ieee_address": ieee_address, "force": force})

    async def async_rename_device(self, ieee_address: str, name: str) -> None:
        result = await self._client.request("rename_device", {"ieee_address": ieee_address, "name": name})
        # Update local cache so panel sees the new name immediately
        if ieee_address in self.devices:
            self.devices[ieee_address]["device"]["friendly_name"] = result.get("friendly_name", name)

    async def async_configure_device(self, ieee_address: str) -> dict:
        return await self._client.request("configure_device", {"ieee_address": ieee_address})

    async def async_get_network_map(self) -> dict:
        # LQI scans are sequential (up to 5 s per device); allow plenty of time
        return await self._client.request("get_network_map", timeout=120.0)

    async def async_get_groups(self) -> dict:
        return await self._client.request("get_groups")

    async def async_create_group(self, group_id: int) -> dict:
        return await self._client.request("create_group", {"group_id": group_id})

    async def async_remove_group(self, group_id: int) -> None:
        await self._client.request("remove_group", {"group_id": group_id})

    async def async_add_group_member(self, group_id: int, ieee_address: str, endpoint_id: int = 1) -> dict:
        return await self._client.request("add_group_member", {
            "group_id": group_id, "ieee_address": ieee_address, "endpoint_id": endpoint_id
        })

    async def async_remove_group_member(self, group_id: int, ieee_address: str, endpoint_id: int = 1) -> dict:
        return await self._client.request("remove_group_member", {
            "group_id": group_id, "ieee_address": ieee_address, "endpoint_id": endpoint_id
        })

    async def async_ota_check(self, ieee_address: str) -> dict:
        return await self._client.request("ota_check", {"ieee_address": ieee_address})

    # ── Internal callbacks ────────────────────────────────────────────────

    @callback
    def _on_connected(self) -> None:
        _LOGGER.info("Connected to Zigbee2HASS add-on — awaiting snapshot")

    @callback
    def _on_disconnected(self) -> None:
        _LOGGER.warning("Disconnected from Zigbee2HASS add-on")
        self.bridge_available = False
        # Mark all devices unavailable
        for ieee_address in self.devices:
            self.devices[ieee_address]["available"] = False
            self._dispatch_device(ieee_address)

    @callback
    def _on_message(self, topic: str, payload: dict) -> None:
        """Route incoming messages to the right handler."""

        if topic == TOPIC_BRIDGE_DEVICES:
            self._handle_bridge_devices(payload)

        elif topic == TOPIC_BRIDGE_STATE:
            self._handle_bridge_state(payload)

        elif topic == TOPIC_DEVICE_STATE:
            self._handle_device_state(payload)

        elif topic == TOPIC_DEVICE_AVAIL:
            self._handle_device_availability(payload)

        elif topic == TOPIC_DEVICE_READY:
            self._handle_device_ready(payload)

        elif topic == TOPIC_DEVICE_RENAMED:
            ieee = payload.get("ieee_address")
            name = payload.get("friendly_name")
            if ieee and ieee in self.devices and name:
                self.devices[ieee]["device"]["friendly_name"] = name

        elif topic == TOPIC_DEVICE_LEFT:
            ieee = payload.get("ieee_address")
            if ieee:
                if ieee in self.devices:
                    del self.devices[ieee]
                # Remove device and all its entities from HA
                dev_reg = dr.async_get(self.hass)
                device_entry = dev_reg.async_get_device(
                    identifiers={(DOMAIN, ieee)}
                )
                if device_entry:
                    dev_reg.async_remove_device(device_entry.id)
                # Let platforms do any extra cleanup
                self.hass.bus.fire(f"{DOMAIN}_device_left", {
                    "entry_id":   self.entry.entry_id,
                    "ieee_address": ieee,
                })

        elif topic == TOPIC_DEVICE_JOINED:
            # ieee may be 'ieee_address' (serialised) or 'ieeeAddr' (raw ZHC v9)
            ieee = payload.get("ieee_address") or payload.get("ieeeAddr")
            if ieee:
                self.hass.bus.fire(f"{DOMAIN}_pairing_event", {
                    "type":         "joined",
                    "ieee_address": ieee,
                    "model_id":     payload.get("model_id"),
                    "entry_id":     self.entry.entry_id,
                })

        elif topic == TOPIC_DEVICE_INTERVIEW:
            ieee   = payload.get("ieee_address")
            status = payload.get("status")
            if ieee and status:
                self.hass.bus.fire(f"{DOMAIN}_pairing_event", {
                    "type":         "interview",
                    "ieee_address": ieee,
                    "model_id":     payload.get("model_id"),
                    "status":       status,
                    "entry_id":     self.entry.entry_id,
                })

        elif topic == TOPIC_PERMIT_JOIN:
            # ZHC emits 'permitted' in v9; older versions used 'permit'
            self.permit_join = payload.get("permit", payload.get("permitted", False))
            # Remaining time: ZHC calls it 'timeout'
            remaining = payload.get("timeout", payload.get("remaining", 0))
            self.hass.bus.fire(f"{DOMAIN}_pairing_event", {
                "type":      "permit_join",
                "permit":    self.permit_join,
                "remaining": remaining,
                "entry_id":  self.entry.entry_id,
            })

        # Dispatch to topic subscribers
        for fn in self._subscribers.get(topic, []):
            try:
                fn(payload)
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("Subscriber error for topic %s: %s", topic, exc)

    def _handle_bridge_devices(self, payload: dict) -> None:
        """Full device snapshot — reconcile against current HA state."""
        self.bridge_available = True
        for device_data in payload.get("devices", []):
            ieee = device_data["ieee_address"]
            self.devices[ieee] = {
                "device":     device_data,
                "definition": device_data.get("definition"),
                "state":      device_data.get("state", {}),
                "available":  device_data.get("available", False),
            }

        _LOGGER.info("Snapshot received: %d devices total", len(self.devices))

        # Log each non-coordinator device so it's easy to diagnose missing exposes
        dev_reg = dr.async_get(self.hass)
        for ieee, data in self.devices.items():
            if ieee == "coordinator":
                continue
            device     = data.get("device", {})
            definition = data.get("definition") or {}
            exposes    = definition.get("exposes", [])
            model_id   = device.get("model_id") or "?"
            _LOGGER.info(
                "Snapshot device: %s  model=%s  exposes=%d",
                ieee, model_id, len(exposes),
            )
            # Eagerly register HA device even if no entities yet — ensures the
            # panel can map ieee → HA device id regardless of exposes state.
            dev_reg.async_get_or_create(
                config_entry_id=self.entry.entry_id,
                identifiers={(DOMAIN, ieee)},
                name=device.get("friendly_name") or model_id,
                manufacturer=device.get("manufacturer"),
                model=model_id,
                via_device=(DOMAIN, "coordinator"),
                sw_version=device.get("software_build_id"),
            )

        # Unblock async_start() if it's still waiting
        if self._snapshot_event and not self._snapshot_event.is_set():
            self._snapshot_event.set()

        # Trigger platform setup for new devices
        self.hass.bus.fire(f"{DOMAIN}_devices_loaded", {"entry_id": self.entry.entry_id})

    def _handle_bridge_state(self, payload: dict) -> None:
        state = payload.get("state")
        self.bridge_available = state == "online"
        if state == "coordinator_failed":
            _LOGGER.error("Zigbee coordinator reported as failed!")

    def _handle_device_state(self, payload: dict) -> None:
        ieee = payload.get("ieee_address")
        if not ieee:
            return
        if ieee not in self.devices:
            self.devices[ieee] = {"device": {}, "definition": None, "state": {}, "available": True}

        state_update = payload.get("state", {})
        self.devices[ieee]["state"].update(state_update)
        self._dispatch_device(ieee)

        # Fire HA event for action values — lets automations trigger on button
        # presses without needing to track sensor entity state transitions.
        action = state_update.get("action")
        if action is not None and action != "":
            self.hass.bus.fire(f"{DOMAIN}_action", {
                "ieee_address": ieee,
                "action":       action,
                "entry_id":     self.entry.entry_id,
            })

    def _handle_device_availability(self, payload: dict) -> None:
        ieee = payload.get("ieee_address")
        if not ieee:
            return
        if ieee in self.devices:
            self.devices[ieee]["available"] = payload.get("available", False)
        self._dispatch_device(ieee)

    def _handle_device_ready(self, payload: dict) -> None:
        device     = payload.get("device", {})
        definition = payload.get("definition")
        ieee       = device.get("ieee_address")
        if not ieee:
            return

        # Never overwrite a valid definition with null.  The add-on can fire
        # device_ready with definition=null during the device-announce phase
        # before the interview is complete (modelID not yet known).  If we
        # already have a real definition cached, keep it.
        existing = self.devices.get(ieee, {})
        if definition is None:
            definition = existing.get("definition")

        # Preserve existing state across re-announces so entities don't
        # momentarily show "unknown" when a device reconnects.
        self.devices[ieee] = {
            "device":     device,
            "definition": definition,
            "state":      existing.get("state", {}),
            "available":  True,
        }

        exposes  = (definition or {}).get("exposes", [])
        model_id = device.get("model_id") or "?"
        _LOGGER.info(
            "Device ready: %s  model=%s  exposes=%d",
            ieee, model_id, len(exposes),
        )

        # Eagerly register the HA device so haDeviceMap can find it
        dev_reg = dr.async_get(self.hass)
        dev_reg.async_get_or_create(
            config_entry_id=self.entry.entry_id,
            identifiers={(DOMAIN, ieee)},
            name=device.get("friendly_name") or model_id,
            manufacturer=device.get("manufacturer"),
            model=model_id,
            via_device=(DOMAIN, "coordinator"),
            sw_version=device.get("software_build_id"),
        )

        # If we still have no definition (interview not yet complete), don't
        # fire the HA entity-creation event.  The add-on will fire another
        # device_ready once the interview succeeds and we have real exposes.
        if definition is None:
            _LOGGER.debug(
                "Device ready with no definition for %s — deferring entity creation to interview completion",
                ieee,
            )
            return

        # Fire event so platforms can add new entities at runtime
        self.hass.bus.fire(f"{DOMAIN}_device_ready", {
            "entry_id":   self.entry.entry_id,
            "ieee_address": ieee,
        })
        # Also fire a pairing event so the panel modal can update its device list
        self.hass.bus.fire(f"{DOMAIN}_pairing_event", {
            "type":         "ready",
            "ieee_address": ieee,
            "model_id":     device.get("model_id"),
            "friendly_name": device.get("friendly_name"),
            "entry_id":     self.entry.entry_id,
        })

    def _dispatch_device(self, ieee_address: str) -> None:
        """Notify all subscribers watching a specific device."""
        for fn in self._device_subscribers.get(ieee_address, []):
            try:
                fn(self.devices[ieee_address])
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("Device subscriber error (%s): %s", ieee_address, exc)
