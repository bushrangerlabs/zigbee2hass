"""Cover platform for Zigbee2HASS (blinds, curtains, garage doors)."""
from __future__ import annotations

from homeassistant.components.cover import (
    ATTR_POSITION,
    ATTR_TILT_POSITION,
    CoverDeviceClass,
    CoverEntity,
    CoverEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms

COVER_CLASS_MAP = {
    "blind":   CoverDeviceClass.BLIND,
    "curtain": CoverDeviceClass.CURTAIN,
    "shade":   CoverDeviceClass.SHADE,
    "gate":    CoverDeviceClass.GATE,
    "garage":  CoverDeviceClass.GARAGE,
    "awning":  CoverDeviceClass.AWNING,
    "door":    CoverDeviceClass.DOOR,
    "damper":  CoverDeviceClass.DAMPER,
    "shutter": CoverDeviceClass.SHUTTER,
    "window":  CoverDeviceClass.WINDOW,
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

        entities = []
        for expose in platforms.get("cover", []):
            uid = f"{ieee_address}_cover_{expose.get('name', 'cover')}"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSCover(coordinator, ieee_address, expose))

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

    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_device_ready", _on_device_ready)
    )
    entry.async_on_unload(
        hass.bus.async_listen(f"{DOMAIN}_devices_loaded", _on_devices_loaded)
    )


class Zigbee2HASSCover(Zigbee2HASSEntity, CoverEntity):
    """Representation of a Zigbee cover device."""

    def __init__(self, coordinator: Zigbee2HASSCoordinator, ieee_address: str, expose: dict) -> None:
        super().__init__(coordinator, ieee_address, expose)

        # Determine device class from expose name
        name = expose.get("name", "").lower()
        self._attr_device_class = next(
            (v for k, v in COVER_CLASS_MAP.items() if k in name), CoverDeviceClass.BLIND
        )

        # Determine supported features from expose features list
        features = {f["name"] for f in expose.get("features", [])}
        supported = CoverEntityFeature(0)

        if "state" in features:
            supported |= CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE
        if "position" in features:
            supported |= CoverEntityFeature.SET_POSITION
        if "tilt" in features or "tilt_position" in features:
            supported |= CoverEntityFeature.SET_TILT_POSITION
        if "moving" in features or "running" in features:
            supported |= CoverEntityFeature.STOP

        self._attr_supported_features = supported

    @property
    def is_closed(self) -> bool | None:
        state = self._get_state_value("state")
        if state is None:
            pos = self._get_state_value("position")
            return pos == 0 if pos is not None else None
        return str(state).upper() == "CLOSE"

    @property
    def is_opening(self) -> bool:
        return str(self._get_state_value("moving", "")).upper() == "OPENING"

    @property
    def is_closing(self) -> bool:
        return str(self._get_state_value("moving", "")).upper() == "CLOSING"

    @property
    def current_cover_position(self) -> int | None:
        return self._get_state_value("position")

    @property
    def current_cover_tilt_position(self) -> int | None:
        return self._get_state_value("tilt_position")

    async def async_open_cover(self, **kwargs) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "OPEN"})

    async def async_close_cover(self, **kwargs) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "CLOSE"})

    async def async_stop_cover(self, **kwargs) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "STOP"})

    async def async_set_cover_position(self, **kwargs) -> None:
        await self._coordinator.async_set_state(
            self._ieee_address, {"position": kwargs[ATTR_POSITION]}
        )

    async def async_set_cover_tilt_position(self, **kwargs) -> None:
        await self._coordinator.async_set_state(
            self._ieee_address, {"tilt_position": kwargs[ATTR_TILT_POSITION]}
        )
