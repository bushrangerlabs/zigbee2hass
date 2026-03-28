"""Diagnostics support for Zigbee2HASS."""
from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator

# Fields to redact from diagnostics output (security)
TO_REDACT = {"network_key", "pan_id", "ext_pan_id", "ieee_address"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    coordinator: Zigbee2HASSCoordinator = hass.data[DOMAIN][entry.entry_id]

    # Collect device diagnostics
    device_diag = []
    for ieee_address, device_data in coordinator.devices.items():
        device_diag.append({
            "ieee_address": ieee_address,
            "model_id":     device_data.get("device", {}).get("model_id"),
            "manufacturer": device_data.get("device", {}).get("manufacturer"),
            "type":         device_data.get("device", {}).get("type"),
            "power_source": device_data.get("device", {}).get("power_source"),
            "available":    device_data.get("available"),
            "state":        device_data.get("state", {}),
            "has_definition": device_data.get("definition") is not None,
        })

    # Get health status from add-on
    health = {}
    try:
        health = await coordinator.async_get_health()
    except Exception:  # noqa: BLE001
        pass

    diagnostics = {
        "config_entry": {
            "host":    entry.data.get("host"),
            "port":    entry.data.get("port"),
            "version": entry.version,
        },
        "bridge": {
            "available":    coordinator.bridge_available,
            "permit_join":  coordinator.permit_join,
            "device_count": len(coordinator.devices),
        },
        "health": health,
        "devices": device_diag,
    }

    return async_redact_data(diagnostics, TO_REDACT)
