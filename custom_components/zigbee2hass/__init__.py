"""Zigbee2HASS — Home Assistant Custom Integration.

Architecture:
  - Config entry stores add-on host/port
  - On setup, connects WebSocket client to the add-on
  - Receives full device snapshot on connect (state reconciliation)
  - Creates devices + entities dynamically from zigbee-herdsman 'exposes'
  - Handles reconnection gracefully — entities go unavailable, recover on reconnect
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN
from .websocket_client import Zigbee2HASSClient
from .coordinator import Zigbee2HASSCoordinator
from .services import async_register_services, async_unregister_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.LIGHT,
    Platform.SWITCH,
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.COVER,
    Platform.CLIMATE,
    Platform.LOCK,
    Platform.FAN,
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Zigbee2HASS from a config entry."""
    host = entry.data["host"]
    port = entry.data["port"]

    coordinator = Zigbee2HASSCoordinator(hass, entry, host, port)

    try:
        await coordinator.async_start()
    except Exception as exc:
        raise ConfigEntryNotReady(f"Cannot connect to Zigbee2HASS add-on at {host}:{port}") from exc

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    async_register_services(hass)

    entry.async_on_unload(entry.add_update_listener(async_update_options))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        coordinator: Zigbee2HASSCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_stop()

    return unload_ok


async def async_update_options(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update."""
    await hass.config_entries.async_reload(entry.entry_id)
