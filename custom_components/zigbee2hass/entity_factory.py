"""Entity factory — translates zigbee-herdsman 'exposes' into HA entity types.

zigbee-herdsman-converters describes device capabilities via an 'exposes' array.
Each expose entry has a 'type' and 'features' (for composites) or direct properties.

This factory maps those to the correct HA platform and entity class.

Example exposes structure:
  [
    { "type": "light", "features": [
        { "type": "binary", "name": "state", "property": "state", ... },
        { "type": "numeric", "name": "brightness", "property": "brightness", ... },
        { "type": "numeric", "name": "color_temp", "property": "color_temp", ... }
    ]},
    { "type": "numeric", "name": "linkquality", "property": "linkquality", ... }
  ]
"""
from __future__ import annotations

from typing import Any

from homeassistant.const import Platform

from .const import (
    EXPOSE_BINARY,
    EXPOSE_CLIMATE,
    EXPOSE_COVER,
    EXPOSE_ENUM,
    EXPOSE_FAN,
    EXPOSE_LIGHT,
    EXPOSE_LOCK,
    EXPOSE_SENSOR,
    EXPOSE_SWITCH,
    EXPOSE_COMPOSITE,
)

# Sensor names that should be binary sensors instead of regular sensors
BINARY_SENSOR_NAMES = {
    "occupancy", "contact", "water_leak", "smoke", "gas",
    "carbon_monoxide", "vibration", "presence", "tamper",
    "alarm", "moving", "rain", "frost",
}

# Sensor names to skip (internal/diagnostic only surfaced via diagnostics panel)
SKIP_SENSOR_NAMES = {"linkquality"}


def exposes_to_platforms(exposes: list[dict]) -> dict[Platform, list[dict]]:
    """
    Given a device's exposes list, return a dict mapping Platform → list of expose configs.
    Each config contains enough info for the platform to create the right entity.
    """
    result: dict[Platform, list[dict]] = {}

    for expose in exposes:
        expose_type = expose.get("type", "")
        name        = expose.get("name", "")

        if expose_type == EXPOSE_LIGHT:
            result.setdefault(Platform.LIGHT, []).append(expose)

        elif expose_type == EXPOSE_SWITCH:
            result.setdefault(Platform.SWITCH, []).append(expose)

        elif expose_type == EXPOSE_COVER:
            result.setdefault(Platform.COVER, []).append(expose)

        elif expose_type == EXPOSE_CLIMATE:
            result.setdefault(Platform.CLIMATE, []).append(expose)

        elif expose_type == EXPOSE_LOCK:
            result.setdefault(Platform.LOCK, []).append(expose)

        elif expose_type == EXPOSE_FAN:
            result.setdefault(Platform.FAN, []).append(expose)

        elif expose_type == EXPOSE_BINARY:
            if name in SKIP_SENSOR_NAMES:
                continue
            if name in BINARY_SENSOR_NAMES:
                result.setdefault(Platform.BINARY_SENSOR, []).append(expose)
            else:
                result.setdefault(Platform.SENSOR, []).append(expose)

        elif expose_type in (EXPOSE_SENSOR, EXPOSE_ENUM):
            if name in SKIP_SENSOR_NAMES:
                continue
            result.setdefault(Platform.SENSOR, []).append(expose)

        elif expose_type == EXPOSE_COMPOSITE:
            # Recurse into composite features
            sub = exposes_to_platforms(expose.get("features", []))
            for platform, items in sub.items():
                result.setdefault(platform, []).extend(items)

    return result


def get_device_info(device: dict, coordinator_name: str = "Zigbee2HASS") -> dict:
    """Build a HA device_info dict from a herdsman device object."""
    return {
        "identifiers":    {("zigbee2hass", device["ieee_address"])},
        "name":           device.get("model_id") or device["ieee_address"],
        "manufacturer":   device.get("manufacturer"),
        "model":          device.get("model_id"),
        "via_device":     ("zigbee2hass", coordinator_name),
        "sw_version":     None,
    }


def feature_access_readable(feature: dict) -> bool:
    """Return True if the feature can be read (access bit 1)."""
    return bool(feature.get("access", 0) & 1)


def feature_access_settable(feature: dict) -> bool:
    """Return True if the feature can be set (access bit 2)."""
    return bool(feature.get("access", 0) & 2)
