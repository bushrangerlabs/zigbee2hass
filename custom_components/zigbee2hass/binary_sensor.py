"""Binary sensor platform for Zigbee2HASS."""
from __future__ import annotations

import logging

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms

_LOGGER = logging.getLogger(__name__)

# Map expose name → HA binary sensor device class
BINARY_CLASS_MAP: dict[str, str] = {
    "occupancy":       BinarySensorDeviceClass.OCCUPANCY,
    "contact":         BinarySensorDeviceClass.DOOR,
    "water_leak":      BinarySensorDeviceClass.MOISTURE,
    "smoke":           BinarySensorDeviceClass.SMOKE,
    "gas":             BinarySensorDeviceClass.GAS,
    "carbon_monoxide": BinarySensorDeviceClass.CO,
    "vibration":       BinarySensorDeviceClass.VIBRATION,
    "presence":        BinarySensorDeviceClass.PRESENCE,
    "tamper":          BinarySensorDeviceClass.TAMPER,
    "moving":          BinarySensorDeviceClass.MOVING,
    "rain":            BinarySensorDeviceClass.MOISTURE,
    "frost":           BinarySensorDeviceClass.COLD,
    "alarm":           BinarySensorDeviceClass.PROBLEM,
    "battery_low":     BinarySensorDeviceClass.BATTERY,
}


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

        _LOGGER.debug(
            "[binary_sensor] _add_for_device %s: definition=%s exposes=%d binary_matches=%d",
            ieee_address,
            definition.get("model") or ("present" if definition else "MISSING"),
            len(exposes),
            len(platforms.get("binary_sensor", [])),
        )

        entities = []
        for expose in platforms.get("binary_sensor", []):
            uid = f"{ieee_address}_binary_{expose.get('name', expose.get('property', 'unknown'))}"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSBinarySensor(coordinator, ieee_address, expose))

        if entities:
            _LOGGER.info(
                "Adding %d binary_sensor entity(s) for %s (model=%s)",
                len(entities), ieee_address, definition.get("model", "?"),
            )
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


class Zigbee2HASSBinarySensor(Zigbee2HASSEntity, BinarySensorEntity):
    """Representation of a Zigbee binary sensor."""

    def __init__(self, coordinator, ieee_address, expose) -> None:
        super().__init__(coordinator, ieee_address, expose)
        name = expose.get("name", "")
        self._attr_device_class = BINARY_CLASS_MAP.get(name)
        self._property = expose.get("property", name)
        # value_on: what value means "true" (usually True or "true" or 1)
        self._value_on = expose.get("value_on", True)

    @property
    def is_on(self) -> bool | None:
        val = self._get_state_value(self._property)
        if val is None:
            return None
        return val == self._value_on or val is True or str(val).lower() == "true"
