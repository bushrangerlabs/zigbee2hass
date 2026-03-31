"""Lock platform for Zigbee2HASS."""
from __future__ import annotations

from homeassistant.components.lock import LockEntity, LockEntityFeature
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
        for expose in platforms.get("lock", []):
            uid = f"{ieee_address}_lock"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSLock(coordinator, ieee_address, expose))

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


class Zigbee2HASSLock(Zigbee2HASSEntity, LockEntity):
    """Representation of a Zigbee lock."""

    def __init__(self, coordinator: Zigbee2HASSCoordinator, ieee_address: str, expose: dict) -> None:
        super().__init__(coordinator, ieee_address, expose)
        feature_names = {f["name"] for f in expose.get("features", [])}
        if "pin_code" in feature_names:
            self._attr_supported_features = LockEntityFeature.OPEN

    @property
    def is_locked(self) -> bool | None:
        state = self._get_state_value("state")
        if state is None:
            return None
        return str(state).upper() == "LOCK"

    @property
    def is_locking(self) -> bool:
        return str(self._get_state_value("action", "")).upper() == "LOCKING"

    @property
    def is_unlocking(self) -> bool:
        return str(self._get_state_value("action", "")).upper() == "UNLOCKING"

    @property
    def is_jammed(self) -> bool:
        return str(self._get_state_value("action", "")).upper() == "JAMMED"

    async def async_lock(self, **kwargs) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "LOCK"})

    async def async_unlock(self, **kwargs) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"state": "UNLOCK"})
