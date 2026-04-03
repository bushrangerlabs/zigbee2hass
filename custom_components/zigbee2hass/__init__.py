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
from pathlib import Path
from typing import Any

from homeassistant.components.frontend import async_register_built_in_panel, async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN
from .panel_api import async_register_panel_api
from .websocket_client import Zigbee2HASSClient
from .coordinator import Zigbee2HASSCoordinator
from .services import async_register_services, async_unregister_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BUTTON,
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

    _LOGGER.debug("Zigbee2HASS setup starting for %s:%s", host, port)

    coordinator = Zigbee2HASSCoordinator(hass, entry, host, port)

    try:
        await coordinator.async_start()
    except Exception as exc:
        _LOGGER.error("Zigbee2HASS connect failed for %s:%s — %s", host, port, exc, exc_info=True)
        raise ConfigEntryNotReady(f"Cannot connect to Zigbee2HASS add-on at {host}:{port}") from exc

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    # Register the coordinator/bridge as a device in HA so button and other
    # bridge-level entities have a parent device to attach to.
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, "coordinator")},
        name="Zigbee2HASS Bridge",
        manufacturer="Zigbee2HASS",
        model="Zigbee Coordinator",
    )

    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception as exc:
        _LOGGER.error("Zigbee2HASS platform setup failed — %s", exc, exc_info=True)
        raise ConfigEntryNotReady(f"Platform setup failed: {exc}") from exc

    # After ALL platforms have finished their async_setup_entry calls, fire a
    # final devices_loaded event.  This is the definitive fix for the race
    # condition where the bridge/devices snapshot arrives (and the first
    # devices_loaded fires) while platforms are still setting up and their
    # event listeners haven't been registered yet.  By this point all listeners
    # are registered and the per-platform 'added' dedup set prevents doubles.
    if coordinator.devices:
        _LOGGER.info(
            "Post-setup devices_loaded for %d device(s) — ensuring entity creation",
            len(coordinator.devices),
        )
        hass.bus.fire(f"{DOMAIN}_devices_loaded", {"entry_id": entry.entry_id})

    try:
        async_register_services(hass)
    except Exception as exc:
        _LOGGER.error("Zigbee2HASS service registration failed — %s", exc, exc_info=True)

    # Register the Zigbee panel and its HA WebSocket API — do this only once
    # for the whole domain (guard against multiple config entries).
    domain_data = hass.data[DOMAIN]
    if not domain_data.get("_panel_registered"):
        domain_data["_panel_registered"] = True

        www_path = Path(__file__).parent / "www"
        await hass.http.async_register_static_paths([
            StaticPathConfig("/zigbee2hass/panel", str(www_path), cache_headers=False),
        ])

        async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title="Zigbee",
            sidebar_icon="mdi:zigbee",
            frontend_url_path="zigbee2hass-panel",
            config={
                "_panel_custom": {
                    "name":   "zigbee2hass-panel",
                    "js_url": "/zigbee2hass/panel/zigbee2hass-panel.js",
                }
            },
            require_admin=False,
        )

        async_register_panel_api(hass)
        _LOGGER.info("Zigbee2HASS panel registered at /zigbee2hass-panel")

    entry.async_on_unload(entry.add_update_listener(async_update_options))

    _LOGGER.info("Zigbee2HASS setup complete for %s:%s", host, port)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        coordinator: Zigbee2HASSCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_stop()

        # Remove the panel and unregister services when the last config entry is gone
        remaining = [k for k in hass.data[DOMAIN] if k != "_panel_registered"]
        if not remaining:
            async_unregister_services(hass)
            try:
                async_remove_panel(hass, "zigbee2hass-panel")
                hass.data[DOMAIN].pop("_panel_registered", None)
            except Exception:
                pass

    return unload_ok


async def async_update_options(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update."""
    await hass.config_entries.async_reload(entry.entry_id)
