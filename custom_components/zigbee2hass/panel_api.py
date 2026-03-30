"""Zigbee2HASS — HA WebSocket API commands for the custom panel.

These commands are called from the Zigbee2HASS panel via hass.callWS().
All commands talk to the coordinator which proxies to the add-on.
"""
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def async_register_panel_api(hass: HomeAssistant) -> None:
    """Register all WebSocket API commands for the panel."""
    websocket_api.async_register_command(hass, ws_get_devices)
    websocket_api.async_register_command(hass, ws_permit_join)
    websocket_api.async_register_command(hass, ws_remove_device)
    websocket_api.async_register_command(hass, ws_rename_device)
    websocket_api.async_register_command(hass, ws_ping_device)
    websocket_api.async_register_command(hass, ws_configure_device)
    websocket_api.async_register_command(hass, ws_get_network_map)
    websocket_api.async_register_command(hass, ws_backup)
    websocket_api.async_register_command(hass, ws_get_groups)
    websocket_api.async_register_command(hass, ws_create_group)
    websocket_api.async_register_command(hass, ws_remove_group)
    websocket_api.async_register_command(hass, ws_add_group_member)
    websocket_api.async_register_command(hass, ws_remove_group_member)
    websocket_api.async_register_command(hass, ws_ota_check)


def _get_coordinator(hass: HomeAssistant, connection, msg_id: int):
    """Return first active coordinator or send an error and return None."""
    coordinators = list(hass.data.get(DOMAIN, {}).values())
    # Skip the _panel_registered sentinel value (not a coordinator)
    coordinators = [c for c in coordinators if hasattr(c, "devices")]
    if not coordinators:
        connection.send_error(msg_id, "not_loaded", "Zigbee2HASS integration not loaded")
        return None
    return coordinators[0]


# ── get_devices ───────────────────────────────────────────────────────────────

@websocket_api.websocket_command({"type": "zigbee2hass/get_devices"})
@websocket_api.async_response
async def ws_get_devices(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return

    devices = []
    for ieee, data in coordinator.devices.items():
        device = data.get("device", {})
        definition = data.get("definition") or {}
        state = data.get("state", {})
        available = data.get("available", False)
        devices.append({
            "ieee_address":       ieee,
            "friendly_name":      device.get("friendly_name") or device.get("model_id") or ieee,
            "model_id":           device.get("model_id"),
            "manufacturer":       device.get("manufacturer"),
            "type":               device.get("type"),
            "power_source":       device.get("power_source"),
            "interview_completed": device.get("interview_completed", False),
            "last_seen":          device.get("last_seen"),
            "definition":         definition,
            "state":              state,
            "available":          available,
        })

    connection.send_result(msg["id"], {
        "devices":         devices,
        "bridge_available": coordinator.bridge_available,
        "permit_join":     coordinator.permit_join,
    })


# ── permit_join ───────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/permit_join",
    vol.Required("permit"):             bool,
    vol.Optional("timeout", default=254): int,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_permit_join(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    await coordinator.async_permit_join(msg["permit"], msg.get("timeout", 254))
    connection.send_result(msg["id"], {"permit": msg["permit"]})


# ── remove_device ─────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/remove_device",
    vol.Required("ieee_address"): str,
    vol.Optional("force", default=False): bool,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_remove_device(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    await coordinator.async_remove_device(msg["ieee_address"], force=msg.get("force", False))
    connection.send_result(msg["id"], {"removed": True})


# ── rename_device ─────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/rename_device",
    vol.Required("ieee_address"): str,
    vol.Required("name"):         str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_rename_device(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    await coordinator.async_rename_device(msg["ieee_address"], msg["name"])
    connection.send_result(msg["id"], {"renamed": True})


# ── ping_device ───────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/ping_device",
    vol.Required("ieee_address"): str,
})
@websocket_api.async_response
async def ws_ping_device(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    latency = await coordinator.async_ping_device(msg["ieee_address"])
    connection.send_result(msg["id"], {"latency_ms": latency})


# ── configure_device ──────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/configure_device",
    vol.Required("ieee_address"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_configure_device(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_configure_device(msg["ieee_address"])
    connection.send_result(msg["id"], result)


# ── get_network_map ───────────────────────────────────────────────────────────

@websocket_api.websocket_command({"type": "zigbee2hass/get_network_map"})
@websocket_api.async_response
async def ws_get_network_map(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    try:
        result = await coordinator.async_get_network_map()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "get_network_map_failed", str(err))
        return
    connection.send_result(msg["id"], result)


# ── backup ────────────────────────────────────────────────────────────────────

@websocket_api.websocket_command({"type": "zigbee2hass/backup"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_backup(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    path = await coordinator.async_backup()
    connection.send_result(msg["id"], {"path": path})


# ── get_groups ────────────────────────────────────────────────────────────────

@websocket_api.websocket_command({"type": "zigbee2hass/get_groups"})
@websocket_api.async_response
async def ws_get_groups(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_get_groups()
    connection.send_result(msg["id"], result)


# ── create_group ──────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/create_group",
    vol.Required("group_id"): int,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_create_group(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_create_group(msg["group_id"])
    connection.send_result(msg["id"], result)


# ── remove_group ──────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/remove_group",
    vol.Required("group_id"): int,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_remove_group(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    await coordinator.async_remove_group(msg["group_id"])
    connection.send_result(msg["id"], {"removed": True})


# ── add_group_member ──────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/add_group_member",
    vol.Required("group_id"):     int,
    vol.Required("ieee_address"): str,
    vol.Optional("endpoint_id", default=1): int,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_add_group_member(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_add_group_member(
        msg["group_id"], msg["ieee_address"], msg.get("endpoint_id", 1)
    )
    connection.send_result(msg["id"], result)


# ── remove_group_member ───────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/remove_group_member",
    vol.Required("group_id"):     int,
    vol.Required("ieee_address"): str,
    vol.Optional("endpoint_id", default=1): int,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_remove_group_member(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_remove_group_member(
        msg["group_id"], msg["ieee_address"], msg.get("endpoint_id", 1)
    )
    connection.send_result(msg["id"], result)


# ── ota_check ─────────────────────────────────────────────────────────────────

@websocket_api.websocket_command({
    "type": "zigbee2hass/ota_check",
    vol.Required("ieee_address"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ota_check(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = _get_coordinator(hass, connection, msg["id"])
    if not coordinator:
        return
    result = await coordinator.async_ota_check(msg["ieee_address"])
    connection.send_result(msg["id"], result)
