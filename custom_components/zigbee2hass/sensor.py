"""Sensor platform for Zigbee2HASS."""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    LIGHT_LUX,
    PERCENTAGE,
    UnitOfEnergy,
    UnitOfPower,
    UnitOfPressure,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator
from .entity import Zigbee2HASSEntity
from .entity_factory import exposes_to_platforms

# Map herdsman unit strings → HA units + device class
UNIT_MAP: dict[str, tuple[str | None, str | None, str | None]] = {
    # (HA unit, device_class, state_class)
    "°C":   (UnitOfTemperature.CELSIUS,    SensorDeviceClass.TEMPERATURE,  SensorStateClass.MEASUREMENT),
    "°F":   (UnitOfTemperature.FAHRENHEIT,  SensorDeviceClass.TEMPERATURE,  SensorStateClass.MEASUREMENT),
    "%":    (PERCENTAGE,                    None,                           SensorStateClass.MEASUREMENT),
    "hPa":  (UnitOfPressure.HPA,           SensorDeviceClass.PRESSURE,     SensorStateClass.MEASUREMENT),
    "lux":  (LIGHT_LUX,                    SensorDeviceClass.ILLUMINANCE,  SensorStateClass.MEASUREMENT),
    "W":    (UnitOfPower.WATT,             SensorDeviceClass.POWER,        SensorStateClass.MEASUREMENT),
    "kWh":  (UnitOfEnergy.KILO_WATT_HOUR,  SensorDeviceClass.ENERGY,       SensorStateClass.TOTAL_INCREASING),
    "V":    ("V",                           SensorDeviceClass.VOLTAGE,      SensorStateClass.MEASUREMENT),
    "A":    ("A",                           SensorDeviceClass.CURRENT,      SensorStateClass.MEASUREMENT),
    "ppm":  ("ppm",                         SensorDeviceClass.CO2,          SensorStateClass.MEASUREMENT),
}

# Battery sensor special case
BATTERY_NAMES = {"battery", "battery_low"}


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
        for expose in platforms.get("sensor", []):
            uid = f"{ieee_address}_sensor_{expose.get('name', expose.get('property', 'unknown'))}"
            if uid not in added:
                added.add(uid)
                entities.append(Zigbee2HASSensor(coordinator, ieee_address, expose))

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


class Zigbee2HASSensor(Zigbee2HASSEntity, SensorEntity):
    """Representation of a Zigbee sensor."""

    def __init__(self, coordinator, ieee_address, expose) -> None:
        super().__init__(coordinator, ieee_address, expose)
        unit = expose.get("unit")
        name = expose.get("name", "")

        if unit and unit in UNIT_MAP:
            ha_unit, device_class, state_class = UNIT_MAP[unit]
            self._attr_native_unit_of_measurement = ha_unit
            self._attr_device_class                = device_class
            self._attr_state_class                 = state_class
        elif name in BATTERY_NAMES or "battery" in name:
            self._attr_native_unit_of_measurement = PERCENTAGE
            self._attr_device_class               = SensorDeviceClass.BATTERY
            self._attr_state_class                = SensorStateClass.MEASUREMENT

        self._property = expose.get("property", expose.get("name"))

    @property
    def native_value(self):
        return self._get_state_value(self._property)
