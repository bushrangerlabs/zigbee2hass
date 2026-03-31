"""Fan platform for Zigbee2HASS."""
from __future__ import annotations

import math
from typing import Any

from homeassistant.components.fan import (
    ATTR_PERCENTAGE,
    ATTR_PRESET_MODE,
    FanEntity,
    FanEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util.percentage import (
    ordered_list_item_to_percentage,
    percentage_to_ordered_list_item,
)

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms


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
        for expose in platforms.get("fan", []):
            uid = f"{ieee_address}_fan"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSFan(coordinator, ieee_address, expose))

        if entities:
            async_add_entities(entities)

    for ieee_address in coordinator.devices:
        _add_for_device(ieee_address)

    def _on_device_ready(event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            _add_for_device(event.data["ieee_address"])

    def _on_devices_loaded(event) -> None:
        """Handle full device snapshot — add entities for any not yet processed."""
        if event.data.get("entry_id") == entry.entry_id:
            for ieee_address in coordinator.devices:
                _add_for_device(ieee_address)

    def _on_device_left(event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            ieee = event.data.get("ieee_address")
            if ieee:
                stale = {uid for uid in added if uid.startswith(f"{ieee}_")}
                added.difference_update(stale)

    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_device_ready", _on_device_ready)
    )
    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_devices_loaded", _on_devices_loaded)
    )
    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_device_left", _on_device_left)
    )


class Zigbee2HASSFan(Zigbee2HASSEntity, FanEntity):
    """Representation of a Zigbee fan."""

    def __init__(self, coordinator: Zigbee2HASSCoordinator, ieee_address: str, expose: dict) -> None:
        super().__init__(coordinator, ieee_address, expose)

        features_list = expose.get("features", [])
        feature_names = {f["name"] for f in features_list}
        supported     = FanEntityFeature.TURN_ON | FanEntityFeature.TURN_OFF

        # Speed / percentage support
        speed_feature = next((f for f in features_list if f.get("name") in ("fan_mode", "fan_speed")), None)
        self._speed_list: list[str] = []

        if speed_feature and speed_feature.get("values"):
            self._speed_list = [v for v in speed_feature["values"] if v != "off"]
            supported |= FanEntityFeature.SET_SPEED

        # Preset modes
        preset_feature = next((f for f in features_list if f.get("name") == "preset"), None)
        if preset_feature:
            self._attr_preset_modes = preset_feature.get("values", [])
            supported |= FanEntityFeature.PRESET_MODE

        self._attr_supported_features = supported

    @property
    def is_on(self) -> bool | None:
        state = self._get_state_value("state") or self._get_state_value("fan_mode")
        if state is None:
            return None
        return str(state).upper() not in ("OFF", "0", "FALSE")

    @property
    def percentage(self) -> int | None:
        if not self._speed_list:
            return None
        current = self._get_state_value("fan_mode") or self._get_state_value("fan_speed")
        if current and current in self._speed_list:
            return ordered_list_item_to_percentage(self._speed_list, current)
        return None

    @property
    def preset_mode(self) -> str | None:
        return self._get_state_value("preset")

    async def async_turn_on(
        self,
        percentage: int | None = None,
        preset_mode: str | None = None,
        **kwargs: Any,
    ) -> None:
        if percentage is not None and self._speed_list:
            speed = percentage_to_ordered_list_item(self._speed_list, percentage)
            await self._coordinator.async_set_state(self._ieee_address, {"fan_mode": speed})
        elif preset_mode:
            await self._coordinator.async_set_state(self._ieee_address, {"preset": preset_mode})
        else:
            speed = self._speed_list[len(self._speed_list) // 2] if self._speed_list else None
            payload = {"fan_mode": speed} if speed else {"state": "ON"}
            await self._coordinator.async_set_state(self._ieee_address, payload)

    async def async_turn_off(self, **kwargs: Any) -> None:
        if self._speed_list:
            await self._coordinator.async_set_state(self._ieee_address, {"fan_mode": "off"})
        else:
            await self._coordinator.async_set_state(self._ieee_address, {"state": "OFF"})

    async def async_set_percentage(self, percentage: int) -> None:
        if not self._speed_list:
            return
        speed = percentage_to_ordered_list_item(self._speed_list, percentage)
        await self._coordinator.async_set_state(self._ieee_address, {"fan_mode": speed})

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"preset": preset_mode})
