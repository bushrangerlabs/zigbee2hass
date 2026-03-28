"""Base entity class for Zigbee2HASS entities."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import callback
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity_factory import get_device_info

_LOGGER = logging.getLogger(__name__)


class Zigbee2HASSEntity(Entity):
    """Base class for all Zigbee2HASS entities."""

    _attr_should_poll = False  # Push-based, not polled

    def __init__(
        self,
        coordinator: Zigbee2HASSCoordinator,
        ieee_address: str,
        expose: dict,
        unique_id_suffix: str = "",
    ) -> None:
        self._coordinator  = coordinator
        self._ieee_address = ieee_address
        self._expose       = expose
        self._unsub        = None

        expose_name = expose.get("name", expose.get("property", "unknown"))
        self._attr_unique_id = f"{DOMAIN}_{ieee_address}_{expose_name}{unique_id_suffix}"
        self._attr_name      = self._friendly_name(expose_name)

        device_data = coordinator.devices.get(ieee_address, {})
        self._attr_device_info = get_device_info(device_data.get("device", {"ieee_address": ieee_address}))

    def _friendly_name(self, expose_name: str) -> str:
        return expose_name.replace("_", " ").title()

    @property
    def available(self) -> bool:
        dev = self._coordinator.devices.get(self._ieee_address, {})
        return dev.get("available", False) and self._coordinator.bridge_available

    def _get_state_value(self, key: str, default: Any = None) -> Any:
        dev = self._coordinator.devices.get(self._ieee_address, {})
        return dev.get("state", {}).get(key, default)

    async def async_added_to_hass(self) -> None:
        self._unsub = self._coordinator.subscribe_device(
            self._ieee_address, self._on_device_update
        )

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()

    @callback
    def _on_device_update(self, device_data: dict) -> None:
        self.async_write_ha_state()
