"""Switch platform for Zigbee2HASS."""
from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
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
        for expose in platforms.get("switch", []):
            # For multi-endpoint switches (e.g. TS0003 3-gang) the top-level
            # expose has no 'name' but does have 'endpoint'.  Use endpoint as
            # the disambiguator so each gang gets a unique entity.
            ep_suffix  = expose.get("endpoint") or expose.get("name") or "switch"
            uid = f"{ieee_address}_switch_{ep_suffix}"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSSwitch(coordinator, ieee_address, expose))

        if entities:
            _LOGGER.debug(
                "Adding %d switch entity(s) for %s",
                len(entities), ieee_address,
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


class Zigbee2HASSSwitch(Zigbee2HASSEntity, SwitchEntity):
    """Representation of a Zigbee switch."""

    def __init__(self, coordinator, ieee_address, expose) -> None:
        # For multi-endpoint switches (e.g. TS0003 3-gang), the top-level
        # expose has type="switch" with an "endpoint" key ("left"/"center"/"right")
        # but no top-level "name" or "property".  The actual state property lives
        # in features[0].property (e.g. "state_left").
        features = expose.get("features", [])
        state_feature = next(
            (f for f in features if f.get("name") == "state"), None
        )
        # Resolved state property: top-level → feature → "state"
        self._state_property = (
            expose.get("property")
            or (state_feature.get("property") if state_feature else None)
            or "state"
        )
        # For multi-endpoint devices include the endpoint in the unique_id so
        # each gang has its own stable entity.
        endpoint = expose.get("endpoint")
        super().__init__(
            coordinator, ieee_address, expose,
            unique_id_suffix=f"_{endpoint}" if endpoint else "",
        )
        # Override the display name for multi-gang devices to be friendlier.
        if endpoint:
            self._attr_name = f"Switch {endpoint.capitalize()}"

    @property
    def is_on(self) -> bool | None:
        val = self._get_state_value(self._state_property)
        if isinstance(val, bool):
            return val
        return str(val).upper() == "ON" if val is not None else None

    async def async_turn_on(self, **kwargs) -> None:
        await self._coordinator.async_set_state(
            self._ieee_address, {self._state_property: "ON"}
        )

    async def async_turn_off(self, **kwargs) -> None:
        await self._coordinator.async_set_state(
            self._ieee_address, {self._state_property: "OFF"}
        )
