"""Climate platform for Zigbee2HASS (thermostats, heat pumps, AC)."""
from __future__ import annotations

from homeassistant.components.climate import (
    ATTR_HVAC_MODE,
    ATTR_PRESET_MODE,
    ATTR_TARGET_TEMP_HIGH,
    ATTR_TARGET_TEMP_LOW,
    ClimateEntity,
    ClimateEntityFeature,
    HVACMode,
    HVACAction,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms

# Map herdsman system_mode values → HA HVACMode
HVAC_MODE_MAP = {
    "off":         HVACMode.OFF,
    "auto":        HVACMode.AUTO,
    "cool":        HVACMode.COOL,
    "heat":        HVACMode.HEAT,
    "emergency_heating": HVACMode.HEAT,
    "fan_only":    HVACMode.FAN_ONLY,
    "dry":         HVACMode.DRY,
    "sleep":       HVACMode.AUTO,
}

HVAC_ACTION_MAP = {
    "heating":  HVACAction.HEATING,
    "cooling":  HVACAction.COOLING,
    "idle":     HVACAction.IDLE,
    "fan":      HVACAction.FAN,
    "off":      HVACAction.OFF,
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
        for expose in platforms.get("climate", []):
            uid = f"{ieee_address}_climate"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSClimate(coordinator, ieee_address, expose))

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


class Zigbee2HASSClimate(Zigbee2HASSEntity, ClimateEntity):
    """Representation of a Zigbee thermostat / climate device."""

    _attr_temperature_unit = "°C"

    def __init__(self, coordinator: Zigbee2HASSCoordinator, ieee_address: str, expose: dict) -> None:
        super().__init__(coordinator, ieee_address, expose)

        features_list = expose.get("features", [])
        feature_names = {f["name"] for f in features_list}
        supported     = ClimateEntityFeature(0)

        # Build HVAC modes from the system_mode expose values
        self._hvac_modes: list[HVACMode] = [HVACMode.OFF]
        sys_mode_feature = next((f for f in features_list if f.get("name") == "system_mode"), None)
        if sys_mode_feature:
            for val in sys_mode_feature.get("values", []):
                ha_mode = HVAC_MODE_MAP.get(val)
                if ha_mode and ha_mode not in self._hvac_modes:
                    self._hvac_modes.append(ha_mode)

        # Target temperature
        if "occupied_heating_setpoint" in feature_names or "current_heating_setpoint" in feature_names:
            supported |= ClimateEntityFeature.TARGET_TEMPERATURE
        if "occupied_cooling_setpoint" in feature_names:
            supported |= ClimateEntityFeature.TARGET_TEMPERATURE

        # Presets
        preset_feature = next((f for f in features_list if f.get("name") == "preset"), None)
        if preset_feature:
            self._attr_preset_modes = preset_feature.get("values", [])
            supported |= ClimateEntityFeature.PRESET_MODE

        # Temperature range
        temp_feature = next((f for f in features_list if "setpoint" in f.get("name", "")), None)
        if temp_feature:
            self._attr_min_temp = temp_feature.get("value_min", 5)
            self._attr_max_temp = temp_feature.get("value_max", 35)
            self._attr_target_temperature_step = temp_feature.get("value_step", 0.5)

        self._attr_supported_features = supported
        self._attr_hvac_modes         = self._hvac_modes

    @property
    def hvac_mode(self) -> HVACMode | None:
        raw = self._get_state_value("system_mode", "off")
        return HVAC_MODE_MAP.get(str(raw).lower(), HVACMode.OFF)

    @property
    def hvac_action(self) -> HVACAction | None:
        raw = self._get_state_value("running_state") or self._get_state_value("action")
        if raw:
            return HVAC_ACTION_MAP.get(str(raw).lower())
        return None

    @property
    def current_temperature(self) -> float | None:
        return self._get_state_value("local_temperature")

    @property
    def target_temperature(self) -> float | None:
        return (
            self._get_state_value("occupied_heating_setpoint")
            or self._get_state_value("current_heating_setpoint")
            or self._get_state_value("occupied_cooling_setpoint")
        )

    @property
    def preset_mode(self) -> str | None:
        return self._get_state_value("preset")

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        # Reverse map HA → herdsman
        reverse = {v: k for k, v in HVAC_MODE_MAP.items()}
        raw = reverse.get(hvac_mode, "off")
        await self._coordinator.async_set_state(self._ieee_address, {"system_mode": raw})

    async def async_set_temperature(self, **kwargs) -> None:
        payload = {}
        if ATTR_TEMPERATURE in kwargs:
            payload["occupied_heating_setpoint"] = kwargs[ATTR_TEMPERATURE]
            payload["current_heating_setpoint"]  = kwargs[ATTR_TEMPERATURE]
        await self._coordinator.async_set_state(self._ieee_address, payload)

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        await self._coordinator.async_set_state(self._ieee_address, {"preset": preset_mode})
