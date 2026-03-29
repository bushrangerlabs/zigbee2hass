"""Light platform for Zigbee2HASS."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_HS_COLOR,
    ATTR_RGB_COLOR,
    ATTR_XY_COLOR,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, EXPOSE_LIGHT
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: Zigbee2HASSCoordinator = hass.data[DOMAIN][entry.entry_id]
    added: set[str] = set()

    def _add_for_device(ieee_address: str) -> None:
        device_data = coordinator.devices.get(ieee_address, {})
        definition  = device_data.get("definition") or {}
        exposes     = definition.get("exposes", [])
        platforms   = exposes_to_platforms(exposes)

        entities = []
        for expose in platforms.get("light", []):
            uid = f"{ieee_address}_light"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSLight(coordinator, ieee_address, expose))

        if entities:
            async_add_entities(entities)

    # Add for already-known devices
    for ieee_address in coordinator.devices:
        _add_for_device(ieee_address)

    # Listen for new devices coming online at runtime
    def _on_device_ready(event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            _add_for_device(event.data["ieee_address"])

    def _on_devices_loaded(event) -> None:
        """Handle full device snapshot — add entities for any not yet processed."""
        if event.data.get("entry_id") == entry.entry_id:
            for ieee_address in coordinator.devices:
                _add_for_device(ieee_address)

    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_device_ready", _on_device_ready)
    )
    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_devices_loaded", _on_devices_loaded)
    )


class Zigbee2HASSLight(Zigbee2HASSEntity, LightEntity):
    """Representation of a Zigbee light."""

    def __init__(self, coordinator: Zigbee2HASSCoordinator, ieee_address: str, expose: dict) -> None:
        super().__init__(coordinator, ieee_address, expose)
        self._determine_color_modes(expose)

    def _determine_color_modes(self, expose: dict) -> None:
        features    = {f["name"] for f in expose.get("features", [])}
        color_modes = set()

        if "color_xy" in features or "color_hs" in features:
            color_modes.add(ColorMode.HS)
        if "color_temp" in features:
            color_modes.add(ColorMode.COLOR_TEMP)
        if "brightness" in features and not color_modes:
            color_modes.add(ColorMode.BRIGHTNESS)
        if not color_modes:
            color_modes.add(ColorMode.ONOFF)

        self._attr_supported_color_modes = color_modes
        self._attr_color_mode = next(iter(color_modes))

    @property
    def is_on(self) -> bool | None:
        return self._get_state_value("state") == "ON"

    @property
    def brightness(self) -> int | None:
        val = self._get_state_value("brightness")
        return int(val) if val is not None else None

    @property
    def color_temp_kelvin(self) -> int | None:
        """Return color temperature in Kelvin (HA 2024+ standard)."""
        mireds = self._get_state_value("color_temp")
        if mireds is not None and int(mireds) > 0:
            return round(1_000_000 / int(mireds))
        return None

    @property
    def hs_color(self) -> tuple[float, float] | None:
        color = self._get_state_value("color")
        if color and "hue" in color and "saturation" in color:
            return (color["hue"], color["saturation"])
        return None

    async def async_turn_on(self, **kwargs: Any) -> None:
        payload: dict[str, Any] = {"state": "ON"}

        if ATTR_BRIGHTNESS in kwargs:
            payload["brightness"] = kwargs[ATTR_BRIGHTNESS]
        if ATTR_COLOR_TEMP_KELVIN in kwargs:
            kelvin = kwargs[ATTR_COLOR_TEMP_KELVIN]
            payload["color_temp"] = round(1_000_000 / kelvin)  # convert to mireds for device
        if ATTR_HS_COLOR in kwargs:
            h, s = kwargs[ATTR_HS_COLOR]
            payload["color"] = {"hue": h, "saturation": s}
        if ATTR_RGB_COLOR in kwargs:
            r, g, b = kwargs[ATTR_RGB_COLOR]
            payload["color"] = {"r": r, "g": g, "b": b}

        await self._coordinator.async_set_state(self._ieee_address, payload)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "OFF"})
