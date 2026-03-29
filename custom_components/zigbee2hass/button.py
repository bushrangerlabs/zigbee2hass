"""Button platform for Zigbee2HASS — coordinator-level controls."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator

BRIDGE_DEVICE_INFO = {
    "identifiers": {(DOMAIN, "coordinator")},
    "name":        "Zigbee2HASS Bridge",
    "manufacturer": "Zigbee2HASS",
    "model":       "Zigbee Coordinator",
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: Zigbee2HASSCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([
        PermitJoinButton(coordinator, entry),
    ])


class PermitJoinButton(ButtonEntity):
    """Button: open the Zigbee network for new device pairing (254 s window)."""

    _attr_should_poll = False
    _attr_icon        = "mdi:zigbee"
    _attr_name        = "Permit Join"

    def __init__(self, coordinator: Zigbee2HASSCoordinator, entry: ConfigEntry) -> None:
        self._coordinator            = coordinator
        self._attr_unique_id         = f"{DOMAIN}_{entry.entry_id}_permit_join"
        self._attr_device_info       = BRIDGE_DEVICE_INFO

    async def async_press(self) -> None:
        await self._coordinator.async_permit_join(True, 254)
