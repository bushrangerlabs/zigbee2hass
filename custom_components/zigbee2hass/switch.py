"""Switch platform for Zigbee2HASS."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

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
        for expose in platforms.get("switch", []):
            uid = f"{ieee_address}_switch_{expose.get('name', 'switch')}"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSSwitch(coordinator, ieee_address, expose))

        if entities:
            async_add_entities(entities)

    for ieee_address in coordinator.devices:
        _add_for_device(ieee_address)

    def _on_device_ready(event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            _add_for_device(event.data["ieee_address"])

    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_device_ready", _on_device_ready)
    )


class Zigbee2HASSSwitch(Zigbee2HASSEntity, SwitchEntity):
    """Representation of a Zigbee switch."""

    @property
    def is_on(self) -> bool | None:
        prop = self._expose.get("property", "state")
        val  = self._get_state_value(prop)
        if isinstance(val, bool):
            return val
        return str(val).upper() == "ON" if val is not None else None

    async def async_turn_on(self, **kwargs) -> None:
        prop = self._expose.get("property", "state")
        await self._coordinator.async_set_state(self._ieee_address, {prop: "ON"})

    async def async_turn_off(self, **kwargs) -> None:
        prop = self._expose.get("property", "state")
        await self._coordinator.async_set_state(self._ieee_address, {prop: "OFF"})
